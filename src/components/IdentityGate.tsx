/**
 * The one screen that can come before the Library.
 *
 * It exists for a foreign key. Where Postgres is the truth a case cannot be written before there
 * is an `auth.uid()` to own it, so rendering the Library first shows an empty list and then a
 * refusal from the first keystroke — which reads as "my cases are gone" rather than as "wait a
 * moment". Holding one frame is the honest version of the same wait.
 *
 * Three states and they need different things: a wait, a retry, and a configuration change that
 * only the person who built this copy can make.
 */

import type { IdentitySession } from '../hooks/useIdentity.ts'

/** Props for {@link IdentityGate}. */
export interface IdentityGateProps {
  readonly identity: IdentitySession
}

/**
 * Renders whichever blocking state the identity check is in.
 *
 * @param props - See {@link IdentityGateProps}.
 * @param props.identity - From `useIdentity`. Only ever rendered when its status is not `ready`;
 *   a ready session here renders nothing rather than an empty box.
 * @returns The gate.
 */
export function IdentityGate({ identity }: IdentityGateProps): React.JSX.Element | null {
  if (identity.status === 'ready') {
    return null
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="panel flex max-w-md flex-col gap-3 p-6">
        {identity.status === 'checking' && (
          <>
            <h1 className="section-heading">Signing in</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Your cases belong to an account, so there has to be one before the library opens.
              No email is asked for and none is needed.
            </p>
          </>
        )}

        {identity.status === 'unconfigured' && (
          <>
            <h1 className="section-heading">No storage configured</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              This build has no Supabase project, and in a browser that is where cases live —
              there is no local database behind it. Add <code>VITE_SUPABASE_URL</code> and{' '}
              <code>VITE_SUPABASE_ANON_KEY</code> and build again.
            </p>
          </>
        )}

        {identity.status === 'error' && (
          <>
            <h1 className="section-heading">Could not sign in</h1>
            <p className="text-sm text-red-700 dark:text-red-400">{identity.error}</p>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              The usual cause is anonymous sign-ins being switched off for the project, under
              Authentication → Providers. That is a project setting rather than anything about
              this browser.
            </p>
            <button
              type="button"
              className="btn self-start"
              onClick={() => {
                identity.retry()
              }}
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  )
}
