/**
 * CategoryBadge - the civic category of a complaint ("Roads / Potholes").
 *
 * Props:
 * - category: CategoryMini `{id, name, slug, icon, color}` | slug string (e.g. an AIPrediction
 *   `image_category`) | null. A bare slug is shown humanised ("water_leak" -> "Water leak") with its icon.
 * - size: 'sm' | 'md' | 'lg' (default 'md')
 * - emptyLabel: text when there is no category (default "Uncategorised")
 * - className
 *
 * The plate uses the category's own colour (data from the database), so a category looks the same on badges,
 * map pins and charts.
 */
import { Tag } from 'lucide-react'
import { EntityBadge } from './EntityBadge'

function humanizeSlug(slug) {
  const text = String(slug ?? '').replace(/[_-]+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

export function CategoryBadge({ category, size = 'md', emptyLabel = 'Uncategorised', className }) {
  const entity =
    typeof category === 'string' ? { name: humanizeSlug(category), slug: category, icon: category } : (category ?? null)
  if (!entity || !(entity.name || entity.slug)) {
    return <EntityBadge name={emptyLabel} icon="circle-help" size={size} srPrefix="Category: " className={className} />
  }
  return (
    <EntityBadge
      name={entity.name || humanizeSlug(entity.slug)}
      icon={entity.icon || entity.slug}
      color={entity.color}
      fallbackIcon={Tag}
      size={size}
      srPrefix="Category: "
      className={className}
    />
  )
}

export default CategoryBadge
