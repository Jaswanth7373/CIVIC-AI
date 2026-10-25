/**
 * ActBand - a full-bleed junction between the landing's three acts (Understand, Decide, Close the loop), so the
 * eight feature sections read as one story with a rhythm instead of a long run of identical bands.
 *
 * A night band in both themes (like the closing band): an oversized act numeral outlined in road-marking yellow,
 * the act's name at display scale, one line on what the act shows, and its sections as small direction signs
 * (in-page links). A lane line crosses the band and is drawn in once as it enters the window. Reduced motion: the
 * line is simply there. The text only describes what follows - no figures.
 *
 * Not a landmark or a heading: the sections that follow keep the page's heading structure (h2 each).
 *
 * Props: number (1-3), total (3), title, lead, sections ([{ id, title }]: the in-page targets, in order).
 */
import { motion } from 'framer-motion'
import { ArrowDownRight } from 'lucide-react'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { Container } from '../Section'

export function ActBand({ number, total = 3, title, lead, sections = [] }) {
  const reduced = usePrefersReducedMotion()
  return (
    <div className="act-band landing-defer relative isolate overflow-hidden text-white">
      <Container className="relative grid gap-y-5 pb-20 pt-14 sm:pb-24 sm:pt-16 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-x-16 lg:pb-28 lg:pt-20">
        <p aria-hidden className="act-numeral font-display font-black tabular">
          {String(number).padStart(2, '0')}
        </p>
        <div className="min-w-0 max-w-3xl">
          <p className="font-display text-[13px] font-bold uppercase tracking-[0.2em] text-marking-400">
            Act {number} of {total}
          </p>
          <p className="display-xl mt-2 text-white">{title}</p>
          <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-asphalt-300 sm:text-lg">{lead}</p>
          <ul className="mt-7 flex flex-wrap gap-2.5">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="act-sign inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3.5 py-1.5 font-display text-sm font-bold text-white transition-[background-color,transform] duration-200 ease-standard hover:-translate-y-px pointer-coarse:min-h-11"
                >
                  {section.title}
                  <ArrowDownRight aria-hidden className="size-4 opacity-80" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Container>

      <motion.span
        aria-hidden
        className="act-lane"
        initial={reduced ? false : { scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, amount: 1 }}
        transition={{ duration: 1.2, ease: EASE.enter }}
      />
    </div>
  )
}

export default ActBand
