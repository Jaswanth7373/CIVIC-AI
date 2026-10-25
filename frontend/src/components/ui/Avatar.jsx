import { useState } from 'react'
import { cn } from '@/utils/cn'
import { getInitials } from '@/utils/format'

const SIZES = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
  xl: 'size-20 text-2xl',
}

/**
 * Initials backgrounds: civic-signage tones only (highway-sign green, guide blue, asphalt, hazard amber and a
 * dark sign-teal between the green and the blue), deep enough for white initials at AA in both themes:
 * sign-700 8.2:1, guide-700 11.0:1, asphalt-700 9.2:1, asphalt-600 6.5:1, hazard-700 6.5:1, teal 7.7:1.
 */
const BACKGROUNDS = [
  'bg-sign-700 text-white',
  'bg-guide-700 text-white',
  'bg-asphalt-700 text-white',
  'bg-hazard-700 text-white',
  'bg-[#0f5b63] text-white',
  'bg-asphalt-600 text-white',
]

/** Deterministic string hash, so a person always gets the same initials colour. */
function hash(text) {
  let value = 0
  for (const char of String(text)) value = (value * 31 + char.charCodeAt(0)) | 0
  return Math.abs(value)
}

/**
 * User avatar: the photo when available (falls back to initials if it fails to load), otherwise initials
 * on a colour derived from the name.
 *
 * @param {object} props
 * @param {string|null} [props.src]
 * @param {string} [props.name]
 * @param {'xs'|'sm'|'md'|'lg'|'xl'} [props.size='md']
 * @param {boolean} [props.decorative] hide from screen readers when the name is shown next to it
 */
export function Avatar({ src, name = '', size = 'md', decorative = false, className }) {
  const [failedSrc, setFailedSrc] = useState(null)
  const showImage = Boolean(src) && failedSrc !== src
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name || 'User' }
  return (
    <span
      {...a11y}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-display font-bold',
        SIZES[size] ?? SIZES.md,
        !showImage && BACKGROUNDS[hash(name) % BACKGROUNDS.length],
        className,
      )}
    >
      {showImage ? (
        <img src={src} alt="" className="size-full object-cover" loading="lazy" onError={() => setFailedSrc(src)} />
      ) : (
        <span aria-hidden>{getInitials(name) || '?'}</span>
      )}
    </span>
  )
}

export default Avatar
