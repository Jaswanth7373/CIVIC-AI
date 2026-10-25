/**
 * OfficerSelect - a native select of officers grouped by department (`<optgroup>`), fed by GET /officers/.
 *
 * Props:
 * - officers: OfficerOut rows
 * - value / onChange(value: string): the selected officer id as a string ('' = none)
 * - placeholder: first option with value '' (e.g. "Any officer")
 * - excludeId: an officer to leave out (the one already assigned)
 * - activeOnly: hide deactivated accounts (assignment targets must be active)
 * - any other Select prop (aria-label, size, containerClassName, invalid ...)
 */
import { Select } from '@/components/ui/Select'
import { groupOfficers } from './listUtils'

export function OfficerSelect({ officers, value, onChange, placeholder = 'Any officer', excludeId, activeOnly = false, ...props }) {
  const visible = (Array.isArray(officers) ? officers : []).filter(
    (officer) => String(officer.id) !== String(excludeId ?? '') && (!activeOnly || officer?.user?.is_active !== false),
  )
  const groups = groupOfficers(visible)
  return (
    <Select value={value} onChange={(event) => onChange?.(event.target.value)} {...props}>
      <option value="">{placeholder}</option>
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.officers.map((officer) => (
            <option key={officer.id} value={String(officer.id)}>
              {officer.name}
              {officer.hint}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  )
}

export default OfficerSelect
