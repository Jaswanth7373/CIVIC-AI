/**
 * "Demo accounts" helper on the login page: seeded accounts to try each role. Each account is one large button
 * (the whole row is the target): pressing it copies the email and password into the login form - it does not
 * log in by itself, so the visitor still sees and submits the real form. The login page then flashes the two
 * fields it filled, so the eye follows the values. The account currently in the form is marked with the yellow
 * lane marker and "Filled in". The login page renders it only when `demoAccountsFrom()` (authUtils) returns
 * accounts: a deployment whose API publishes them, or the development server.
 *
 * Props: accounts ([{role, email, password, description}]), onPick(account), activeEmail (the email
 * currently in the form, to mark the chosen account).
 */
import { Building2, Check, HardHat, UserRound } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ROLE_LABELS } from '@/utils/constants'

const ROLE_ICONS = { citizen: UserRound, officer: HardHat, admin: Building2 }

export function DemoAccounts({ accounts, onPick, activeEmail }) {
  const list = Array.isArray(accounts) ? accounts : []
  if (!list.length) return null
  const chosen = activeEmail?.trim().toLowerCase()

  return (
    <section aria-labelledby="demo-accounts-title">
      <h2 id="demo-accounts-title" className="font-display text-lg font-bold text-ink">
        Demo accounts
      </h2>
      <p className="mt-1 text-sm text-ink-2">Seeded accounts from the demo data. Fill one in, then log in to see that role's workspace.</p>
      <ul className="mt-4 grid gap-2.5">
        {list.map((account) => {
          const Icon = ROLE_ICONS[account.role] ?? UserRound
          const roleLabel = ROLE_LABELS[account.role] ?? account.role
          const active = chosen === account.email.toLowerCase()
          return (
            <li key={account.email}>
              <button
                type="button"
                onClick={() => onPick(account)}
                aria-label={`Fill in the ${roleLabel.toLowerCase()} demo account ${account.email}`}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'pressable group relative flex w-full items-center gap-3.5 overflow-hidden rounded-xl border py-3 pl-4 pr-3 text-left [--press-scale:0.985]',
                  'transition-[border-color,background-color,box-shadow] duration-200 ease-standard',
                  active
                    ? 'border-sign-300 bg-primary-soft dark:border-sign-500/40'
                    : 'border-line bg-surface hover:border-line-strong hover:elev-raised',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'lane-line absolute inset-y-2 left-0 w-[3px] rounded-full transition-[opacity,scale] duration-300 ease-spring',
                    active ? 'scale-y-100 opacity-100' : 'scale-y-50 opacity-0',
                  )}
                />
                <span
                  className={cn(
                    'grid size-10 shrink-0 place-items-center rounded-lg transition-colors duration-200',
                    active ? 'bg-primary text-white' : 'bg-sunken text-ink-2 group-hover:text-ink',
                  )}
                >
                  <Icon aria-hidden className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-ink">{roleLabel}</span>
                  <span className="block truncate text-sm text-ink-2">{account.email}</span>
                  {account.description ? <span className="block text-xs text-ink-3">{account.description}</span> : null}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold transition-colors duration-200',
                    active
                      ? 'bg-primary text-white'
                      : 'border border-line-strong bg-surface text-ink group-hover:border-ink-3',
                  )}
                >
                  {active ? <Check key="tick" className="size-3.5 animate-pop-in" strokeWidth={3} /> : null}
                  {active ? 'Filled in' : 'Fill in'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-4 text-xs leading-relaxed text-ink-3">
        Shown because this deployment runs with demo data. Officer and administrator accounts are created by the city
        administration, never by sign-up.
      </p>
    </section>
  )
}

export default DemoAccounts
