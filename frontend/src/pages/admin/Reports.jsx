/**
 * Reports (/admin/reports) - build a report from live data, preview it, download it as CSV or PDF, print it.
 *
 * - Report type (summary, complaints, departments, officers, feedback) and the filters (date range,
 *   department, category, status) live in the URL, so a report view can be bookmarked or shared.
 * - Preview: GET /analytics/reports/?format=json -> `{report, title, generated_at, filters, columns: [{key,
 *   label}], rows, summary_items: [{key, label, value}], total_rows, truncated}` (the first `limit` rows).
 * - Downloads: analyticsService.downloadReport({format: 'csv' | 'pdf'}) - the server renders the file with
 *   every row (CSV up to 50,000, PDF up to 1,500), names it, and records the export in the audit log.
 * - Print: window.print() on a print-friendly view (builder and app chrome hidden, table without scrolling).
 *
 * Motion: the summary figures are read by the AI scan and count up (KpiStrip); a finished download confirms
 * itself on its button - the icon becomes a tick for a moment (the button's name stays "Download CSV" / "Download
 * PDF") - next to the toast. Reduced motion: the tick simply appears.
 */
import { Check, FileSpreadsheet, FileText, Printer, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { FormField } from '@/components/ui/FormField'
import { IconButton } from '@/components/ui/IconButton'
import { PageHeader } from '@/components/ui/PageHeader'
import { RadioGroup } from '@/components/ui/RadioGroup'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { analyticsService } from '@/services/analyticsService'
import { cn } from '@/utils/cn'
import { REPORT_TYPES, getStatusMeta } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { formatDate, formatDateTime, formatFileSize, formatHours, formatNumber } from '@/utils/format'
import { InsightFilterBar } from './insights/InsightFilterBar'
import { FILTER_PARAM_KEYS, filterValidationError } from './insights/insightUtils'
import { InvalidFiltersAlert } from './insights/InvalidFiltersAlert'
import { KpiStrip } from './insights/KpiStrip'
import { ReportPreviewTable } from './insights/ReportPreviewTable'
import { useInsightFilters, useReferenceData } from './insights/useInsightFilters'

const FILTER_KEYS = ['date_from', 'date_to', 'department', 'category', 'status']

/*
 * Print stylesheet, active only while this page is mounted: reports print on landscape A4 (wide tables fit),
 * and the dashboard shell's left padding for the (hidden) sidebar is dropped so the report uses the page.
 */
const PRINT_CSS = String.raw`@media print {
  @page { size: A4 landscape; margin: 12mm; }
  .lg\:pl-64, .lg\:pl-\[76px\] { padding-left: 0 !important; }
  #main-content { max-width: none !important; padding: 0 !important; }
}`
const PREVIEW_LIMITS = [50, 100, 250, 500]
const DEFAULT_LIMIT = 100
const UNIT = /\s*\((%|h)\)\s*$/i
/** How long a finished download shows its tick (ms). */
const DONE_MS = 1800

const percentOneDecimal = (value) => `${formatNumber(value, { digits: 1 })}%`
const twoDecimals = (value) => formatNumber(value, { digits: 2 })

/** The download button's icon right after a finished download: a tick that pops in (aria-hidden like any icon). */
function DoneIcon({ className, ...props }) {
  return <Check {...props} className={cn(className, 'animate-pop-in')} strokeWidth={2.6} />
}

/**
 * A summary item `{label: "SLA compliance (%)", value: 75}` as a key figure ("SLA compliance", 75 written as
 * "75%"): numbers stay numbers so the board can count them up, written exactly as before.
 */
function summaryKpi(item) {
  const match = UNIT.exec(String(item.label ?? ''))
  const label = match ? item.label.replace(UNIT, '') : item.label
  const value = item.value
  if (typeof value === 'number') {
    if (match?.[1] === '%') return { key: item.key, label, value, format: percentOneDecimal }
    if (match?.[1]?.toLowerCase() === 'h') return { key: item.key, label, value: value || '—', format: formatHours }
    return { key: item.key, label, value, format: Number.isInteger(value) ? undefined : twoDecimals }
  }
  return { key: item.key, label, value: value ?? '—' }
}

/** The filters the server applied (its own echo), as readable chips. */
function appliedFilters(filters, departments, categories) {
  if (!filters) return []
  const chips = []
  if (filters.date_from || filters.date_to) {
    chips.push(
      filters.date_from && filters.date_to
        ? `Reported ${formatDate(filters.date_from)} to ${formatDate(filters.date_to)}`
        : filters.date_from
          ? `Reported from ${formatDate(filters.date_from)}`
          : `Reported until ${formatDate(filters.date_to)}`,
    )
  }
  if (filters.department) {
    const department = departments.find((item) => String(item.id) === String(filters.department))
    chips.push(`Department: ${department?.name ?? filters.department}`)
  }
  if (filters.category) {
    const category = categories.find(
      (item) => String(item.slug) === String(filters.category) || String(item.id) === String(filters.category),
    )
    chips.push(`Category: ${category?.name ?? filters.category}`)
  }
  if (Array.isArray(filters.status) && filters.status.length) {
    chips.push(`Status: ${filters.status.map((status) => getStatusMeta(status).label).join(', ')}`)
  }
  if (Array.isArray(filters.severity) && filters.severity.length) chips.push(`Severity: ${filters.severity.join(', ')}`)
  return chips
}

export default function Reports() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const { filters, params, setFilters, reset, activeCount } = useInsightFilters({ keys: FILTER_KEYS })
  const { departments, categories } = useReferenceData()
  const [downloading, setDownloading] = useState(null)
  const [downloaded, setDownloaded] = useState(null)

  useEffect(() => {
    if (!downloaded) return undefined
    const timer = window.setTimeout(() => setDownloaded(null), DONE_MS)
    return () => window.clearTimeout(timer)
  }, [downloaded])

  const reportParam = searchParams.get('report')
  const report = REPORT_TYPES.some((type) => type.value === reportParam) ? reportParam : 'summary'
  const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10)
  const limit = PREVIEW_LIMITS.includes(limitParam) ? limitParam : DEFAULT_LIMIT
  const reportMeta = REPORT_TYPES.find((type) => type.value === report) ?? REPORT_TYPES[0]

  const preview = useApi(() => analyticsService.report({ ...params, report, limit }), [params, report, limit])
  const data = preview.data
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const columns = Array.isArray(data?.columns) ? data.columns : []
  const kpis = (data?.summary_items ?? []).slice(0, 8).map(summaryKpi)
  const chips = appliedFilters(data?.filters, departments, categories)

  const setParam = (key, value) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value === null || value === undefined || value === '') next.delete(key)
        else next.set(key, String(value))
        return next
      },
      { replace: true },
    )

  const download = async (fileFormat) => {
    setDownloading(fileFormat)
    try {
      const result = await analyticsService.downloadReport({ ...params, report, format: fileFormat })
      toast.success('Report downloaded', `${result.filename} (${formatFileSize(result.size)})`)
      setDownloaded({ format: fileFormat, at: Date.now() })
    } catch (error) {
      toast.error('Could not download the report', getErrorMessage(error))
    } finally {
      setDownloading(null)
    }
  }

  const empty = data && !rows.length
  const invalidFilters = filterValidationError([preview.error], [...FILTER_PARAM_KEYS, 'report', 'limit'])
  const generatedAt = data?.generated_at ? formatDateTime(data.generated_at) : null

  return (
    <>
      <style>{PRINT_CSS}</style>
      <PageHeader
        className="print:hidden"
        title="Reports"
        description="Build a report from live data, check the preview, then download it as CSV or PDF, or print it."
        actions={
          <>
            <Button variant="ghost" leftIcon={Printer} onClick={() => window.print()} disabled={!rows.length}>
              Print
            </Button>
            <Button
              variant="outline"
              leftIcon={downloaded?.format === 'csv' ? DoneIcon : FileSpreadsheet}
              loading={downloading === 'csv'}
              disabled={Boolean(downloading) && downloading !== 'csv'}
              onClick={() => download('csv')}
            >
              Download CSV
            </Button>
            <Button
              leftIcon={downloaded?.format === 'pdf' ? DoneIcon : FileText}
              loading={downloading === 'pdf'}
              disabled={Boolean(downloading) && downloading !== 'pdf'}
              onClick={() => download('pdf')}
            >
              Download PDF
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start print:block">
        {/* Builder */}
        <Card className="print:hidden">
          <CardHeader title="Report builder" description="The preview updates as you change these." />
          <CardBody className="space-y-6">
            <RadioGroup
              label="Report type"
              name="report-type"
              options={REPORT_TYPES.map(({ value, label, description }) => ({ value, label, description }))}
              value={report}
              onChange={(value) => setParam('report', value === 'summary' ? '' : value)}
            />
            <div>
              <p className="mb-3 text-sm font-semibold text-ink">Filters</p>
              <InsightFilterBar
                layout="stacked"
                filters={filters}
                onChange={setFilters}
                onReset={reset}
                activeCount={activeCount}
                departments={departments}
                categories={categories}
                show={['date', 'department', 'category', 'status']}
              />
            </div>
            <FormField label="Preview rows" htmlFor="report-limit" hint="Downloads always include every row.">
              <Select
                id="report-limit"
                options={PREVIEW_LIMITS.map((value) => ({ value: String(value), label: `First ${value} rows` }))}
                value={String(limit)}
                onChange={(event) => setParam('limit', Number(event.target.value) === DEFAULT_LIMIT ? '' : event.target.value)}
              />
            </FormField>
          </CardBody>
        </Card>

        {/* Preview */}
        <Card className="min-w-0 print:border-0">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5 print:border-b-2 print:border-ink print:px-0">
            <div className="min-w-0">
              <p className="text-xs font-medium text-ink-3 print:hidden">Preview</p>
              <h2 className="font-display text-lg font-bold leading-snug text-ink print:text-2xl">
                {data?.title ?? `CivicAI - ${reportMeta.label} report`}
              </h2>
              <p className="mt-0.5 text-sm text-ink-2">
                {reportMeta.description}
                {generatedAt ? <span className="block text-xs text-ink-3">Generated {generatedAt} from live data</span> : null}
              </p>
            </div>
            <IconButton
              icon={RefreshCw}
              label="Refresh preview"
              variant="outline"
              size="sm"
              onClick={() => preview.refetch()}
              loading={preview.loading && Boolean(data)}
              className="print:hidden"
            />
          </div>

          <CardBody className="space-y-4 print:px-0">
            {chips.length ? (
              <ul aria-label="Applied filters" className="flex flex-wrap gap-1.5">
                {chips.map((chip) => (
                  <li
                    key={chip}
                    className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line print:ring-ink-3"
                  >
                    {chip}
                  </li>
                ))}
              </ul>
            ) : data ? (
              <p className="text-xs text-ink-3">No filters: every complaint and every department is included.</p>
            ) : null}

            {invalidFilters ? (
              <InvalidFiltersAlert error={invalidFilters} onReset={reset} />
            ) : preview.error && !data ? (
              <ErrorState compact error={preview.error} onRetry={preview.refetch} title="The preview could not load" />
            ) : (
              <>
                {kpis.length || (preview.loading && !data) ? (
                  <KpiStrip
                    items={kpis}
                    loading={preview.loading && !data}
                    label="Report summary"
                    className="print:break-inside-avoid"
                  />
                ) : null}

                {preview.loading && !data ? (
                  <Skeleton className="h-80 w-full" />
                ) : empty ? (
                  <EmptyState
                    icon={FileText}
                    title="Nothing to report for these filters"
                    description="Widen the date range or clear a filter to include more data."
                    action={
                      activeCount ? (
                        <Button variant="outline" onClick={reset}>
                          Clear filters
                        </Button>
                      ) : null
                    }
                  />
                ) : (
                  <div
                    className={preview.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}
                    aria-busy={preview.loading || undefined}
                  >
                    <ReportPreviewTable columns={columns} rows={rows} groupFirstColumn={report === 'summary'} />
                    <p className="mt-3 text-xs text-ink-3">
                      {data?.truncated
                        ? `Showing the first ${formatNumber(rows.length)} of ${formatNumber(data.total_rows)} rows. The CSV includes every row (up to 50,000) and the PDF up to 1,500.`
                        : `${formatNumber(rows.length)} row${rows.length === 1 ? '' : 's'}. Downloads contain exactly these rows.`}
                    </p>
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  )
}
