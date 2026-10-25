/**
 * System / core endpoints: public config, risk zones, contact messages, geocoding proxy and audit logs.
 * Every function resolves to `response.data`.
 */
import api from './api'

export const systemService = {
  /**
   * Public app configuration: `{app_name, version, model_mode, is_demo, demo_badge, map: {center, zoom, city},
   * upload: {max_image_mb, allowed_extensions}, reopen_window_days, statuses, levels}`.
   */
  async config() {
    const { data } = await api.get('/system/config/', { skipAuth: true })
    return data
  },

  /** Admin-defined sensitive places used by the location-risk factor (non-paginated). */
  async riskZones(params = {}) {
    const { data } = await api.get('/risk-zones/', { params })
    return data
  },

  async createRiskZone(data) {
    const { data: body } = await api.post('/risk-zones/', data)
    return body
  },

  async updateRiskZone(id, data) {
    const { data: body } = await api.patch(`/risk-zones/${id}/`, data)
    return body
  },

  async deleteRiskZone(id) {
    const { data } = await api.delete(`/risk-zones/${id}/`)
    return data
  },

  /** Public contact form: `{name, email, subject, message}` -> 201. */
  async contact(data) {
    const { data: body } = await api.post('/contact/', data, { skipAuth: true })
    return body
  },

  /** Admin. Paginated contact messages. */
  async contactMessages(params = {}) {
    const { data } = await api.get('/contact/', { params })
    return data
  },

  /** Admin. `{is_resolved}` */
  async updateContactMessage(id, data) {
    const { data: body } = await api.patch(`/contact/${id}/`, data)
    return body
  },

  /** Address for coordinates (Nominatim proxy) -> `{address, area, city, pincode, display_name, source}`. */
  async reverseGeocode(lat, lng) {
    const { data } = await api.get('/geo/reverse/', { params: { lat, lng }, skipAuth: true })
    return data
  },

  /** Place search -> `[{display_name, latitude, longitude, address, area, city, pincode}]`. */
  async searchPlaces(q, config = {}) {
    const { data } = await api.get('/geo/search/', { params: { q }, skipAuth: true, ...config })
    return data
  },

  /** Admin. Paginated audit trail. Filters: action, entity_type, actor, date_from, date_to, search. */
  async auditLogs(params = {}) {
    const { data } = await api.get('/audit-logs/', { params })
    return data
  },
}

export default systemService
