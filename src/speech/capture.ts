/**
 * The microphone, reduced to the only format whisper.cpp accepts.
 *
 * 16 kHz, mono, signed 16-bit little-endian. whisper.cpp resamples nothing and validates
 * nothing — hand it 48 kHz and it transcribes confident nonsense — so every conversion has to
 * happen here, on the browser side, before the bytes cross into Rust.
 *
 * **Capture runs on an audio worklet, not a `ScriptProcessorNode`.** The deprecation is beside
 * the point; what matters is the thread. A script processor's callback runs on the main thread,
 * so a React render during a speech drops audio, and dropped audio is a run of words the aligner
 * reports as skipped when in fact they were said. That is precisely the false positive the whole
 * feature cannot afford.
 *
 * Two buffering stages, for two different reasons. The worklet gathers the 128-sample render
 * quanta into something worth posting across a thread boundary, and the main thread gathers
 * those into something worth an IPC call — a quarter of a second, 8 KB, rather than 125 messages
 * a second for seven minutes.
 */

/** The only rate whisper.cpp accepts. Must match `SAMPLE_RATE` in `src-tauri/src/audio.rs`. */
export const TARGET_SAMPLE_RATE = 16_000

/** Samples the worklet gathers before posting. 2048 at 16 kHz is 128 ms. */
const WORKLET_FRAME_SAMPLES = 2048

/** Samples buffered on the main thread before an IPC push. 4096 at 16 kHz is 256 ms. */
const DEFAULT_CHUNK_SAMPLES = 4096

/**
 * The worklet, as source.
 *
 * Inlined and loaded from a blob rather than shipped as a file because `addModule` takes a URL,
 * and a URL means a second entry point Vite has to be told not to bundle, plus a path that
 * resolves differently under the dev server and the packaged app. The processor is nine lines;
 * a build-configuration problem is not worth trading for them.
 */
const WORKLET_SOURCE = `
class PcmForwarder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pending = new Float32Array(${String(WORKLET_FRAME_SAMPLES)})
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) {
      // No input connected yet. Returning false here would end the node permanently.
      return true
    }
    for (let index = 0; index < channel.length; index += 1) {
      this.pending[this.filled] = channel[index]
      this.filled += 1
      if (this.filled === this.pending.length) {
        this.port.postMessage(this.pending.slice(0))
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-forwarder', PcmForwarder)
`

/**
 * Converts float samples to signed 16-bit.
 *
 * @param samples - Audio in the Web Audio range, nominally -1 to 1. Values outside it are
 *   clamped rather than wrapped: a clipped sample is a loud sample, and letting it wrap turns
 *   the loudest moment of a speech into the noisiest.
 * @returns One `Int16Array` entry per input sample.
 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    // Asymmetric on purpose: the signed 16-bit range is -32768 to 32767, so scaling positives by
    // 32768 would wrap the loudest positive sample to the quietest negative one.
    pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return pcm
}

/**
 * A streaming linear resampler.
 *
 * A per-chunk resampler is the obvious thing to write and it drifts: rounding each chunk's output
 * length independently loses a fraction of a sample every time, which over seven minutes is
 * seconds of accumulated error and a transcript whose timestamps no longer mean anything. This
 * keeps a fractional read position across calls instead, so the only state that survives a chunk
 * boundary is exactly the state that has to.
 *
 * Linear rather than windowed-sinc: the input is already band-limited by the capture device, the
 * output is fed to a model trained on far worse audio than this, and a proper filter is a
 * hundred lines nobody here can evaluate against a transcript that went wrong.
 */
export class LinearResampler {
  /** Samples not yet consumed, carried from the previous call. */
  private carry = new Float32Array(0)

  /** Fractional read position within `carry`, always less than one sample past its start. */
  private position = 0

  /** Input samples consumed per output sample. */
  private readonly step: number

  /**
   * @param fromRate - The capture device's rate. Equal to `toRate` makes every `push` a
   *   pass-through with no copy.
   * @param toRate - The wanted rate. Zero or negative would divide by zero and is rejected.
   * @throws If either rate is not positive.
   */
  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {
    if (fromRate <= 0 || toRate <= 0) {
      throw new Error(`Sample rates must be positive, got ${String(fromRate)}→${String(toRate)}`)
    }
    this.step = fromRate / toRate
  }

  /**
   * Resamples one chunk.
   *
   * @param input - Samples at `fromRate`. An empty chunk returns an empty result and leaves the
   *   carried state alone.
   * @returns Samples at `toRate`. Shorter or longer than the input by roughly the rate ratio,
   *   and occasionally off by one from that — the remainder is carried, not dropped.
   */
  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) {
      return input
    }
    if (input.length === 0) {
      return new Float32Array(0)
    }

    const buffer = new Float32Array(this.carry.length + input.length)
    buffer.set(this.carry)
    buffer.set(input, this.carry.length)

    // Emit every read position that lands on or before the last sample held. Interpolating
    // strictly inside the buffer needs the sample after the read position too, and this bound
    // guarantees it: a position exactly on the last sample has a zero fraction and never reads
    // past it. Counting output samples any other way is where a chunked resampler drifts.
    const reachable = buffer.length - 1 - this.position
    const outputCount = reachable >= 0 ? Math.floor(reachable / this.step) + 1 : 0
    const output = new Float32Array(outputCount)

    let readAt = this.position
    for (let index = 0; index < outputCount; index += 1) {
      const whole = Math.floor(readAt)
      const fraction = readAt - whole
      const left = buffer[whole] ?? 0
      const right = buffer[whole + 1] ?? left
      output[index] = left * (1 - fraction) + right * fraction
      readAt += this.step
    }

    // The next read position can legitimately sit past everything held — at a 3:1 ratio a
    // two-sample chunk is consumed whole and the next read is a sample into audio that has not
    // arrived. Clamping what is dropped and keeping the remainder in `position` is what carries
    // that skip across the boundary instead of quietly swallowing input.
    const consumed = Math.min(Math.floor(readAt), buffer.length)
    this.carry = buffer.slice(consumed)
    this.position = readAt - consumed
    return output
  }
}

/** How {@link MicrophoneCapture} is set up. */
export interface MicrophoneCaptureOptions {
  /**
   * Called with each buffered chunk of 16 kHz PCM. Throwing from it stops nothing — the audio
   * graph keeps running and the next chunk still arrives — so a caller that wants capture to
   * end must call `stop`.
   */
  readonly onChunk: (pcm: Int16Array) => void
  /** Samples per chunk at 16 kHz. Smaller means lower latency and more IPC calls. */
  readonly chunkSamples?: number
}

/**
 * Captures the microphone as 16 kHz mono PCM.
 *
 * One instance is one recording. `start` twice without a `stop` between them throws rather than
 * quietly opening a second microphone into the same callback.
 */
export class MicrophoneCapture {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private workletUrl: string | null = null

  /** Samples at 16 kHz waiting to fill a chunk. */
  private pending: number[] = []

  /** Set once the device's real rate is known; null when it already matches. */
  private resampler: LinearResampler | null = null

  private readonly chunkSamples: number

  /**
   * @param options - See {@link MicrophoneCaptureOptions}. `onChunk` is held for the lifetime of
   *   the capture, so a closure over stale React state will stay stale — pass one that reads
   *   through a ref or dispatches to a reducer.
   */
  constructor(private readonly options: MicrophoneCaptureOptions) {
    this.chunkSamples = options.chunkSamples ?? DEFAULT_CHUNK_SAMPLES
  }

  /**
   * Opens the microphone and starts delivering chunks.
   *
   * @returns The rate the device was actually opened at. Equal to {@link TARGET_SAMPLE_RATE}
   *   when the browser honoured the request, higher when it did not and a resampler was
   *   inserted — worth surfacing, because the resampled path is the one to suspect first if the
   *   transcript comes back poor.
   * @throws If a capture is already running, or if the user refuses microphone access.
   */
  async start(): Promise<number> {
    if (this.context) {
      throw new Error('This capture is already running.')
    }

    // Echo cancellation is off because nothing is playing back and it costs high-frequency
    // detail; the other two are on because a tournament room is loud and a debater's distance
    // from the laptop varies by a foot as they gesture.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    // Asking for the target rate up front lets the browser resample in native code, which is
    // better than anything here. It is a request, not a guarantee.
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    this.context = context
    if (context.sampleRate !== TARGET_SAMPLE_RATE) {
      this.resampler = new LinearResampler(context.sampleRate, TARGET_SAMPLE_RATE)
    }

    this.workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    )
    await context.audioWorklet.addModule(this.workletUrl)

    const node = new AudioWorkletNode(context, 'pcm-forwarder')
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.accept(event.data)
    }
    context.createMediaStreamSource(this.stream).connect(node)
    // The worklet emits nothing downstream, but an unconnected node is not pulled by the graph
    // and never runs. A zero-gain sink is the standard way to keep it scheduled without the
    // microphone coming out of the speakers.
    const sink = context.createGain()
    sink.gain.value = 0
    node.connect(sink).connect(context.destination)
    this.node = node

    return context.sampleRate
  }

  /** Buffers one worklet frame, resampling first if the device rate did not match. */
  private accept(frame: Float32Array): void {
    const atTargetRate = this.resampler ? this.resampler.push(frame) : frame
    for (const sample of atTargetRate) {
      this.pending.push(sample)
    }

    while (this.pending.length >= this.chunkSamples) {
      const chunk = this.pending.splice(0, this.chunkSamples)
      this.options.onChunk(floatToPcm16(Float32Array.from(chunk)))
    }
  }

  /**
   * Closes the microphone and flushes whatever was buffered.
   *
   * Safe to call when nothing is running. The final partial chunk is delivered rather than
   * dropped — it is up to a quarter of a second, which at speaking pace is a word.
   */
  async stop(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
      this.node = null
    }
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop()
    }
    this.stream = null

    if (this.pending.length > 0) {
      this.options.onChunk(floatToPcm16(Float32Array.from(this.pending)))
      this.pending = []
    }

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }
    if (this.context) {
      await this.context.close()
      this.context = null
    }
    this.resampler = null
  }
}
