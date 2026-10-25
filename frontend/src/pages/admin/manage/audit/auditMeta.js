/**
 * Audit-log presentation: a tone + icon per action (colour = meaning: deletions red, creations green,
 * configuration changes orange because they affect everything, AI corrections violet), the entity types the
 * backend writes (`AuditLog.entity_type` = the model class name, plus "CategoryRouting", "report", "system")
 * with readable names, and where each entity can be opened in the admin area.
 */
import {
  Archive,
  CopyCheck,
  FileDown,
  KeyRound,
  LogIn,
  LogOut,
  PencilLine,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Shuffle,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  UserPlus,
  Wrench,
} from 'lucide-react'
import { AUDIT_ACTION_LABELS } from '@/utils/constants'

export const AUDIT_ACTION_META = Object.freeze({
  create: { tone: 'green', icon: Plus },
  update: { tone: 'blue', icon: PencilLine },
  delete: { tone: 'red', icon: Trash2 },
  register: { tone: 'teal', icon: UserPlus },
  login: { tone: 'slate', icon: LogIn },
  logout: { tone: 'slate', icon: LogOut },
  password_change: { tone: 'violet', icon: KeyRound },
  status_change: { tone: 'neutral', icon: RefreshCw },
  assign: { tone: 'blue', icon: UserCheck },
  reassign: { tone: 'blue', icon: Shuffle },
  ai_override: { tone: 'violet', icon: SlidersHorizontal },
  verify: { tone: 'green', icon: ShieldCheck },
  duplicate_review: { tone: 'orange', icon: CopyCheck },
  config_change: { tone: 'orange', icon: Settings2 },
  export: { tone: 'slate', icon: FileDown },
  other: { tone: 'neutral', icon: Wrench },
})

export function getActionMeta(action, display) {
  const meta = AUDIT_ACTION_META[action] ?? { tone: 'neutral', icon: Archive }
  return { ...meta, label: display || AUDIT_ACTION_LABELS[action] || String(action ?? 'Other') }
}

export const ENTITY_TYPES = Object.freeze([
  { value: 'Complaint', label: 'Complaint' },
  { value: 'User', label: 'User account' },
  { value: 'DuplicateComplaint', label: 'Duplicate pair' },
  { value: 'HotspotAlert', label: 'Hotspot alert' },
  { value: 'Department', label: 'Department' },
  { value: 'CivicCategory', label: 'Category' },
  { value: 'CategoryRouting', label: 'Category routing' },
  { value: 'AIConfiguration', label: 'AI configuration' },
  { value: 'RiskZone', label: 'Risk zone' },
  { value: 'ContactMessage', label: 'Contact message' },
  { value: 'report', label: 'Report export' },
  { value: 'system', label: 'System check' },
])

export function entityLabel(type) {
  const match = ENTITY_TYPES.find((item) => item.value.toLowerCase() === String(type ?? '').toLowerCase())
  if (match) return match.label
  return String(type ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
}

/** Admin page that shows an audited entity, or null when there is no page for it. */
export function entityPath(type, id) {
  switch (String(type ?? '').toLowerCase()) {
    case 'complaint':
      return id ? `/admin/complaints/${id}` : null
    case 'duplicatecomplaint':
      return '/admin/duplicates'
    case 'hotspotalert':
      return '/admin/hotspots'
    case 'department':
      return '/admin/departments'
    case 'civiccategory':
      return '/admin/departments?tab=categories'
    case 'categoryrouting':
      return '/admin/departments?tab=routing'
    case 'aiconfiguration':
      return '/admin/settings'
    case 'riskzone':
      return '/admin/settings?tab=zones'
    case 'contactmessage':
      return '/admin/settings?tab=messages'
    case 'report':
      return '/admin/reports'
    default:
      return null
  }
}

// Creations and deletions store a snapshot `{field: value}`; every other action stores old -> new pairs
// `{field: [old, new]}` (sometimes next to context values, or nested per item like the routing table).
const SNAPSHOT_ACTIONS = new Set(['create', 'delete', 'register'])
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPair = (value) => Array.isArray(value) && value.length === 2 && value.every((item) => !isPlainObject(item))
const isBlank = (value) => value === null || value === undefined || value === ''
const samePair = ([before, after]) => (isBlank(before) && isBlank(after)) || JSON.stringify(before) === JSON.stringify(after)

/** True when the entry's `changes` is a snapshot of the record rather than a diff. */
export function isSnapshotAction(action) {
  return SNAPSHOT_ACTIONS.has(String(action ?? '').toLowerCase())
}

/**
 * Label of the details toggle: "8 fields" for a snapshot, "2 changes" for a diff (pairs whose two sides are
 * equal are not counted), "Details" when there is something to show but no old -> new pair; null when the
 * entry has nothing recorded.
 */
export function changesLabel(changes, action) {
  if (!isPlainObject(changes) || !Object.keys(changes).length) return null
  if (isSnapshotAction(action)) {
    const fields = Object.keys(changes).length
    return `${fields} ${fields === 1 ? 'field' : 'fields'}`
  }
  const countPairs = (object) =>
    Object.values(object).reduce((sum, value) => {
      if (isPair(value)) return sum + (samePair(value) ? 0 : 1)
      if (isPlainObject(value)) return sum + countPairs(value)
      return sum
    }, 0)
  const count = countPairs(changes)
  return count ? `${count} ${count === 1 ? 'change' : 'changes'}` : 'Details'
}
