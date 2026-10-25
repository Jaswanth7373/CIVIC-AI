/**
 * Role presentation for the admin user screens. Role is an identity, not a status, so the tones stay quiet
 * (asphalt neutral soft badges, the CivicAI sign green for administrators) and every badge carries the role name
 * and an icon.
 */
import { HardHat, ShieldCheck, UserRound } from 'lucide-react'
import { ROLE_LABELS } from '@/utils/constants'

export const ROLE_META = Object.freeze({
  citizen: { value: 'citizen', label: ROLE_LABELS.citizen, tone: 'neutral', icon: UserRound },
  officer: { value: 'officer', label: ROLE_LABELS.officer, tone: 'neutral', icon: HardHat },
  admin: { value: 'admin', label: ROLE_LABELS.admin, tone: 'green', icon: ShieldCheck },
})

export function getRoleMeta(role) {
  return ROLE_META[role] ?? { value: role, label: String(role ?? 'Unknown'), tone: 'neutral', icon: UserRound }
}

/** "Complaints reported" for citizens and admins, "Complaints assigned" for officers (same as the API count). */
export function complaintCountLabel(role) {
  return role === 'officer' ? 'Complaints assigned' : 'Complaints reported'
}

export const LANGUAGE_LABELS = Object.freeze({
  en: 'English',
  hi: 'Hindi',
  te: 'Telugu',
  ta: 'Tamil',
  kn: 'Kannada',
  mr: 'Marathi',
  ur: 'Urdu',
})
