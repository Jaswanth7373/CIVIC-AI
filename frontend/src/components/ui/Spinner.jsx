import { LoaderCircle } from 'lucide-react'
import { cn } from '@/utils/cn'

const SIZES = { xs: 'size-3.5', sm: 'size-4', md: 'size-5', lg: 'size-8', xl: 'size-10' }

/**
 * Spinning loader icon. Announces `label` to screen readers (role="status") unless `decorative`
 * (e.g. inside a Button that already sets aria-busy).
 * @param {{size?: 'xs'|'sm'|'md'|'lg'|'xl', label?: string, decorative?: boolean, className?: string}} props
 */
export function Spinner({ size = 'md', label = 'Loading', decorative = false, className }) {
  const icon = <LoaderCircle aria-hidden className={cn('animate-spin text-current', SIZES[size] ?? SIZES.md, className)} />
  if (decorative) return icon
  return (
    <span role="status" className="inline-flex items-center">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  )
}

export default Spinner
