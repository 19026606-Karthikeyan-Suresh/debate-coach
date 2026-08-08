/**
 * The join rules, tested on the shapes real input actually takes.
 *
 * Every case below came out of compiling the reference case rather than out of imagination: the
 * template punctuates its prose, the debater punctuates their answers, and the interesting bugs
 * all live at the seam between the two.
 */

import { describe, expect, it } from 'vitest'

import type { CaseField } from '../../case/sections.ts'
import {
  assembleText,
  fixed,
  ordinalWord,
  proseChunk,
  renderLine,
  slot,
  tokenizeAssembled,
  type LineContext,
  type ScriptChunk,
} from '../lines.ts'

/** Builds a chunk that came from a field, for the provenance checks. */
function fieldChunk(text: string, fieldPath = 'substantives.sub-1.whyBad'): ScriptChunk {
  return { text, fieldPath }
}

/** Wraps loose chunks as a single line. */
function oneLine(...chunks: ScriptChunk[]): readonly (readonly ScriptChunk[])[] {
  return [chunks]
}

describe('assembleText joins prose and answers', () => {
  it('separates a lead-in from the answer with one space', () => {
    const { text } = assembleText(
      oneLine(proseChunk('Why does that matter?'), fieldChunk('It uproots a life.')),
    )
    expect(text).toBe('Why does that matter? It uproots a life.')
  })

  it('drops the answer’s full stop where the template is still mid-sentence', () => {
    // "This is bad because ___ is something that happens all the time" — the blank sits inside
    // the sentence, so a debater who ended their answer put a stop in the middle of it.
    const { text } = assembleText(
      oneLine(
        proseChunk('This is bad because'),
        fieldChunk('nobody is ever held to account.'),
        proseChunk('is something that happens all the time'),
      ),
    )
    expect(text).toBe(
      'This is bad because nobody is ever held to account is something that happens all the time',
    )
  })

  it('drops the answer’s full stop before a clause the template opens with a comma', () => {
    const { text } = assembleText(
      oneLine(fieldChunk('the harm is irrecoverable.'), proseChunk(', their argument fails.')),
    )
    expect(text).toBe('the harm is irrecoverable, their argument fails.')
  })

  it('keeps the template’s sentence break when both sides terminate', () => {
    const { text } = assembleText(
      oneLine(fieldChunk('they cause real damage.'), proseChunk('. But my')),
    )
    expect(text).toBe('they cause real damage. But my')
  })

  it('supplies the sentence break when the answer does not', () => {
    const { text } = assembleText(
      oneLine(fieldChunk('they cause real damage'), proseChunk('. But my')),
    )
    expect(text).toBe('they cause real damage. But my')
  })

  it('never puts a space in front of punctuation', () => {
    const { text } = assembleText(
      oneLine(proseChunk('My first substantive is that'), fieldChunk('fake news kills'), proseChunk('.')),
    )
    expect(text).toBe('My first substantive is that fake news kills.')
  })

  it('leaves a question mark alone when the answer starts lowercase', () => {
    // Lowercase only tells you the sentence continues when it is the *template* talking. Plenty
    // of answers start lowercase and are still whole sentences.
    const { text } = assembleText(
      oneLine(proseChunk('Did they answer it?'), fieldChunk('no, they dropped it entirely.')),
    )
    expect(text).toBe('Did they answer it? no, they dropped it entirely.')
  })

  it('puts each line on its own line', () => {
    const { text } = assembleText([
      [proseChunk('What is the problem?'), fieldChunk('Nobody is liable.')],
      [proseChunk('Why does that matter?'), fieldChunk('So nobody stops it.')],
    ])
    expect(text).toBe('What is the problem? Nobody is liable.\nWhy does that matter? So nobody stops it.')
  })

  it('leaves no stray newline for a line that came out empty', () => {
    const { text } = assembleText([
      [proseChunk('First.')],
      [],
      [proseChunk('  ')],
      [proseChunk('Second.')],
    ])
    expect(text).toBe('First.\nSecond.')
  })

  it('never fixes punctuation across a line break', () => {
    const { text } = assembleText([[fieldChunk('a claim.')], [proseChunk('because it is true.')]])
    expect(text).toBe('a claim.\nbecause it is true.')
  })

  it('shortens the run that owned a stripped full stop', () => {
    const { text, runs } = assembleText(
      oneLine(fieldChunk('the harm is irrecoverable.'), proseChunk(', their argument fails.')),
    )
    for (const run of runs) {
      expect(run.end).toBeLessThanOrEqual(text.length)
    }
    expect(text.slice(runs[0]?.start ?? 0, runs[0]?.end ?? 0)).toBe('the harm is irrecoverable')
  })
})

describe('tokenizeAssembled keeps provenance', () => {
  const assembled = assembleText(
    oneLine(proseChunk('Why does that matter?'), fieldChunk('It uproots a life.')),
  )
  const tokens = tokenizeAssembled(assembled, 'substantives.sub-1#body', 40)

  it('numbers tokens on from where the speech had got to', () => {
    expect(tokens[0]?.index).toBe(40)
    expect(tokens.at(-1)?.index).toBe(40 + tokens.length - 1)
  })

  it('marks the template’s own words as nobody’s writing', () => {
    expect(tokens.slice(0, 4).map((token) => token.fieldPath)).toEqual([null, null, null, null])
  })

  it('points every word of the answer back at its field', () => {
    const fromField = tokens.filter((token) => token.fieldPath !== null)
    expect(fromField.map((token) => token.text)).toEqual(['It', 'uproots', 'a', 'life'])
    expect(new Set(fromField.map((token) => token.fieldPath))).toEqual(
      new Set(['substantives.sub-1.whyBad']),
    )
  })

  it('gives offsets that slice the word back out', () => {
    for (const token of tokens) {
      expect(assembled.text.slice(token.start, token.end)).toBe(token.text)
    }
  })
})

/** A resolved field, for the `renderLine` cases. */
function caseField(path: string, value: string): CaseField {
  return { path, label: path, hint: '', rows: 3, value }
}

/** Builds a context whose fields are the given path/value pairs. */
function context(fields: readonly CaseField[], side: LineContext['side'] = 'opp'): LineContext {
  return {
    pathPrefix: 'engagement',
    fieldsByPath: new Map(fields.map((field) => [field.path, field])),
    side,
    ordinal: 1,
  }
}

describe('renderLine', () => {
  const template = [fixed('Prop told us'), slot('whatTheyTold'), fixed('.')]

  it('emits the line when the slot is filled', () => {
    const rendered = renderLine(
      template,
      context([caseField('engagement.whatTheyTold', 'platforms would over-remove')]),
    )
    expect(assembleText([rendered.chunks]).text).toBe('Prop told us platforms would over-remove.')
    expect(rendered.missing).toEqual([])
  })

  it('drops the whole line when the slot is blank, and names the field', () => {
    const rendered = renderLine(template, context([caseField('engagement.whatTheyTold', '   ')]))
    expect(rendered.chunks).toEqual([])
    expect(rendered.missing.map((field) => field.path)).toEqual(['engagement.whatTheyTold'])
  })

  it('reports a slot the registry has no field for, rather than saying half a sentence', () => {
    const rendered = renderLine(template, context([]))
    expect(rendered.chunks).toEqual([])
    expect(rendered.unresolved).toEqual(['engagement.whatTheyTold'])
    expect(rendered.missing).toEqual([])
  })

  it('points the template at the real opponent for a government seat', () => {
    const rendered = renderLine(
      template,
      context([caseField('engagement.whatTheyTold', 'Prop cannot be trusted')], 'gov'),
    )
    // The prose swaps; the debater's own words never do.
    expect(assembleText([rendered.chunks]).text).toBe('Opp told us Prop cannot be trusted.')
  })
})

describe('ordinalWord', () => {
  it('spells the positions a speech actually uses', () => {
    expect([1, 2, 3, 10].map(ordinalWord)).toEqual(['first', 'second', 'third', 'tenth'])
  })

  it('falls back to a numeral past the word list', () => {
    expect([11, 12, 13, 21, 22].map(ordinalWord)).toEqual(['11th', '12th', '13th', '21st', '22nd'])
  })

  it('never says "zeroth"', () => {
    expect(ordinalWord(0)).toBe('first')
  })
})
