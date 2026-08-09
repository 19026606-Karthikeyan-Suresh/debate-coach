//! Co-prep on a network with no internet — the fallback PLAN reserved for `y-webrtc`.
//!
//! # Why this is not y-webrtc
//!
//! WebRTC cannot introduce two peers to each other. Every WebRTC connection is negotiated over a
//! *signalling* channel that has to already exist, and `y-webrtc` supplies that by defaulting to
//! public signalling servers on the internet. In a prep room with no internet those are exactly
//! as unreachable as Supabase — so "the LAN fallback" would mean running a signalling server on
//! the LAN anyway. Once one laptop in the room is running a server, WebRTC's whole reason for
//! existing is gone, and what remains of it is ICE negotiation inside a webview plus three
//! dependencies, one of which phones a public host by default.
//!
//! What is here instead is the server that argument leaves behind: one laptop runs a **relay**,
//! the others connect to it over TCP, and every frame is forwarded to everyone else. The CRDT
//! does not care — it is the same `CollabSession` and the same messages as the Realtime path,
//! which is what "only the provider swaps" was always supposed to mean.
//!
//! # Shape
//!
//! * The relay is dumb and stateless: read a frame, write it to every other connection.
//! * **The host joins its own relay over loopback.** That is worth the extra socket: it makes the
//!   host and the guests run identical client code, so there is one send path and one receive
//!   path to get right rather than two.
//! * Discovery is a UDP broadcast on {@link DISCOVERY_PORT}. It is a convenience, not the
//!   mechanism — [`lan_connect`] takes an address directly, because conference wifi blocks
//!   broadcast often enough that "type the host's address" has to keep working.
//!
//! No new crates: `std::net` and threads. The same reasoning that kept cmake out of the build.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// Event channel frames arrive on. One payload per frame, already JSON text.
pub const LAN_EVENT: &str = "collab://lan";

/// Event channel the relay reports its connection count on.
pub const LAN_STATUS_EVENT: &str = "collab://lan-status";

/// UDP port a host answers discovery broadcasts on.
///
/// Fixed rather than negotiated, because discovery is the thing that has to work before anything
/// has been negotiated. One host per machine follows from it, which is the right trade: two
/// installs on one laptop is a developer, and a developer can pass an address to [`lan_connect`].
pub const DISCOVERY_PORT: u16 = 47_654;

/// Marker every discovery datagram starts with, so an unrelated broadcast is ignored cheaply.
const DISCOVERY_MAGIC: &str = "DBCOPREP1";

/// Largest frame the relay will forward.
///
/// A whole case as a Yjs update is tens of kilobytes; a megabyte is far past anything the
/// protocol produces and stops a malformed length prefix from asking for a gigabyte buffer.
const MAX_FRAME_BYTES: u32 = 1_048_576;

/// How long a discovery request waits for an answer before giving up.
const DISCOVERY_TIMEOUT_MS: u64 = 800;

/// What went wrong, in terms the panel can act on.
#[derive(Debug)]
pub enum LanError {
    /// No port could be bound, or the room could not be reached. Carries the cause, which on
    /// Windows is very often a declined firewall prompt rather than a missing route.
    Network(String),
    /// A send with no room open. Means the panel and the shell disagree about the state.
    NotConnected,
}

impl std::fmt::Display for LanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(message) => write!(formatter, "{message}"),
            Self::NotConnected => write!(formatter, "not in a LAN room"),
        }
    }
}

impl std::error::Error for LanError {}

impl From<LanError> for String {
    fn from(error: LanError) -> Self {
        error.to_string()
    }
}

/// The message a poisoned state lock produces. A thread panicked while holding it, and the room
/// is not recoverable without leaving and rejoining.
fn poisoned() -> LanError {
    LanError::Network("the LAN room's state is not usable; leave and rejoin".into())
}

/// A frame writer that can be shut down from another thread.
struct Peer {
    stream: TcpStream,
}

/// Connections a relay is forwarding between, keyed by an id unique only within that relay.
type PeerMap = Arc<Mutex<HashMap<u64, Peer>>>;

/// The relay, when this install is hosting.
struct Relay {
    /// Port the listener bound. Handed to guests, and to the host's own client socket.
    port: u16,
    /// Cleared to stop the accept loop and every reader thread.
    is_running: Arc<AtomicBool>,
    /// Connections to forward between, keyed by an id that only has to be unique.
    peers: PeerMap,
}

/// This install's client socket, whether it is the host's loopback one or a guest's.
struct Client {
    stream: TcpStream,
    is_running: Arc<AtomicBool>,
}

/// Everything the LAN transport owns. One room at a time, like one recording at a time.
#[derive(Default)]
pub struct LanState {
    relay: Mutex<Option<Relay>>,
    client: Mutex<Option<Client>>,
}

/// What the panel shows about the LAN transport.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct LanStatus {
    /// True when this install is running the relay for the room.
    pub is_hosting: bool,
    /// Port the relay bound, so it can be read out to somebody whose broadcast is blocked.
    pub port: Option<u16>,
    /// True when this install has a socket into a room.
    pub is_connected: bool,
    /// Connections the relay currently holds, the host's own included. Zero when not hosting.
    pub connections: usize,
}

/// Writes one length-prefixed frame.
///
/// # Errors
/// Any write failure, which the caller treats as the connection being gone.
fn write_frame(stream: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "frame too large"))?;
    stream.write_all(&length.to_be_bytes())?;
    stream.write_all(payload)?;
    stream.flush()
}

/// Reads one length-prefixed frame.
///
/// # Errors
/// End of stream, a read failure, or a length prefix past [`MAX_FRAME_BYTES`] — which means the
/// stream is out of sync and cannot be recovered by reading further.
fn read_frame(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    stream.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header);
    if length > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0_u8; length as usize];
    stream.read_exact(&mut payload)?;
    Ok(payload)
}

/// Forwards one frame to every connection except the one it came from.
///
/// A connection that will not take it is dropped: the alternative is a relay that blocks the
/// whole room on one laptop whose lid just closed.
fn fan_out(peers: &PeerMap, from: u64, payload: &[u8]) {
    let mut locked = match peers.lock() {
        Ok(locked) => locked,
        Err(blocked) => blocked.into_inner(),
    };
    let mut dead = Vec::new();
    for (id, peer) in locked.iter_mut() {
        if *id == from {
            continue;
        }
        if write_frame(&mut peer.stream, payload).is_err() {
            dead.push(*id);
        }
    }
    for id in dead {
        locked.remove(&id);
    }
}

/// Answers discovery broadcasts for one room until the relay stops.
///
/// Failing to bind is not fatal and is not reported: another install on this machine already
/// holds the port, or the OS refused it, and in both cases the room still works for anyone given
/// the address directly.
fn spawn_responder(room_id: String, port: u16, is_running: Arc<AtomicBool>) {
    thread::spawn(move || {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)) else {
            return;
        };
        // A read timeout is what lets the loop notice `is_running` going false; without it the
        // thread parks in `recv_from` until something arrives, which may be never.
        if socket
            .set_read_timeout(Some(Duration::from_millis(250)))
            .is_err()
        {
            return;
        }
        let wanted = format!("{DISCOVERY_MAGIC} LOOKING {room_id}");
        let answer = format!("{DISCOVERY_MAGIC} HOSTING {room_id} {port}");
        let mut buffer = [0_u8; 512];
        while is_running.load(Ordering::Relaxed) {
            let Ok((size, from)) = socket.recv_from(&mut buffer) else {
                continue;
            };
            if String::from_utf8_lossy(&buffer[..size]).trim() == wanted {
                let _ = socket.send_to(answer.as_bytes(), from);
            }
        }
    });
}

/// Accepts connections and reads from each one, forwarding every frame to the rest of the room.
fn spawn_relay_threads(listener: TcpListener, peers: PeerMap, is_running: Arc<AtomicBool>) {
    thread::spawn(move || {
        // Only has to be unique within one relay, so a counter is enough.
        let next_id = AtomicU64::new(0);
        for incoming in listener.incoming() {
            if !is_running.load(Ordering::Relaxed) {
                return;
            }
            let Ok(stream) = incoming else { continue };
            let Ok(reader) = stream.try_clone() else { continue };
            let id = next_id.fetch_add(1, Ordering::Relaxed);

            match peers.lock() {
                Ok(mut locked) => {
                    locked.insert(id, Peer { stream });
                }
                Err(poisoned) => {
                    poisoned.into_inner().insert(id, Peer { stream });
                }
            }

            let peers_for_reader = Arc::clone(&peers);
            let running_for_reader = Arc::clone(&is_running);
            thread::spawn(move || {
                let mut reader = reader;
                while running_for_reader.load(Ordering::Relaxed) {
                    match read_frame(&mut reader) {
                        Ok(payload) => fan_out(&peers_for_reader, id, &payload),
                        Err(_) => break,
                    }
                }
                if let Ok(mut locked) = peers_for_reader.lock() {
                    locked.remove(&id);
                }
            });
        }
    });
}

/// Reads this install's own socket and emits every frame to the webview.
fn spawn_client_reader<TRuntime: Runtime>(
    app: AppHandle<TRuntime>,
    mut reader: TcpStream,
    is_running: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        while is_running.load(Ordering::Relaxed) {
            match read_frame(&mut reader) {
                Ok(payload) => {
                    // Emitted as text. The frontend parses it with the same parser the Realtime
                    // path uses, so a malformed frame is one code path's problem, not two.
                    let text = String::from_utf8_lossy(&payload).into_owned();
                    let _ = app.emit(LAN_EVENT, text);
                }
                Err(_) => break,
            }
        }
        if is_running.load(Ordering::Relaxed) {
            // The wire went, rather than us closing it. The panel needs to know, because a room
            // that silently stopped delivering looks exactly like a room where nobody is typing.
            let _ = app.emit(LAN_STATUS_EVENT, false);
        }
    });
}

/// Starts the relay for a room on this machine.
///
/// * `room_id` — the host's case id. Only used to answer discovery: two squads in one room on one
///   network each find their own host rather than the nearer one.
///
/// # Errors
/// [`LanError::Network`] when no port can be bound. Windows will raise a firewall prompt the
/// first time this runs, and declining it is indistinguishable here from a network with no
/// route — both surface as guests being unable to connect rather than as a failure to bind.
#[tauri::command]
pub fn lan_host(state: tauri::State<'_, LanState>, room_id: String) -> Result<u16, String> {
    let mut slot = state.relay.lock().map_err(|_| poisoned())?;
    if let Some(existing) = slot.as_ref() {
        return Ok(existing.port);
    }

    // Port 0 asks the OS for a free one. A fixed port would collide with whatever else is on the
    // machine and would have to be configurable, and discovery already carries the answer.
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| LanError::Network(format!("could not open a port: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| LanError::Network(format!("could not read the port: {error}")))?
        .port();

    let is_running = Arc::new(AtomicBool::new(true));
    let peers: PeerMap = Arc::new(Mutex::new(HashMap::new()));
    spawn_relay_threads(listener, Arc::clone(&peers), Arc::clone(&is_running));
    spawn_responder(room_id, port, Arc::clone(&is_running));

    *slot = Some(Relay { port, is_running, peers });
    Ok(port)
}

/// Looks for a host on this network.
///
/// * `room_id` — the room to ask for. A host running a different room does not answer.
///
/// # Errors
/// [`LanError::Network`] when no UDP socket can be opened at all. A network where nobody answers
/// is `Ok(None)` rather than an error — it is the ordinary result of being first into the room.
#[tauri::command]
pub fn lan_discover(room_id: String) -> Result<Option<String>, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| LanError::Network(format!("could not open a socket: {error}")))?;
    socket
        .set_broadcast(true)
        .map_err(|error| LanError::Network(format!("could not broadcast: {error}")))?;
    socket
        .set_read_timeout(Some(Duration::from_millis(DISCOVERY_TIMEOUT_MS)))
        .map_err(|error| LanError::Network(format!("could not set a timeout: {error}")))?;

    let question = format!("{DISCOVERY_MAGIC} LOOKING {room_id}");
    let _ = socket.send_to(
        question.as_bytes(),
        SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT),
    );

    let prefix = format!("{DISCOVERY_MAGIC} HOSTING {room_id} ");
    let mut buffer = [0_u8; 512];
    // One read, not a loop: the timeout is the whole budget, and a second answer would mean two
    // hosts for one room, which the first answer has already resolved.
    let Ok((size, from)) = socket.recv_from(&mut buffer) else {
        return Ok(None);
    };
    let reply = String::from_utf8_lossy(&buffer[..size]).trim().to_owned();
    let Some(port) = reply.strip_prefix(&prefix) else {
        return Ok(None);
    };
    port.parse::<u16>()
        .map(|port| Some(format!("{}:{port}", from.ip())))
        .or(Ok(None))
}

/// Joins a room at a known address.
///
/// * `address` — `host:port`. A host passes its own `127.0.0.1:<port>`: joining its own relay is
///   what makes the host and the guests run the same code.
///
/// # Errors
/// [`LanError::Network`] when the address will not parse or nothing is listening on it.
#[tauri::command]
pub fn lan_connect<TRuntime: Runtime>(
    app: AppHandle<TRuntime>,
    state: tauri::State<'_, LanState>,
    address: String,
) -> Result<(), String> {
    let mut slot = state.client.lock().map_err(|_| poisoned())?;
    if let Some(existing) = slot.take() {
        existing.is_running.store(false, Ordering::Relaxed);
        let _ = existing.stream.shutdown(std::net::Shutdown::Both);
    }

    let target: SocketAddr = address
        .parse()
        .map_err(|_| LanError::Network(format!("{address} is not a host:port address")))?;
    let stream = TcpStream::connect_timeout(&target, Duration::from_millis(2_000))
        .map_err(|error| LanError::Network(format!("could not reach {address}: {error}")))?;
    // Nagle would hold a keystroke back waiting for company. The batching in `session.ts` has
    // already decided what one message is.
    let _ = stream.set_nodelay(true);

    let reader = stream
        .try_clone()
        .map_err(|error| LanError::Network(format!("could not read the connection: {error}")))?;
    let is_running = Arc::new(AtomicBool::new(true));
    spawn_client_reader(app, reader, Arc::clone(&is_running));

    *slot = Some(Client { stream, is_running });
    Ok(())
}

/// Puts one frame on the wire.
///
/// * `message` — the JSON text of a `CollabMessage`. Nothing here parses it; the relay forwards
///   bytes and the frontend owns the protocol, exactly as the Realtime path does.
///
/// # Errors
/// [`LanError::NotConnected`] when no room is open, or [`LanError::Network`] when the write
/// fails — which is the connection having gone, and the panel should say so rather than retry.
#[tauri::command]
pub fn lan_send(state: tauri::State<'_, LanState>, message: String) -> Result<(), String> {
    let mut slot = state.client.lock().map_err(|_| poisoned())?;
    let client = slot.as_mut().ok_or(LanError::NotConnected)?;
    write_frame(&mut client.stream, message.as_bytes())
        .map_err(|error| LanError::Network(format!("the connection dropped: {error}")))?;
    Ok(())
}

/// Leaves the room, and stops the relay if this install was hosting it.
///
/// # Errors
/// Only if the state lock is poisoned, which means a thread panicked while holding it.
#[tauri::command]
pub fn lan_leave(state: tauri::State<'_, LanState>) -> Result<(), String> {
    if let Ok(mut slot) = state.client.lock() {
        if let Some(client) = slot.take() {
            client.is_running.store(false, Ordering::Relaxed);
            let _ = client.stream.shutdown(std::net::Shutdown::Both);
        }
    }

    let mut slot = state.relay.lock().map_err(|_| poisoned())?;
    if let Some(relay) = slot.take() {
        relay.is_running.store(false, Ordering::Relaxed);
        if let Ok(mut peers) = relay.peers.lock() {
            for (_, peer) in peers.drain() {
                let _ = peer.stream.shutdown(std::net::Shutdown::Both);
            }
        }
        // `TcpListener` has no close, and the accept loop is parked inside it. Connecting to it
        // wakes it up, and it returns as soon as it sees the flag.
        let _ = TcpStream::connect_timeout(
            &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), relay.port),
            Duration::from_millis(250),
        );
    }
    Ok(())
}

/// Reports what the LAN transport is doing.
///
/// # Errors
/// Never in practice; a poisoned lock is reported as "nothing is running", which is the safe
/// thing for the panel to believe.
#[tauri::command]
pub fn lan_status(state: tauri::State<'_, LanState>) -> LanStatus {
    let (is_hosting, port, connections) = match state.relay.lock() {
        Ok(slot) => match slot.as_ref() {
            Some(relay) => (
                true,
                Some(relay.port),
                relay.peers.lock().map(|peers| peers.len()).unwrap_or(0),
            ),
            None => (false, None, 0),
        },
        Err(_) => (false, None, 0),
    };
    let is_connected = state
        .client
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);

    LanStatus {
        is_hosting,
        port,
        is_connected,
        connections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Connects a bare client to a relay and returns the stream.
    fn dial(port: u16) -> TcpStream {
        let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let stream = TcpStream::connect_timeout(&target, Duration::from_millis(2_000))
            .expect("relay should accept a connection");
        stream
            .set_read_timeout(Some(Duration::from_millis(2_000)))
            .expect("a read timeout should be settable");
        stream
    }

    /// A relay started directly, without the Tauri state wrapper.
    struct TestRelay {
        port: u16,
        is_running: Arc<AtomicBool>,
        peers: PeerMap,
    }

    /// Starts a relay on loopback and returns the handles a test needs.
    fn start_relay() -> TestRelay {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a port should bind");
        let port = listener.local_addr().expect("a bound port has an address").port();
        let is_running = Arc::new(AtomicBool::new(true));
        let peers: PeerMap = Arc::new(Mutex::new(HashMap::new()));
        spawn_relay_threads(listener, Arc::clone(&peers), Arc::clone(&is_running));
        TestRelay { port, is_running, peers }
    }

    #[test]
    fn a_frame_round_trips_through_the_length_prefix() {
        let relay = start_relay();
        let port = relay.port;
        let mut sender = dial(port);
        let mut receiver = dial(port);
        // Both connections have to be registered before the frame goes out, and registration
        // happens on the relay's accept thread.
        thread::sleep(Duration::from_millis(100));

        let payload = br#"{"kind":"presence","from":"a","displayName":"Priya"}"#;
        write_frame(&mut sender, payload).expect("the write should land");

        let received = read_frame(&mut receiver).expect("the relay should forward the frame");
        assert_eq!(received, payload);
        relay.is_running.store(false, Ordering::Relaxed);
    }

    #[test]
    fn the_sender_does_not_receive_its_own_frame() {
        // This is what stops the room echoing. The session drops its own messages as well, by
        // sender id, but a relay that fanned a frame back at its author would double every
        // update on the LAN path and on no other.
        let relay = start_relay();
        let port = relay.port;
        let mut sender = dial(port);
        let mut other = dial(port);
        thread::sleep(Duration::from_millis(100));

        write_frame(&mut sender, b"one").expect("the write should land");
        assert_eq!(read_frame(&mut other).expect("forwarded"), b"one");

        sender
            .set_read_timeout(Some(Duration::from_millis(300)))
            .expect("a read timeout should be settable");
        assert!(read_frame(&mut sender).is_err(), "the sender must hear nothing back");
        relay.is_running.store(false, Ordering::Relaxed);
    }

    #[test]
    fn every_other_peer_gets_the_frame() {
        let relay = start_relay();
        let port = relay.port;
        let mut sender = dial(port);
        let mut first = dial(port);
        let mut second = dial(port);
        let mut third = dial(port);
        thread::sleep(Duration::from_millis(150));

        write_frame(&mut sender, b"to the room").expect("the write should land");
        for receiver in [&mut first, &mut second, &mut third] {
            assert_eq!(read_frame(receiver).expect("forwarded"), b"to the room");
        }
        relay.is_running.store(false, Ordering::Relaxed);
    }

    #[test]
    fn a_dropped_peer_does_not_stop_the_room() {
        let relay = start_relay();
        let port = relay.port;
        let mut sender = dial(port);
        let leaving = dial(port);
        let mut staying = dial(port);
        thread::sleep(Duration::from_millis(150));

        drop(leaving);
        thread::sleep(Duration::from_millis(100));

        write_frame(&mut sender, b"still here").expect("the write should land");
        assert_eq!(read_frame(&mut staying).expect("forwarded"), b"still here");

        // And the relay stops holding the closed socket, rather than writing into it forever.
        thread::sleep(Duration::from_millis(100));
        let count = relay.peers.lock().expect("not poisoned").len();
        assert!(count <= 2, "expected the dropped peer to be forgotten, saw {count}");
        relay.is_running.store(false, Ordering::Relaxed);
    }

    #[test]
    fn a_length_prefix_past_the_cap_is_refused() {
        // A malformed prefix must not turn into a gigabyte allocation on a laptop mid-round.
        let relay = start_relay();
        let port = relay.port;
        let mut sender = dial(port);
        let mut receiver = dial(port);
        thread::sleep(Duration::from_millis(100));

        sender
            .write_all(&(MAX_FRAME_BYTES + 1).to_be_bytes())
            .expect("the header should write");
        sender.flush().expect("the header should flush");

        receiver
            .set_read_timeout(Some(Duration::from_millis(300)))
            .expect("a read timeout should be settable");
        assert!(read_frame(&mut receiver).is_err(), "nothing should be forwarded");
        relay.is_running.store(false, Ordering::Relaxed);
    }

    #[test]
    fn discovery_finds_a_host_and_ignores_another_room() {
        // The responder is deliberately silent about failing to bind, so the test has to
        // establish for itself that the port is free — otherwise "nobody answered" passes as
        // "the protocol works". A machine already running the app skips rather than lies.
        match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)) {
            Ok(probe) => drop(probe),
            Err(_) => return,
        }

        let is_running = Arc::new(AtomicBool::new(true));
        spawn_responder("room-alpha".into(), 5_555, Arc::clone(&is_running));
        thread::sleep(Duration::from_millis(200));

        let found = lan_discover("room-alpha".into())
            .expect("the socket should open")
            .expect("the host should answer its own room");
        assert!(found.ends_with(":5555"), "expected the host's port, got {found}");

        // Two squads on one network each find their own host rather than the nearer one.
        assert_eq!(
            lan_discover("room-beta".into()).expect("the socket should open"),
            None,
            "a host for another room must not answer"
        );
        is_running.store(false, Ordering::Relaxed);
    }
}
