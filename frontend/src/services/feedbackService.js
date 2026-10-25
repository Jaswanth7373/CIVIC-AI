/**
 * Citizen feedback endpoints (`/api/feedback/*`). Every function resolves to `response.data`.
 * Submitted text is sentiment-analysed on the server.
 */
import api from './api'

export const feedbackService = {
  /** Citizen. `{complaint, rating (1-5), text?}` -> 201 Feedback + `{suggest_reopen}`. */
  async submit(data) {
    const { data: body } = await api.post('/feedback/', data)
    return body
  },

  /** Paginated `[Feedback]`. Filters: sentiment, rating, department, category, complaint, date_from, date_to. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/feedback/', { params, ...config })
    return data
  },

  /** Citizen. Complaints waiting for feedback: `[{complaint: ComplaintMini, resolved_at}]`. */
  async pending() {
    const { data } = await api.get('/feedback/pending/')
    return data
  },
}

export default feedbackService
