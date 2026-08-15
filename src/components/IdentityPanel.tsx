/**
 * The account this install writes as, and the one thing worth doing to it.
 *
 * Anonymous is the ordinary state, not a lesser one — every policy in the schema is written
 * against `auth.uid()`, which an anonymous user has, so a squad can be onboarded with an invite
 * code and nothing else. What an email buys is exactly one thing: a way back to the same account
 * from another browser, or after site data is cleared. The panel says that and does not push.
 *
 * **The sign-in door is the dangerous half.** Signing in as somebody else replaces this identity,
 * and the cases written under the anonymous one stay owned by it — visible to nobody, deleted by
 * nothing. So the count is read before the form is shown, and the warning names it.
 */

import { useCallback, useState } from 'react'

import { listCaseIds } from '../db/index.ts'
import type { IdentitySession } from '../hooks/useIdentity.ts'
import { describeSignInRisk } from '../sync/identity.ts'

/** Props for {@link IdentityPanel}. */
export interface IdentityPanelProps {
  readonly identity: IdentitySession
}

/** A labelled address field and its button, which is the same shape twice. */
function EmailForm({
  label,
  action,
  isBusy,
  onSubmit,
}: {
  label: string
  action: string
  isBusy: boolean
  onSubmit: (email: string) => void
}): React.JSX.Element {
  const [email, setEmail] = useState('')
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-1 flex-col gap-1 text-sm">
        {label}
        <input
          className="field-input mt-0"
          type="email"
          value={email}
          placeholder="you@example.com"
          onChange={(event) => {
            setEmail(event.target.value)
          }}
        />
      </label>
      <button
        type="button"
        className="btn"
        disabled={isBusy || email.trim().length === 0}
        onClick={() => {
          onSubmit(email.trim())
        }}
      >
        {action}
      </button>
    </div>
  )
}

/**
 * Renders the account line and the email affordances.
 *
 * @param props - See {@link IdentityPanelProps}.
 * @param props.identity - From `useIdentity`, owned by the app root so "check your inbox"
 *   survives this panel re-rendering.
 * @returns The panel, or null on a build with no identity at all — which is the desktop's
 *   ordinary state and has nothing to say.
 */
export function IdentityPanel({ identity }: IdentityPanelProps): React.JSX.Element | null {
  // How many cases this identity owns, read only when the sign-in form is opened. Null means
  // "not counted yet", which is different from zero.
  const [ownedCases, setOwnedCases] = useState<number | null>(null)
  const [isSigningIn, setIsSigningIn] = useState(false)

  const openSignIn = useCallback((): void => {
    setIsSigningIn(true)
    identity.clearNotice()
    // Counted at the moment it matters rather than on every render: this is a query, and the
    // Library already runs one of its own on open.
    void listCaseIds()
      .then((ids) => {
        setOwnedCases(ids.length)
      })
      .catch(() => {
        setOwnedCases(null)
      })
  }, [identity])

  if (identity.identity === null) {
    return null
  }
  const { email, pendingEmail } = identity.identity

  return (
    <section className="panel flex flex-col gap-3 p-4">
      <h2 className="section-heading">Account</h2>

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {email === null
          ? 'This install writes as an anonymous account. That is enough for everything — teams, sharing, co-prep.'
          : `Signed in as ${email}.`}
        {pendingEmail !== null && ` Waiting on the link sent to ${pendingEmail}.`}
      </p>

      {email === null && (
        <>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Adding an email is how you reach the same account from another browser or another
            machine. It stays the same account — nothing moves and nothing is shared by it.
          </p>
          <EmailForm
            label="Add an email"
            // Named for what it does, not for what it sends. The sign-in form below can be open
            // at the same time, and two buttons reading "Send link" side by side are one click
            // away from replacing the account instead of keeping it.
            action="Add email"
            isBusy={identity.isBusy}
            onSubmit={(address) => {
              void identity.linkEmail(address)
            }}
          />
        </>
      )}

      {!isSigningIn ? (
        <button
          type="button"
          className="btn self-start"
          onClick={openSignIn}
        >
          Sign in with an email you already added
        </button>
      ) : (
        <>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {describeSignInRisk(ownedCases)}
          </p>
          <EmailForm
            label="Email on the account you want"
            action="Send sign-in link"
            isBusy={identity.isBusy}
            onSubmit={(address) => {
              void identity.sendSignInLink(address)
            }}
          />
          <button
            type="button"
            className="btn self-start"
            onClick={() => {
              setIsSigningIn(false)
            }}
          >
            Cancel
          </button>
        </>
      )}

      {identity.notice !== null && (
        <p className="text-xs text-neutral-700 dark:text-neutral-200">{identity.notice}</p>
      )}
      {identity.error !== null && (
        <p className="text-xs text-red-700 dark:text-red-400">{identity.error}</p>
      )}
    </section>
  )
}
