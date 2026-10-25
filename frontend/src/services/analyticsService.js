/**
 * Analytics endpoints (`/api/analytics/*`). Every number on every dashboard comes from these live queries.
 * Common filters: date_from, date_to (YYYY-MM-DD), department, category, severity, status.
 * Every function resolves to `response.data`, except `downloadReport`, which saves a file.
 */
import { format } from 'date-fns'
import { filenameFromContentDisposition, saveBlob } from '@/utils/download'
import api from './api'

const REPORT_TIMEOUT_MS = 120_000

/** "civicai-summary-report-2026-10-17.csv" - used when the server's filename header is not readable. */
function fallbackReportFilename({ report = 'summary', format: fileFormat = 'csv' }) {
  return `civicai-${report}-report-${format(new Date(), 'yyyy-MM-dd')}.${fileFormat}`
}

/**
 * With `responseType: 'blob'`, API error bodies arrive as Blobs too. Convert a JSON error Blob back into an
 * object so `getErrorMessage(error)` can show the server's `detail` message.
 */
async function restoreJsonErrorBody(error) {
  const data = error?.response?.data
  if (typeof Blob === 'undefined' || !(data instanceof Blob)) return
  try {
    const text = await data.text()
    error.response.data = JSON.parse(text)
  } catch {
    // Not JSON (e.g. an HTML error page): keep the Blob, the status-based message is used instead.
  }
}

export const analyticsService = {
  /** Role-aware dashboard (citizen / officer / admin shapes, see BUILD_SPEC 4.2). */
  async dashboard(params = {}) {
    const { data } = await api.get('/analytics/dashboard/', { params })
    return data
  },

  /** Admin overview: totals, distributions, histograms, recent critical complaints. */
  async overview(params = {}) {
    const { data } = await api.get('/analytics/overview/', { params })
    return data
  },

  async categories(params = {}) {
    const { data } = await api.get('/analytics/categories/', { params })
    return data
  },

  async departments(params = {}) {
    const { data } = await api.get('/analytics/departments/', { params })
    return data
  },

  /** `{period: 'day' | 'week' | 'month', days: 90}` -> series bucketed on the server. */
  async trends(params = {}) {
    const { data } = await api.get('/analytics/trends/', { params })
    return data
  },

  /** DBSCAN hotspot clusters + points + alerts. Extra params: eps_m, min_samples, days. */
  async hotspots(params = {}) {
    const { data } = await api.get('/analytics/hotspots/', { params })
    return data
  },

  async sentiment(params = {}) {
    const { data } = await api.get('/analytics/sentiment/', { params })
    return data
  },

  async officers(params = {}) {
    const { data } = await api.get('/analytics/officers/', { params })
    return data
  },

  /** AI performance: confidence, agreement, overrides, duplicates, verification, model info. */
  async ai(params = {}) {
    const { data } = await api.get('/analytics/ai/', { params })
    return data
  },

  /** Public landing-page statistics (no personal data, no login needed). */
  async publicStats() {
    const { data } = await api.get('/analytics/public/', { skipAuth: true })
    return data
  },

  /**
   * JSON preview of a report: `{report, title, generated_at, filters, columns, rows, summary}`.
   * `params.report`: summary | complaints | departments | officers | feedback (+ filters).
   */
  async report(params = {}) {
    const { data } = await api.get('/analytics/reports/', {
      params: { report: 'summary', ...params, format: 'json' },
      timeout: REPORT_TIMEOUT_MS,
    })
    return data
  },

  /**
   * Download a report file (`params.format`: csv | pdf, default csv) and trigger the browser download with
   * the filename from the Content-Disposition header. Resolves to `{filename, size, contentType}`.
   */
  async downloadReport(params = {}) {
    const query = { report: 'summary', format: 'csv', ...params }
    try {
      const response = await api.get('/analytics/reports/', {
        params: query,
        responseType: 'blob',
        timeout: REPORT_TIMEOUT_MS,
      })
      const header = response.headers?.['content-disposition']
      const filename = filenameFromContentDisposition(header) ?? fallbackReportFilename(query)
      const blob =
        response.data instanceof Blob
          ? response.data
          : new Blob([response.data], { type: response.headers?.['content-type'] || 'application/octet-stream' })
      saveBlob(blob, filename)
      return { filename, size: blob.size, contentType: blob.type }
    } catch (error) {
      await restoreJsonErrorBody(error)
      throw error
    }
  },

  /** Run the SLA check and hotspot scan now -> `{sla_alerts, hotspot_alerts}`. */
  async runChecks() {
    const { data } = await api.post('/analytics/run-checks/', {}, { timeout: REPORT_TIMEOUT_MS })
    return data
  },

  /** `[HotspotAlert]` */
  async alerts(params = {}) {
    const { data } = await api.get('/analytics/alerts/', { params })
    return data
  },

  /** Mark a hotspot alert as acknowledged (pass `false` to un-acknowledge). */
  async acknowledgeAlert(id, isAcknowledged = true) {
    const { data } = await api.patch(`/analytics/alerts/${id}/`, { is_acknowledged: isAcknowledged })
    return data
  },
}

export default analyticsService
