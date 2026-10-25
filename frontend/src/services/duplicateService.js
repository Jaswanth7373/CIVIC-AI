/**
 * Duplicate review endpoints (`/api/duplicates/`). Every function resolves to `response.data`.
 * Officers see pairs involving their assigned / department complaints; admins see all.
 */
import api from './api'

export const duplicateService = {
  /** Paginated `[{id, complaint, similar_complaint, *_similarity, distance_m, status, ...}]`. Filters: status, complaint. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/duplicates/', { params, ...config })
    return data
  },

  /** `{status: "confirmed_duplicate" | "not_duplicate", notes?}` -> the updated pair. */
  async review(id, data) {
    const { data: body } = await api.patch(`/duplicates/${id}/`, data)
    return body
  },
}

export default duplicateService
