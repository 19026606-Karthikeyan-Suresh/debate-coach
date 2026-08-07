/**
 * Runs Layer A behind a debounce.
 *
 * Analysis is pure and fast, but it re-reads every field of the case, and doing that on each
 * keystroke while someone types a paragraph is wasted work whose only visible effect is
 * underlines flickering under a half-written sentence. Waiting for a pause also means findings
 * appear when the debater has stopped and might read them.
 *
 * The debounce is the effect's own cleanup, the same shape `useCaseStore` uses for autosave:
 * each new document cancels the timer armed for the previous one, so a burst of typing collapses
 * to a single run with no timer bookkeeping and no ref.
 *
 * The consequence downstream is that findings always lag the text by up to the delay, so their
 * spans can point past the end of a field the debater has since cut. `buildHighlightSegments`
 * clamps rather than trusting them.
 */

import { useEffect, useState } from 'react'

import type { SpeakerRole } from '../formats/index.ts'
import { runAnalysis } from '../analysis/index.ts'
import type { Finding } from '../analysis/index.ts'
import type { Case } from '../types/case.ts'

/**
 * Quiet time before the rules run.
 *
 * Half the autosave delay: a finding that arrives after the write has already happened feels
 * like the app noticed late.
 */
const ANALYSIS_DELAY_MS = 350

// Shared empty result, so a case that has not loaded does not hand out a fresh array each render
// and re-run every memo downstream.
const NO_FINDINGS: readonly Finding[] = []

/**
 * Analyses a case as it is edited.
 *
 * @param caseFile - The document being edited, or null while it loads. Its identity changing is
 *   what re-arms the debounce, which works because every edit produces a new object.
 * @param role - The seat being prepped, or undefined when the case has no valid position. Both
 *   null cases yield no findings rather than findings for the wrong seat.
 * @returns Findings from the last completed run, in document order.
 */
export function useAnalysis(
  caseFile: Case | null,
  role: SpeakerRole | undefined,
): readonly Finding[] {
  const [findings, setFindings] = useState<readonly Finding[]>(NO_FINDINGS)

  useEffect(() => {
    if (!caseFile || !role) {
      return
    }
    const handle = window.setTimeout(() => {
      setFindings(runAnalysis(caseFile, role))
    }, ANALYSIS_DELAY_MS)

    return () => {
      window.clearTimeout(handle)
    }
  }, [caseFile, role])

  // Discarded during render rather than in the effect, so a case that fails to load never shows
  // the previous case's findings for a frame.
  return caseFile && role ? findings : NO_FINDINGS
}
