/**
 * Officer assignment endpoints (`/api/assignments/*`). Every function resolves to `response.data`.
 */
import api from './api'

export const assignmentService = {
  /** Paginated `[Assignment]` (admin: all, officer: own). Filters: complaint, officer, is_active. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/assignments/', { params, ...config })
    return data
  },

  /** Admin. `{complaint, officer, notes?}` -> 201 Assignment (a reassignment when one is already active). */
  async assign(data) {
    const { data: body } = await api.post('/assignments/', data)
    return body
  },

  /** Admin. `{officer, notes?}` -> the new Assignment. */
  async reassign(id, data) {
    const { data: body } = await api.patch(`/assignments/${id}/`, data)
    return body
  },

  /**
   * Ranked officer recommendations for a complaint:
   * `[{officer, score, workload, capacity, utilization, distance_km, is_available, same_department, reasons, recommended}]`
   */
  async recommend(complaintId, limit = 5) {
    const { data } = await api.get('/assignments/recommend/', { params: { complaint: complaintId, limit } })
    return data
  },
}

export default assignmentService
