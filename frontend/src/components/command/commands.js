/**
 * What the command palette can do, as plain data: the pages of the signed-in role (from the same navigation
 * table as the sidebar), matching a typed query against them, and the per-user list of recently opened items
 * (localStorage, through utils/storage, which already survives private mode and blocked storage).
 */
import { NAVIGATION } from '@/components/layout/navigation'
import { storage } from '@/utils/storage'

/** How many recently opened pages / complaints the palette remembers per user. */
export const RECENT_LIMIT = 5

/** Extra words people search with, by the last segment of a page's path. */
const PAGE_KEYWORDS = {
  dashboard: 'home overview start summary',
  report: 'new complaint submit issue photo file',
  complaints: 'list queue issues tickets reports',
  feedback: 'rating review stars',
  notifications: 'alerts updates inbox messages',
  profile: 'account me password photo personal details',
  duplicates: 'merge same repeated similar',
  hotspots: 'map heat clusters areas',
  users: 'citizens accounts people',
  officers: 'staff workload field team',
  departments: 'categories routing organisation',
  'ai-analytics': 'model accuracy predictions confidence',
  reports: 'export csv pdf download',
  settings: 'configuration ai weights risk zones system',
  'audit-logs': 'history activity log trail',
}

/** "⌘K" on Apple devices, "Ctrl K" elsewhere. */
export function shortcutLabel() {
  if (typeof navigator === 'undefined') return 'Ctrl K'
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K'
}

/** The pages of `role` as palette commands: `{ id, kind: 'page', label, sub, to, icon, keywords }`. */
export function pageCommands(role) {
  return (NAVIGATION[role] ?? []).flatMap((group) =>
    group.items.map((item) => ({
      id: `page:${item.to}`,
      kind: 'page',
      label: item.label,
      sub: group.label ?? null,
      to: item.to,
      icon: item.icon,
      keywords: [group.label, PAGE_KEYWORDS[item.to.split('/').pop()]].filter(Boolean).join(' '),
    })),
  )
}

function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Commands whose label or keywords contain every word of `term` (case and accents ignored), best first: label
 * starts with the term, then a word of the label starts with it, then any other match.
 */
export function filterCommands(commands, term) {
  const query = normalise(term).trim()
  if (!query) return commands
  const words = query.split(/\s+/)
  return commands
    .map((command) => {
      const label = normalise(command.label)
      const haystack = `${label} ${normalise(command.sub)} ${normalise(command.keywords)}`
      if (!words.every((word) => haystack.includes(word))) return null
      const rank = label.startsWith(query) ? 0 : label.split(/\s+/).some((part) => part.startsWith(words[0])) ? 1 : 2
      return { command, rank }
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.command)
}

const recentKey = (userId) => `civicai.palette.recent.${userId}`

/** Keep only well-formed entries: storage is user-editable, so nothing read back is trusted. */
function cleanRecents(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        ((entry.kind === 'page' && typeof entry.to === 'string' && entry.to.startsWith('/')) ||
          (entry.kind === 'complaint' &&
            (typeof entry.complaintId === 'number' || /^\d+$/.test(String(entry.complaintId ?? ''))) &&
            typeof entry.number === 'string')),
    )
    .slice(0, RECENT_LIMIT)
}

/** The user's recently opened items, newest first: `{ kind: 'page', to }` or `{ kind: 'complaint', complaintId, number, title }`. */
export function readRecents(userId) {
  if (userId == null) return []
  return cleanRecents(storage.getJSON(recentKey(userId), []))
}

/** Remember an opened page / complaint (moved to the front, at most RECENT_LIMIT kept). Returns the new list. */
export function rememberRecent(userId, entry) {
  if (userId == null || !entry) return []
  const same = (other) =>
    other.kind === entry.kind && (entry.kind === 'page' ? other.to === entry.to : String(other.complaintId) === String(entry.complaintId))
  const next = cleanRecents([entry, ...readRecents(userId).filter((other) => !same(other))])
  storage.setJSON(recentKey(userId), next)
  return next
}

/** The visible theme toggle (the reveal starts there when the palette switches the theme), if any. */
export function findThemeToggle() {
  if (typeof document === 'undefined') return null
  return Array.from(document.querySelectorAll('[data-theme-toggle]')).find((element) => element.getClientRects().length > 0) ?? null
}
