/**
 * Helpers shared by the login and registration screens.
 *
 * Demo accounts (the login page's "Fill in" panel) never ship in a production bundle. A deployed site shows
 * them only when its API publishes them: `demo_accounts` in GET /api/system/config/, which the server sends
 * only when the deployment explicitly enables it. Demo AI Mode is about the AI models and does not publish
 * any account. The Vite dev server (`npm run dev`, local presentations) falls back to the accounts created by
 * the backend's `seed_demo` command while the API does not say otherwise.
 */

const DEMO_ROLES = ['citizen', 'officer', 'admin']

/** What each role does, in one line (demo account cards, the Features page role cards). */
export const ROLE_DESCRIPTIONS = Object.freeze({
  citizen: 'Reports issues and follows them to the fix.',
  officer: 'Works a department queue: accept, resolve, verify.',
  admin: 'Runs the city view: analytics, routing and AI settings.',
})

/**
 * `seed_demo` logins for development builds only. `import.meta.env.DEV` is the constant `false` in
 * `vite build`, so this list - passwords included - is compiled out of the production bundle.
 */
const DEV_DEMO_ACCOUNTS = import.meta.env.DEV
  ? [
      { role: 'citizen', email: 'citizen@civicai.local', password: 'Citizen@12345' },
      {
        role: 'officer',
        email: 'roads.officer1@civicai.local',
        password: 'Officer@12345',
        description: 'Works the Roads Department queue: accept, resolve, verify.',
      },
      { role: 'admin', email: 'admin@civicai.local', password: 'Admin@12345' },
    ]
  : []

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * Demo accounts the login page may offer: `[{role, email, password, description}]`, possibly empty.
 *
 * The API decides when it sends `demo_accounts` (an array to show, or null / [] when the deployment does not
 * publish any). Without that key, only a development build offers the seeded accounts. Entries with an
 * unknown role or without an email and password are dropped.
 */
export function demoAccountsFrom(config) {
  const published = config?.demo_accounts
  const source = published === undefined ? DEV_DEMO_ACCOUNTS : published
  if (!Array.isArray(source)) return []
  const seen = new Set()
  return source.flatMap((account) => {
    const role = account?.role
    const email = text(account?.email)
    const password = typeof account?.password === 'string' ? account.password : ''
    if (!DEMO_ROLES.includes(role) || !email || !password || seen.has(email.toLowerCase())) return []
    seen.add(email.toLowerCase())
    return [{ role, email, password, description: text(account.description) || ROLE_DESCRIPTIONS[role] }]
  })
}

/** Pragmatic e-mail shape check (the server validates properly). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Phone as the backend accepts it: optional leading +, digits, spaces or hyphens, 7-15 digits in total. */
export function isValidPhone(value) {
  const text = String(value ?? '').trim()
  if (!text) return true
  const digits = text.replace(/\D/g, '')
  return /^\+?[\d\s-]+$/.test(text) && digits.length >= 7 && digits.length <= 15
}

/** Copy for the login lead when the visitor was sent here from a protected page (`?next=`). */
export function nextPurpose(next) {
  if (!next || typeof next !== 'string') return null
  if (next.startsWith('/citizen/report')) return 'Log in to report an issue. It takes a photo, a sentence and a pin on the map.'
  if (/^\/(citizen|officer|admin)\//.test(next)) return 'Log in to continue to the page you opened.'
  return null
}

/** Append the `next` parameter to an auth link, so switching between login and registration keeps it. */
export function withNext(path, next) {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path
}

/**
 * Password guidance shown while typing. The server is the authority (Django's validators also reject
 * common passwords); these checks mirror the rules people can act on.
 */
export function passwordChecks(password, { firstName = '', lastName = '', email = '' } = {}) {
  const value = String(password ?? '')
  const lower = value.toLowerCase()
  const personal = [firstName, lastName, String(email).split('@')[0]]
    .map((part) => String(part ?? '').trim().toLowerCase())
    .filter((part) => part.length >= 3)
  return [
    { key: 'length', label: 'At least 8 characters', met: value.length >= 8 },
    { key: 'numeric', label: 'Not only numbers', met: value.length > 0 && !/^\d+$/.test(value) },
    {
      key: 'mix',
      label: 'Mixes letters with numbers or symbols',
      met: /[a-z]/i.test(value) && /[^a-z]/i.test(value),
    },
    {
      key: 'personal',
      label: "Doesn't contain your name or email",
      met: value.length > 0 && !personal.some((part) => lower.includes(part)),
    },
  ]
}

const STRENGTH_LEVELS = {
  1: { label: 'Weak', tone: 'red' },
  2: { label: 'Fair', tone: 'orange' },
  3: { label: 'Good', tone: 'green' },
  4: { label: 'Strong', tone: 'green' },
}

/**
 * 1-4 strength: weak when a basic rule fails, fair when it only meets the rules, good with three kinds of
 * characters or 12+ characters, strong with both. A password that contains the person's name or email
 * never rates above fair.
 */
export function passwordStrength(password, checks) {
  const value = String(password ?? '')
  if (!value) return { score: 0, label: '', tone: 'neutral' }
  const met = Object.fromEntries(checks.map((check) => [check.key, check.met]))
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((pattern) => pattern.test(value)).length
  let score
  if (!met.length || !met.numeric || !met.mix) score = 1
  else if (kinds >= 3 && value.length >= 12) score = 4
  else if (kinds >= 3 || value.length >= 12) score = 3
  else score = 2
  if (!met.personal) score = Math.min(score, 2)
  return { score, ...STRENGTH_LEVELS[score] }
}
