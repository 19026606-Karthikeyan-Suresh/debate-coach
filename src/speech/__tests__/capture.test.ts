/**
 * Sample conversion and resampling.
 *
 * The resampler is the part worth testing hard, and the property that matters is not accuracy —
 * linear interpolation is admittedly rough — but that it does not **drift**. Chunked resampling
 * that rounds each chunk's length independently loses a fraction of a sample every call, and
 * over a seven-minute speech that is seconds of accumulated error, which lands as a transcript
 * whose timestamps no longer point at the audio they came from.
 */

import { describe, expect, it } from 'vitest'

import { floatToPcm16, LinearResampler, TARGET_SAMPLE_RATE } from '../capture.ts'

/** A sine wave, the closest thing to speech that can be asserted about exactly. */
function tone(sampleCount: number, sampleRate: number, hertz: number): Float32Array {
  return Float32Array.from({ length: sampleCount }, (_unused, index) =>
    Math.sin((2 * Math.PI * hertz * index) / sampleRate),
  )
}

describe('float to 16-bit', () => {
  it('maps the ends of the range without wrapping', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1]))
    expect(pcm[0]).toBe(0)
    expect(pcm[1]).toBe(32767)
    expect(pcm[2]).toBe(-32768)
  })

  it('clamps rather than wraps a clipped sample', () => {
    // The bug this guards: scaling by 32768 and letting it overflow turns the loudest moment of
    // a speech into the quietest, which whisper hears as a click.
    const pcm = floatToPcm16(Float32Array.from([1.5, -1.5, 2.0]))
    expect(pcm[0]).toBe(32767)
    expect(pcm[1]).toBe(-32768)
    expect(pcm[2]).toBe(32767)
  })

  it('produces one entry per sample', () => {
    expect(floatToPcm16(new Float32Array(0))).toHaveLength(0)
    expect(floatToPcm16(new Float32Array(128))).toHaveLength(128)
  })
})

describe('resampling', () => {
  it('passes audio straight through when the rates already match', () => {
    const input = tone(256, TARGET_SAMPLE_RATE, 440)
    const output = new LinearResampler(TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE).push(input)
    expect(output).toBe(input)
  })

  it('rejects a rate that would divide by zero', () => {
    expect(() => new LinearResampler(0, TARGET_SAMPLE_RATE)).toThrow()
    expect(() => new LinearResampler(48_000, 0)).toThrow()
  })

  it('does not drift over a speech-length run of small chunks', () => {
    // 48 kHz is what a laptop gives when it declines to open at 16. Seven minutes of it, fed a
    // worklet frame at a time, must come out within one sample of exactly a third the length.
    const resampler = new LinearResampler(48_000, TARGET_SAMPLE_RATE)
    const frameSamples = 2048
    const frames = Math.floor((48_000 * 7 * 60) / frameSamples)

    let produced = 0
    for (let frame = 0; frame < frames; frame += 1) {
      produced += resampler.push(new Float32Array(frameSamples)).length
    }

    const expected = (frames * frameSamples) / 3
    expect(Math.abs(produced - expected)).toBeLessThanOrEqual(1)
  })

  it('reaches the same length whatever the chunk size', () => {
    const total = 48_000
    const lengths = [1024, 2048, 4096, 7_999].map((chunk) => {
      const resampler = new LinearResampler(48_000, TARGET_SAMPLE_RATE)
      let produced = 0
      for (let offset = 0; offset < total; offset += chunk) {
        produced += resampler.push(new Float32Array(Math.min(chunk, total - offset))).length
      }
      return produced
    })
    // All within one sample of each other, and of the 16 000 a third of a second's worth is.
    for (const length of lengths) {
      expect(Math.abs(length - 16_000)).toBeLessThanOrEqual(1)
    }
  })

  it('keeps the waveform rather than just the sample count', () => {
    // A 100 Hz tone downsampled 3:1 is still a 100 Hz tone, well under the new Nyquist limit.
    // Comparing against the tone computed directly at 16 kHz is what catches an off-by-one in
    // the read position, which a length assertion alone cannot see.
    const resampler = new LinearResampler(48_000, TARGET_SAMPLE_RATE)
    const output = resampler.push(tone(48_000, 48_000, 100))
    const reference = tone(output.length, TARGET_SAMPLE_RATE, 100)

    let worst = 0
    // The first output sample interpolates from nothing, so comparison starts past it.
    for (let index = 1; index < output.length; index += 1) {
      worst = Math.max(worst, Math.abs((output[index] ?? 0) - (reference[index] ?? 0)))
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('carries the tail rather than dropping it', () => {
    const resampler = new LinearResampler(48_000, TARGET_SAMPLE_RATE)
    // Two samples cannot make a whole output sample at a 3:1 ratio; they must not vanish.
    resampler.push(Float32Array.from([1, 1]))
    const second = resampler.push(Float32Array.from([1, 1, 1, 1]))
    expect(second.length).toBeGreaterThan(0)
  })

  it('does nothing with an empty chunk', () => {
    expect(new LinearResampler(48_000, TARGET_SAMPLE_RATE).push(new Float32Array(0))).toHaveLength(0)
  })
})
