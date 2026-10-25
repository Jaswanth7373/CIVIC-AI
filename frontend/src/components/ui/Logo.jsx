import logoMarkUrl from '@/assets/logo-mark.svg'
import { cn } from '@/utils/cn'

/**
 * The CivicAI sign-panel mark: a highway-sign green panel with an inset white border (the `sign-panel`
 * treatment drawn as SVG so it stays crisp at every size), a white map-pin pictogram for "a reported place",
 * and one yellow road-marking dash - the product's lane-line motif. The drawing lives in src/assets/logo-mark.svg
 * (bundled; small enough that Vite inlines it, so it costs no request); public/favicon.svg is the same geometry
 * at a fixed URL for the browser tab, the web manifest and the service worker.
 *
 * @param {{size?: number, title?: string, className?: string}} props `title` makes it a labelled image
 */
export function LogoMark({ size = 32, title, className }) {
  return (
    <img
      src={logoMarkUrl}
      width={size}
      height={size}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      draggable={false}
      className={cn('shrink-0 select-none', className)}
    />
  )
}

const SIZES = {
  sm: { mark: 26, text: 'text-[17px]' },
  md: { mark: 32, text: 'text-xl' },
  lg: { mark: 44, text: 'text-[28px]' },
}

/**
 * CivicAI logo: sign-panel mark + "CivicAI" wordmark in Overpass (the typeface derived from US highway
 * sign lettering).
 *
 * @param {object} props
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {'full'|'mark'} [props.variant='full'] `mark` renders the panel only
 * @param {'default'|'inverse'} [props.tone='default'] `inverse` = white wordmark for the dark sidebar
 */
export function Logo({ size = 'md', variant = 'full', tone = 'default', className }) {
  const config = SIZES[size] ?? SIZES.md
  if (variant === 'mark') return <LogoMark size={config.mark} title="CivicAI" className={className} />
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={config.mark} />
      <span
        className={cn(
          'font-display font-extrabold leading-none tracking-tight',
          config.text,
          tone === 'inverse' ? 'text-white' : 'text-ink',
        )}
      >
        CivicAI
      </span>
    </span>
  )
}

export default Logo
