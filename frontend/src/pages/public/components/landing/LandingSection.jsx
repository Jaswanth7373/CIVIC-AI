/**
 * Layout primitives of the landing page: a full-bleed band and its display heading.
 *
 * Same contract as the public `Section` / `SectionHeading` (id, tone, labelledBy, lead, actions), with the
 * landing's cinematic type: the title is a fluid display heading whose words rise out of a mask the first time
 * it enters the viewport (RevealHeading from the motion system). The lead paragraph and every other piece of
 * body copy never animate on their own. With reduced motion the heading is plain text.
 *
 * The feature sections are told in three acts (LandingPage), and each act has its own composition, so the page
 * keeps a rhythm instead of repeating one template:
 * - one continuous ground per act: the act's later sections are `joined` to the one before (no hairline and no
 *   change of band; a dashed lane marking runs between them instead);
 * - heading layouts: `stack` (heading over lead, left), `spread` (heading left, lead right, on one baseline: the
 *   editorial spreads of acts 1 and 3) and `center` (the overhead signs of act 2, at a larger size);
 * - `tone="night"`: a full-bleed asphalt band in both themes, with a lane line along its top, whose contents use the dark
 *   tokens (the `dark` class scopes them), for the act's full-bleed moment.
 *
 * The heading keeps its exact accessible name ("How CivicAI Works"): RevealHeading keeps the spaces between
 * the word elements.
 */
import { RevealHeading } from '@/components/motion/MaskReveal'
import { cn } from '@/utils/cn'
import { Container } from '../Section'

const TONES = {
  bg: 'bg-bg',
  surface: 'bg-surface',
  night: 'landing-night dark text-ink',
}

/**
 * Full-width band. `tone="surface"` gives the raised band, `"bg"` the concrete page colour, `"night"` the asphalt
 * band. `joined` continues the previous section of the same act on the same ground. `overflow-x-clip` clips
 * horizontal overflow without creating a scroll container (sticky children keep working).
 */
export function LandingSection({ id, tone = 'bg', joined = false, labelledBy, className, containerClassName, children }) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        'landing-defer relative scroll-mt-16 overflow-x-clip py-20 sm:py-24 lg:py-28',
        joined ? 'pt-0 sm:pt-0 lg:pt-0' : tone !== 'night' && 'border-t border-line',
        TONES[tone] ?? TONES.bg,
        className,
      )}
    >
      {joined ? (
        <Container>
          <span aria-hidden className="landing-junction mb-20 block sm:mb-24 lg:mb-28" />
        </Container>
      ) : null}
      <Container className={containerClassName}>{children}</Container>
    </section>
  )
}

const SIZES = { md: 'display-md', lg: 'display-lg', xl: 'display-xl' }

/**
 * Section title (h2) with an optional lead and actions.
 * - layout `stack` (default): left aligned like a run of signs along one edge, actions at the right;
 * - layout `spread`: the heading on the left, the lead (and actions) on the right, on a shared baseline;
 * - layout `center`: centred like a sign over the lanes, actions under the lead.
 * `size`: `md` where the content is dense, `lg` for the headline sections, `xl` for the centred act-2 signs.
 */
export function LandingHeading({ id, title, lead, actions, as = 'h2', size = 'lg', layout = 'stack', className, children }) {
  const heading = (
    <RevealHeading as={as} id={id} split="words" className={cn('text-ink', SIZES[size] ?? SIZES.lg)}>
      {title}
    </RevealHeading>
  )

  if (layout === 'center') {
    return (
      <div className={cn('mx-auto flex max-w-4xl flex-col items-center text-center', className)}>
        {heading}
        {lead ? <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-ink-2 sm:text-lg">{lead}</p> : null}
        {children}
        {actions ? <div className="mt-7 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
      </div>
    )
  }

  if (layout === 'spread') {
    return (
      <div className={cn('grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-end lg:gap-16', className)}>
        <div className="min-w-0">{heading}</div>
        <div className="min-w-0 lg:pb-1.5">
          {lead ? <p className="max-w-2xl text-[17px] leading-relaxed text-ink-2 sm:text-lg">{lead}</p> : null}
          {children}
          {actions ? <div className="mt-5 flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between', className)}>
      <div className="min-w-0 max-w-3xl">
        {heading}
        {lead ? <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-2 sm:text-lg">{lead}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 lg:pb-1.5">{actions}</div> : null}
    </div>
  )
}

export default LandingSection
