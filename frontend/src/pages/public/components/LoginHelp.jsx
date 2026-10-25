/**
 * Side content of the login page when no demo accounts are offered (every deployment whose API does not
 * publish them): the workspace each role opens after logging in, and what to do when logging in fails.
 * There is no self-service password reset, so the panel says who can help. It sits under the form, so it is
 * a quiet list rather than another card.
 */
import { Building2, HardHat, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ROLE_LABELS } from '@/utils/constants'

const WORKSPACES = [
  {
    role: 'citizen',
    icon: UserRound,
    text: 'Your reports with their live status and the fix, and a quick way to report the next issue.',
  },
  {
    role: 'officer',
    icon: HardHat,
    text: "Your department's queue sorted by AI priority: accept, resolve and verify the fix.",
  },
  {
    role: 'admin',
    icon: Building2,
    text: 'The city view: analytics, hotspots, routing, users and AI settings.',
  },
]

export function LoginHelp() {
  return (
    <section aria-labelledby="login-help-title">
      <h2 id="login-help-title" className="font-display text-lg font-bold text-ink">
        Where logging in takes you
      </h2>
      <ul className="mt-4 space-y-4">
        {WORKSPACES.map(({ role, icon: Icon, text }) => (
          <li key={role} className="flex gap-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
              <Icon aria-hidden className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-ink">{ROLE_LABELS[role]}</p>
              <p className="text-sm text-ink-2">{text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-6 rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2 ring-1 ring-inset ring-line">
        Can't log in? Officer and administrator accounts come from the city administration: ask them to reset your
        password. Citizens can{' '}
        <Link to="/contact" className="font-semibold text-primary-ink underline-offset-4 hover:underline">
          write to the CivicAI team
        </Link>
        .
      </p>
    </section>
  )
}

export default LoginHelp
