import { Star } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/utils/cn'

const SIZES = {
  sm: { icon: 'size-4', button: 'size-6' },
  md: { icon: 'size-6', button: 'size-9 pointer-coarse:size-11' },
  lg: { icon: 'size-8', button: 'size-11' },
}
const LABELS = ['Very poor', 'Poor', 'Okay', 'Good', 'Excellent']

/**
 * 1-5 star rating.
 * - Interactive (`onChange` given, not `readOnly`): a radio group - click / tap a star, or use the arrow
 *   keys; hovering previews the rating.
 * - Read-only: shows fractional values (e.g. an average of 3.6) by clipping the filled star, with an
 *   accessible "Rated 3.6 out of 5".
 *
 * @param {{value?: number, onChange?: (value: number) => void, readOnly?: boolean, size?: 'sm'|'md'|'lg', label?: string, className?: string}} props
 */
export function StarRating({ value = 0, onChange, readOnly = false, size = 'md', label = 'Rating', className }) {
  const [hovered, setHovered] = useState(0)
  const groupRef = useRef(null)
  const sizes = SIZES[size] ?? SIZES.md
  const interactive = !readOnly && typeof onChange === 'function'
  const numeric = Math.max(0, Math.min(5, Number(value) || 0))

  if (!interactive) {
    const text = Number.isInteger(numeric) ? numeric : numeric.toFixed(1)
    return (
      <span role="img" aria-label={`${label}: ${text} out of 5`} className={cn('inline-flex items-center gap-0.5', className)}>
        {[0, 1, 2, 3, 4].map((index) => {
          const fill = Math.max(0, Math.min(1, numeric - index))
          return (
            <span key={index} className="relative inline-flex" aria-hidden>
              <Star className={cn(sizes.icon, 'text-line-strong')} />
              {fill > 0 ? (
                <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                  <Star className={cn(sizes.icon, 'fill-marking-500 text-marking-500')} />
                </span>
              ) : null}
            </span>
          )
        })}
      </span>
    )
  }

  const shown = hovered || numeric
  const selectedValue = Math.round(numeric)

  const choose = (next) => {
    onChange(next)
    groupRef.current?.querySelector(`[data-star="${next}"]`)?.focus()
  }

  const handleKeyDown = (event) => {
    const current = selectedValue || 0
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      choose(Math.min(5, current + 1))
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      choose(Math.max(1, current - 1))
    } else if (event.key === 'Home') {
      event.preventDefault()
      choose(1)
    } else if (event.key === 'End') {
      event.preventDefault()
      choose(5)
    }
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      onPointerLeave={() => setHovered(0)}
      className={cn('inline-flex items-center gap-0.5', className)}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const active = star <= shown
        const isSelected = star === selectedValue
        return (
          <button
            key={star}
            type="button"
            role="radio"
            data-star={star}
            aria-checked={isSelected}
            aria-label={`${star} star${star > 1 ? 's' : ''}, ${LABELS[star - 1]}`}
            tabIndex={isSelected || (!selectedValue && star === 1) ? 0 : -1}
            onClick={() => choose(star)}
            onPointerEnter={() => setHovered(star)}
            className={cn('grid place-items-center rounded-md transition-[scale] duration-300 ease-spring-bounce hover:scale-115 active:scale-95', sizes.button)}
          >
            <Star
              aria-hidden
              className={cn(sizes.icon, 'transition-[fill,color] duration-150 ease-standard', active ? 'fill-marking-500 text-marking-500' : 'text-line-strong')}
            />
          </button>
        )
      })}
    </div>
  )
}

export default StarRating
