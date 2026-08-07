/**
 * Whether the actors named in prep actually turn up in the case.
 *
 * The prep sheet's "Actors split" and "Who is affected?" are where a debater decides who the
 * round is about. A substantive that never mentions one of them has quietly dropped a
 * stakeholder, which is how a case ends up arguing for a group it forgot to name on stage.
 *
 * Two decisions keep this from firing constantly:
 *
 * - An actor whose whole name sits inside the motion — "social media companies" on a motion
 *   about social media companies — is skipped. That is the motion's subject, not a stakeholder
 *   claim, and every substantive is about it by construction.
 * - An actor counts as covered when *any* of its distinctive words appears. Requiring the whole
 *   phrase would flag "individuals" for not saying "individuals in society".
 */

import { contentWords, withoutWords } from '../text.ts'
import type { AnalysisRule, Finding, RuleContext } from '../types.ts'

/** Paths the actors are read from, in the order they are written during prep. */
const ACTOR_SOURCE_PATHS: readonly string[] = ['prep.actorsSplit', 'prep.fiveW1H.who']

/** One named actor, reduced to the words that distinguish it from the motion. */
interface NamedActor {
  /** The phrase as the debater wrote it, for quoting back. */
  readonly label: string
  readonly distinctiveWords: ReadonlySet<string>
}

/**
 * Splits the actor fields into individual actors.
 *
 * Debaters write these as a list — one per line, or comma-separated — with a parenthetical
 * role tag the template invites ("Social media companies (main actor)"). Both are stripped.
 */
function readActors(context: RuleContext): readonly NamedActor[] {
  const actors: NamedActor[] = []

  for (const path of ACTOR_SOURCE_PATHS) {
    const source = context.fieldsByPath.get(path)?.value ?? ''
    for (const rawPhrase of source.split(/[\n,;/]+/)) {
      const label = rawPhrase.replace(/\([^)]*\)/g, '').trim()
      if (label.length === 0) {
        continue
      }
      const distinctiveWords = withoutWords(contentWords(label), context.motionWords)
      if (distinctiveWords.size > 0) {
        actors.push({ label, distinctiveWords })
      }
    }
  }

  return actors
}

/**
 * Runs the stakeholder check over each substantive.
 *
 * @param context - Rules context. Reads the actor fields by path and every substantive's text.
 * @returns At most one finding per substantive, naming every actor it never mentions.
 */
export function runStakeholderCoverage(context: RuleContext): readonly Finding[] {
  const actors = readActors(context)
  if (actors.length === 0) {
    return []
  }

  return context.substantives.flatMap((substantive): Finding[] => {
    if (substantive.text.trim().length === 0) {
      return []
    }
    const written = contentWords(substantive.text)
    const missing = actors.filter(
      (actor) => ![...actor.distinctiveWords].some((word) => written.has(word)),
    )
    if (missing.length === 0) {
      return []
    }

    // One finding listing every missing actor, not one per actor: "Individuals in society" and
    // "Individuals whom fake news targets" are the same omission written twice in the prep sheet.
    const named = missing.map((actor) => `"${actor.label}"`).join(', ')
    const anchorPath = substantive.fields.find((field) => field.value.trim().length > 0)?.path
    if (!anchorPath) {
      return []
    }

    return [
      {
        fieldPath: anchorPath,
        rule: 'stakeholderCoverage',
        severity: 'warn',
        span: null,
        message: `${named} never appears in ${substantive.navLabel}.`,
        socraticPrompt: 'You named them in prep. What does this argument do for them specifically?',
      },
    ]
  })
}

/** The stakeholder-coverage rule. */
export const STAKEHOLDER_COVERAGE_RULE: AnalysisRule = {
  id: 'stakeholderCoverage',
  title: 'Stakeholder coverage',
  run: runStakeholderCoverage,
}
