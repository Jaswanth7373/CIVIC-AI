/**
 * Road-sign pictograms for the error screens, drawn as SVG in the product's signage vernacular. They are
 * decorative (aria-hidden): the page heading next to them says the same thing in words.
 * - NoThroughRoadSign: the blue "no through road" sign (white stem, red bar) for "Page not found".
 * - NoEntrySign: the red "no entry" disc for "Access denied".
 */
import { cn } from '@/utils/cn'

export function NoThroughRoadSign({ className }) {
  return (
    <svg aria-hidden viewBox="0 0 120 190" className={cn('h-auto', className)} focusable="false">
      <rect x="55" y="132" width="10" height="56" rx="2" className="fill-asphalt-400 dark:fill-asphalt-600" />
      <rect x="4" y="4" width="112" height="132" rx="12" fill="#184d8e" />
      <rect x="10" y="10" width="100" height="120" rx="8" fill="none" stroke="#ffffff" strokeWidth="3.5" />
      <rect x="51" y="54" width="18" height="64" fill="#ffffff" />
      <rect x="30" y="34" width="60" height="20" fill="#d3341f" />
    </svg>
  )
}

export function NoEntrySign({ className }) {
  return (
    <svg aria-hidden viewBox="0 0 120 180" className={cn('h-auto', className)} focusable="false">
      <rect x="55" y="112" width="10" height="66" rx="2" className="fill-asphalt-400 dark:fill-asphalt-600" />
      <circle cx="60" cy="60" r="57" fill="#ffffff" />
      <circle cx="60" cy="60" r="53" fill="#d3341f" />
      <rect x="22" y="50" width="76" height="20" rx="3" fill="#ffffff" />
    </svg>
  )
}

export default NoThroughRoadSign
