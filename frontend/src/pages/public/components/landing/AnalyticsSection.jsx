/**
 * "Smart City Analytics" - a small live preview of what administrators see, built only from public data:
 * GET /api/analytics/public/ (totals, resolution rate, average resolution time, officers, recently resolved
 * complaints) and GET /api/categories/ (`complaint_count` per category, drawn in each category's colour).
 *
 * Composition (the close of act 3): the four live figures at display scale - the one place on the page where
 * numbers are the picture - over a hairline, then the category chart and the latest fixes.
 *
 * Choreography: the figures count up the first time they are seen, the category bars grow from the baseline
 * when the chart scrolls into view (CategoryVolumeChart, in a space of its final height, so nothing shifts), and
 * the latest fixes arrive one after another. Reduced motion: everything final at once.
 *
 * Loaded lazily by the landing page, so the hero stays light.
 */
import { CircleCheck, LayoutDashboard } from 'lucide-react'
import { ChartCard } from '@/components/charts/ChartCard'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { CountUp } from '@/components/motion/CountUp'
import { Stagger, StaggerItem } from '@/components/motion/Stagger'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/utils/cn'
import { formatDate, formatHours, formatNumber, timeAgo } from '@/utils/format'
import { CategoryVolumeChart } from './CategoryVolumeChart'
import { LandingHeading, LandingSection } from './LandingSection'

const whole = (value) => formatNumber(value)

/** A figure from the API as a finite number, or null (shown as a dash). */
const toFigure = (value) => {
  const number = Number(value)
  return value == null || !Number.isFinite(number) ? null : number
}

/**
 * One live figure at display scale: the value (counting up once), its label and an optional note. A lane-marking
 * dash stands before every figure but the first in its row (styles/landing.css: a <dl> group holds only dt / dd).
 * `meter` (0-1) draws a thin bar under the note, the resolution rate that the note states in words.
 */
function BigFigure({ value, format, label, hint, meter, loading, className }) {
  return (
    <div className={cn('analytics-figure relative flex min-w-0 flex-col-reverse justify-end', className)}>
      <dt className="mt-3 text-sm font-medium leading-snug text-ink-2 sm:text-[15px]">
        {label}
        {hint ? <span className="mt-0.5 block text-[13px] font-normal text-ink-3">{hint}</span> : null}
        {meter != null && Number.isFinite(meter) ? (
          <span aria-hidden className="mt-2.5 block h-1 w-full max-w-[9rem] overflow-hidden rounded-full bg-sunken">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(1, Math.max(0, meter)) * 100}%` }} />
          </span>
        ) : null}
      </dt>
      <dd className="analytics-value whitespace-nowrap font-display font-black leading-[0.9] tracking-tight text-ink tabular">
        {loading ? (
          <Skeleton className="h-[0.9em] w-[2.2em]" />
        ) : value != null ? (
          <CountUp value={value} format={format} />
        ) : (
          '—'
        )}
      </dd>
    </div>
  )
}

function RecentlyResolved({ items, loading }) {
  if (loading && !items) {
    return (
      <div aria-hidden className="space-y-4 p-5">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-5 w-40" />
          </div>
        ))}
      </div>
    )
  }
  if (!items?.length) {
    return (
      <EmptyState
        compact
        bordered={false}
        icon={CircleCheck}
        title="No resolved complaints yet"
        description="Resolved complaints appear here as soon as officers close them."
      />
    )
  }
  return (
    <Stagger as="ol" className="divide-y divide-line" step={0.07}>
      {items.map((item, index) => (
        <StaggerItem as="li" key={item.complaint_number} index={index} className="px-4 py-3.5 sm:px-5">
          <p className="text-sm font-semibold leading-snug text-ink">{item.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-3">
            <CategoryBadge category={item.category} size="sm" />
            {item.area ? <span>{item.area}</span> : null}
            <time dateTime={item.resolved_at} title={formatDate(item.resolved_at)}>
              Resolved {timeAgo(item.resolved_at)}
            </time>
          </div>
          <p className="mt-1 text-[11px] text-ink-3">{item.complaint_number}</p>
        </StaggerItem>
      ))}
    </Stagger>
  )
}

export default function AnalyticsSection({ stats, statsLoading, statsError, onRetryStats, categories, categoriesLoading, categoriesError, onRetryCategories }) {
  const { isAuthenticated, homePath } = useAuth()
  const rate = Number(stats?.resolution_rate)
  const loadingStats = statsLoading && !stats
  const chartRows = (Array.isArray(categories) ? categories : []).map((category) => ({
    id: category.id,
    name: category.name,
    color: category.color,
    complaint_count: category.complaint_count ?? 0,
  }))
  const hasComplaints = chartRows.some((row) => row.complaint_count > 0)

  return (
    <LandingSection id="smart-city-analytics" labelledBy="analytics-title" tone="surface" joined>
      <LandingHeading
        id="analytics-title"
        title="Smart City Analytics"
        lead="Administrators see the whole city at once: live dashboards, DBSCAN hotspot maps, department scorecards and exportable reports. This preview is live too."
        actions={
          <Button to={isAuthenticated ? homePath : '/login'} leftIcon={LayoutDashboard} variant="outline">
            Explore Dashboard
          </Button>
        }
      />

      {statsError && !stats ? (
        <ErrorState className="mt-12" title="Live numbers could not load" error={statsError} onRetry={onRetryStats} />
      ) : (
        <dl className="mt-14 grid grid-cols-2 gap-x-6 gap-y-10 border-b border-line pb-12 sm:mt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-x-10 lg:pb-14">
          <BigFigure label="Complaints reported" value={toFigure(stats?.total_complaints)} format={whole} loading={loadingStats} />
          <BigFigure
            label="Resolved"
            value={toFigure(stats?.resolved_complaints)}
            format={whole}
            loading={loadingStats}
            hint={Number.isFinite(rate) ? `${formatNumber(rate, { digits: 1 })}% resolution rate` : undefined}
            meter={Number.isFinite(rate) ? rate / 100 : null}
          />
          <BigFigure
            label="Average time to resolve"
            value={toFigure(stats?.avg_resolution_hours)}
            format={formatHours}
            loading={loadingStats}
          />
          <BigFigure
            label="Field officers"
            value={toFigure(stats?.active_officers)}
            format={whole}
            loading={loadingStats}
            hint={stats ? `${formatNumber(stats.departments)} departments, ${formatNumber(stats.citizens)} citizens` : undefined}
          />
        </dl>
      )}

      <div className="mt-12 grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <ChartCard
          title="Complaints by category"
          description="Every complaint ever reported, by the category the AI or an administrator settled on."
          loading={categoriesLoading && !categories}
          error={categoriesError && !categories ? categoriesError : null}
          onRetry={onRetryCategories}
          empty={!categoriesLoading && !categoriesError && !hasComplaints}
          emptyTitle="No complaints yet"
          emptyDescription="Categories fill up as citizens report issues."
        >
          <CategoryVolumeChart rows={chartRows} />
        </ChartCard>

        <section aria-labelledby="recent-resolved-title" className="min-w-0 rounded-xl border border-line bg-surface">
          <div className="border-b border-line px-4 py-3.5 sm:px-5">
            <h3 id="recent-resolved-title" className="font-display text-base font-bold text-ink">
              Recently resolved
            </h3>
            <p className="mt-0.5 text-sm text-ink-2">The latest fixes, without any personal details.</p>
          </div>
          {statsError && !stats ? (
            <ErrorState compact bordered={false} title="Could not load" error={statsError} onRetry={onRetryStats} />
          ) : (
            <RecentlyResolved items={stats?.recent_resolved ?? null} loading={statsLoading} />
          )}
        </section>
      </div>
    </LandingSection>
  )
}
