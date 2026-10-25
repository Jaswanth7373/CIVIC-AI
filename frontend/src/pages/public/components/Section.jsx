/**
 * Layout primitives for the public (marketing) pages: the page-width container, a full-bleed section band and
 * the section heading. Marketing pages use a generous type scale (17-18 px body) on the concrete page colour;
 * alternate bands switch to the surface colour so long pages read as distinct stretches of road.
 *
 * Also used by the landing page sections: every prop keeps its meaning and default, new ones are opt-in.
 *
 * The public display scale (one for every public page; the fluid utilities are in index.css, section 4):
 * - page titles (h1): `display-lg` - on the inner pages' gantry sign, and on the auth and error pages, so no
 *   page title outranks another; the landing hero is the only larger heading (display-2xl);
 * - section titles (h2): `display-lg`, like the landing's sections - on the inner pages the sign's plate keeps
 *   the page title first;
 * - sub-sections (How it works stages, story chapters): `display-sm`.
 */
import { RevealHeading } from '@/components/motion/MaskReveal'
import { cn } from '@/utils/cn'

/** Centred page-width column with the site's side gutters. */
export function Container({ className, children }) {
  return <div className={cn('mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>
}

/**
 * Full-width band. `tone="surface"` gives the white / raised band, `"bg"` the concrete page colour.
 * `labelledBy` points at the section's heading id so landmarks are named for screen readers.
 */
export function Section({ id, tone = 'bg', labelledBy, className, containerClassName, children }) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        'scroll-mt-20 border-t border-line py-16 sm:py-20 lg:py-24',
        tone === 'surface' ? 'bg-surface' : 'bg-bg',
        className,
      )}
    >
      <Container className={containerClassName}>{children}</Container>
    </section>
  )
}

/** Page title (h1) of every public page except the landing hero. */
export const PAGE_TITLE_CLASS = 'display-lg'
/** Section title (h2) of the public pages. */
export const SECTION_TITLE_CLASS = 'display-lg text-ink'
/** Sub-section title (a numbered stage inside a section). */
export const SUBSECTION_TITLE_CLASS = 'display-sm text-ink'

const TITLE_CLASS = SECTION_TITLE_CLASS

/**
 * Section title (h2 by default) with an optional lead paragraph and actions. Left aligned: the page reads like
 * a sequence of signs along one edge, not a stack of centred posters.
 *
 * `reveal` (opt-in, string titles): the words rise from a mask the first time the heading enters the viewport
 * (display-heading reveal of the public pages; the plain heading with reduced motion). The heading keeps its
 * id, level, text and accessible name. The lead never animates.
 */
export function SectionHeading({ id, title, lead, actions, as: Title = 'h2', reveal = false, className, children }) {
  return (
    <div className={cn('flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between', className)}>
      <div className="min-w-0 max-w-2xl">
        {reveal && typeof title === 'string' ? (
          <RevealHeading as={Title} id={id} split="words" className={TITLE_CLASS}>
            {title}
          </RevealHeading>
        ) : (
          <Title id={id} className={TITLE_CLASS}>
            {title}
          </Title>
        )}
        {lead ? <p className="mt-3 text-[17px] leading-relaxed text-ink-2 sm:text-lg">{lead}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export default Section
