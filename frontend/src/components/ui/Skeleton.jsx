import { cn } from '@/utils/cn'

/**
 * Loading placeholder block. Size it with classes: `<Skeleton className="h-8 w-24" />`.
 * `lines` renders a stack of text-like bars (the last one shorter); `circle` makes it round.
 *
 * The `skeleton` utility (index.css) paints the sunken surface and sweeps one soft band of light across the
 * whole window - every placeholder on screen is crossed by the same pass, like the AI scan over the city.
 * With reduced motion the placeholders are still.
 */
export function Skeleton({ className, lines, circle = false }) {
  if (lines && lines > 1) {
    return (
      <div aria-hidden className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, index) => (
          <div key={index} className={cn('skeleton h-3.5 rounded-md', index === lines - 1 ? 'w-2/3' : 'w-full', className)} />
        ))}
      </div>
    )
  }
  return <div aria-hidden className={cn('skeleton', circle ? 'rounded-full' : 'rounded-md', className)} />
}

export default Skeleton
