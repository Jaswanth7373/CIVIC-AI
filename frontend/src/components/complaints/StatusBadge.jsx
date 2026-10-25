/**
 * StatusBadge - complaint status ("Assigned", "In progress", "Verified").
 *
 * Props:
 * - status: Complaint.Status value (submitted | analyzed | assigned | accepted | in_progress | resolved |
 *   verified | closed | rejected | reopened)
 * - label: fallback text for a status this frontend does not know yet (e.g. the API's `status_display`)
 * - size: 'sm' | 'md' | 'lg' (default 'md')
 * - showIcon: default true
 * - className
 *
 * Tone, icon and label come from STATUS_META in utils/constants ("colour = meaning"). Every status uses the same
 * tinted chip - a single solid chip in a list of tinted ones shouts louder than the work that is still open;
 * "Verified" is told apart from "Resolved" by its shield icon and its word.
 */
import { Badge } from '@/components/ui/Badge'
import { STATUS_META, getStatusMeta } from '@/utils/constants'

export function StatusBadge({ status, label, size = 'md', showIcon = true, className }) {
  const known = STATUS_META[status]
  const meta = known ?? getStatusMeta(status)
  const text = known ? meta.label : (label ?? meta.label)
  return (
    <Badge
      tone={meta.tone}
      variant="soft"
      size={size}
      icon={showIcon ? meta.icon : undefined}
      title={meta.description || undefined}
      className={className}
    >
      <span className="sr-only">Status: </span>
      {text}
    </Badge>
  )
}

export default StatusBadge
