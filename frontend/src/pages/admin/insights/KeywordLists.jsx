/**
 * KeywordLists - the words and phrases citizens use most in positive and in negative feedback
 * (GET /analytics/sentiment/ `top_keywords` `{positive: [{keyword, count}], negative: [{keyword, count}]}`,
 * at most ten each; sentiment-lexicon opinion phrases merged with extracted keywords, including Hinglish).
 *
 * Two ranked lists side by side (stacked on phones), each bar in its sentiment colour on one scale per list,
 * with the count printed - the list is its own accessible table.
 *
 * Props:
 * - keywords: the `top_keywords` object
 * - className
 *
 * Motion: each list's bars grow to their counts one after another when first seen.
 */
import { Frown, Smile } from 'lucide-react'
import { GrowBar } from '@/components/charts'
import { STAGGER } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { SENTIMENT_META } from '@/utils/constants'
import { formatNumber } from '@/utils/format'

function KeywordList({ title, icon: Icon, items, color, emptyText }) {
  const list = Array.isArray(items) ? items.filter((item) => item?.keyword) : []
  const max = Math.max(1, ...list.map((item) => Number(item.count) || 0))
  return (
    <section className="min-w-0">
      <h3 className="mb-3 flex items-center gap-2 font-display text-sm font-bold text-ink">
        <Icon aria-hidden className="size-4 text-ink-3" />
        {title}
      </h3>
      {list.length ? (
        <ol className="space-y-2">
          {list.map((item, index) => {
            const count = Number(item.count) || 0
            return (
              <li
                key={`${item.keyword}-${index}`}
                className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2rem] items-center gap-3 text-sm"
              >
                <span className="truncate text-ink" title={item.keyword}>
                  {item.keyword}
                </span>
                <GrowBar
                  ratio={count / max}
                  color={color}
                  delay={Math.min(index, STAGGER.max) * STAGGER.step * 1000}
                  className="h-2"
                />
                <span className="text-right font-semibold text-ink tabular">
                  {formatNumber(count)}
                  <span className="sr-only"> mentions</span>
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-sm text-ink-3">{emptyText}</p>
      )}
    </section>
  )
}

export function KeywordLists({ keywords, className }) {
  return (
    <div className={cn('grid gap-8 md:grid-cols-2', className)}>
      <KeywordList
        title="What citizens praise"
        icon={Smile}
        items={keywords?.positive}
        color={SENTIMENT_META.positive.color}
        emptyText="No positive comments with text in this view yet."
      />
      <KeywordList
        title="What citizens complain about"
        icon={Frown}
        items={keywords?.negative}
        color={SENTIMENT_META.negative.color}
        emptyText="No negative comments with text in this view. A good sign."
      />
    </div>
  )
}

export default KeywordLists
