/**
 * Quick filter chips of the admin complaint list. Each chip is a shortcut for one GET /complaints/ filter,
 * so the chips, the filter bar and the URL always agree:
 *
 * - Critical      -> priority_level=critical
 * - Unassigned    -> unassigned=true  (open complaints that no officer has been assigned to yet)
 * - Overdue       -> is_overdue=true   (open and past its SLA deadline)
 * - Duplicates    -> has_duplicates=true (part of a pending or confirmed duplicate pair)
 * - Needs review  -> needs_review=true (AI uncertain or a resolution waiting for manual verification)
 */
import { Copy, Siren, TimerOff, UserSearch, UserX } from 'lucide-react'

export const QUICK_FILTERS = Object.freeze([
  {
    key: 'critical',
    label: 'Critical',
    icon: Siren,
    iconTone: 'red',
    description: 'Critical priority: immediate risk to public safety',
    params: { priority_level: 'critical' },
    isActive: (filters) => filters.priority_level === 'critical',
    toggle: (active) => ({ priority_level: active ? '' : 'critical' }),
  },
  {
    key: 'unassigned',
    label: 'Unassigned',
    icon: UserX,
    iconTone: 'orange',
    description: 'Open complaints that no officer has been assigned to yet',
    params: { unassigned: 'true' },
    isActive: (filters) => filters.unassigned === 'true',
    toggle: (active) => ({ unassigned: active ? '' : 'true' }),
  },
  {
    key: 'overdue',
    label: 'Overdue',
    icon: TimerOff,
    iconTone: 'red',
    description: 'Open complaints past their service-level deadline',
    params: { is_overdue: 'true' },
    isActive: (filters) => filters.is_overdue === 'true',
    toggle: (active) => ({ is_overdue: active ? '' : 'true' }),
  },
  {
    key: 'duplicates',
    label: 'Duplicates',
    icon: Copy,
    iconTone: 'orange',
    description: 'Complaints linked to a pending or confirmed duplicate report',
    params: { has_duplicates: 'true' },
    isActive: (filters) => filters.has_duplicates === 'true',
    toggle: (active) => ({ has_duplicates: active ? '' : 'true' }),
  },
  {
    key: 'review',
    label: 'Needs review',
    icon: UserSearch,
    iconTone: 'blue',
    description: 'Flagged for a human check: uncertain AI result or a resolution awaiting manual verification',
    params: { needs_review: 'true' },
    isActive: (filters) => filters.needs_review === 'true',
    toggle: (active) => ({ needs_review: active ? '' : 'true' }),
  },
])
