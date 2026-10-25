/**
 * DepartmentBadge - the department a complaint is routed to ("Roads Department").
 *
 * Props:
 * - department: DepartmentMini `{id, name, code, icon, color}` | null
 * - size: 'sm' | 'md' | 'lg' (default 'md')
 * - showCode: append the short code (e.g. "ROADS") - useful in dense admin tables
 * - emptyLabel: text when no department is set yet (default "Not routed yet")
 * - className
 */
import { Building2 } from 'lucide-react'
import { EntityBadge } from './EntityBadge'

export function DepartmentBadge({ department, size = 'md', showCode = false, emptyLabel = 'Not routed yet', className }) {
  if (!department || !department.name) {
    return <EntityBadge name={emptyLabel} icon="building-2" size={size} srPrefix="Department: " className={className} />
  }
  const name = showCode && department.code ? `${department.name} (${department.code})` : department.name
  return (
    <EntityBadge
      name={name}
      icon={department.icon}
      color={department.color}
      fallbackIcon={Building2}
      size={size}
      srPrefix="Department: "
      title={department.code ? `${department.name} (${department.code})` : department.name}
      className={className}
    />
  )
}

export default DepartmentBadge
