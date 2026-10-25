/**
 * Officer endpoints (`/api/officers/*`). An officer's id is the user id. Every function resolves to `response.data`.
 */
import api from './api'

export const officerService = {
  /** Paginated `[OfficerOut]`. Filters: department, is_available, search. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/officers/', { params, ...config })
    return data
  },

  async get(id) {
    const { data } = await api.get(`/officers/${id}/`)
    return data
  },

  /**
   * Admin. `{email, password, first_name, last_name, phone, department, employee_id, designation, zone,
   * base_latitude, base_longitude, max_active_complaints, is_available, skills, joined_on}` creates the user
   * (role officer) and the officer profile.
   */
  async create(data) {
    const { data: body } = await api.post('/officers/', data)
    return body
  },

  /** Partial update; `password` is optional. */
  async update(id, data) {
    const { data: body } = await api.patch(`/officers/${id}/`, data)
    return body
  },

  /** Admin. Deactivates the officer account. */
  async remove(id) {
    const { data } = await api.delete(`/officers/${id}/`)
    return data
  },

  /** `{active, capacity, utilization, critical, by_status, complaints: [ComplaintList]}` */
  async workload(id) {
    const { data } = await api.get(`/officers/${id}/workload/`)
    return data
  },
}

export default officerService
