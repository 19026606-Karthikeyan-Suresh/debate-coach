/**
 * Container negotiation, pinned.
 *
 * The rest of `recorder.ts` needs a microphone. This does not, and it is the part that decides
 * whether a recording opens on somebody else's device — which is the failure that surfaces
 * latest and hurts most.
 */

import { describe, expect, it } from 'vitest'

import { pickRecordingFormat } from '../recorder.ts'

/** A browser that supports exactly the listed types. */
function browserSupporting(...types: readonly string[]): (mimeType: string) => boolean {
  return (mimeType) => types.includes(mimeType)
}

describe('pickRecordingFormat', () => {
  it('prefers WebM with Opus where it exists', () => {
    // Chrome, Edge, Firefox, and Safari from 18.4.
    const chosen = pickRecordingFormat(
      browserSupporting('audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'),
    )
    expect(chosen.mimeType).toBe('audio/webm;codecs=opus')
    expect(chosen.extension).toBe('webm')
  })

  it('falls back to MP4 with AAC on a Safari that has no WebM', () => {
    // Safari 14.1 to 18.3 recorded MP4/AAC only.
    const chosen = pickRecordingFormat(
      browserSupporting('audio/mp4;codecs=mp4a.40.2', 'audio/mp4'),
    )
    expect(chosen.mimeType).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(chosen.extension).toBe('m4a')
  })

  it('never picks Opus inside MP4, even when the browser offers it', () => {
    // Chromium reports this as supported. It does not play on Safari or iOS, and a recording is
    // shared with teammates — so the failure would land on a coach's iPad, not on the recorder.
    const chosen = pickRecordingFormat(
      browserSupporting('audio/mp4;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'),
    )
    expect(chosen.mimeType).not.toContain('opus')
    expect(chosen.mimeType).toBe('audio/mp4;codecs=mp4a.40.2')
  })

  it('lets the browser choose rather than refusing to record', () => {
    // No recording is strictly worse than a recording in a container we did not name.
    const chosen = pickRecordingFormat(() => false)
    expect(chosen.mimeType).toBe('')
    expect(chosen.extension).toBe('webm')
  })

  it('gives every candidate an extension that matches its container', () => {
    for (const type of ['audio/webm;codecs=opus', 'audio/webm']) {
      expect(pickRecordingFormat(browserSupporting(type)).extension).toBe('webm')
    }
    for (const type of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']) {
      expect(pickRecordingFormat(browserSupporting(type)).extension).toBe('m4a')
    }
  })
})
