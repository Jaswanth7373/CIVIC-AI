/**
 * Complaint endpoints (`/api/complaints/*`). Every function resolves to `response.data`.
 *
 * List scope is decided by the server from the user's role (citizen -> own, officer -> assigned or
 * `?scope=department`, admin -> all). Filters: status (comma list or array), category, severity,
 * priority_level, department, assigned_officer, citizen, date_from, date_to, is_overdue, has_duplicates,
 * needs_review, search, ordering, page, page_size.
 *
 * Endpoints that run the AI engine (create, resolve with an after photo, verify, reanalyze) use a longer
 * timeout. Multipart helpers accept FormData or a plain object (converted with `buildFormData`).
 * The optional trailing `config` is passed to axios (e.g. `{ signal }` or `{ onUploadProgress }`).
 */
import api, { AI_TIMEOUT_MS, buildFormData, toRequestBody } from './api'

const base = '/complaints/'
const detail = (id) => `/complaints/${id}/`
const action = (id, name) => `/complaints/${id}/${name}/`

export const complaintService = {
  /** Paginated ComplaintList. */
  async list(params = {}, config = {}) {
    const { data } = await api.get(base, { params, ...config })
    return data
  },

  /** ComplaintDetail (timeline, AI prediction, priority breakdown, assignments, evidence, allowed_actions...). */
  async get(id, config = {}) {
    const { data } = await api.get(detail(id), config)
    return data
  },

  /**
   * Submit a complaint (citizen). multipart: description, image?, latitude, longitude, address, landmark,
   * area, city, pincode, category?, title?, incident_at?. -> 201 ComplaintDetail + `analysis: {steps, summary}`.
   */
  async create(formData, config = {}) {
    const { data } = await api.post(base, buildFormData(formData), { timeout: AI_TIMEOUT_MS, ...config })
    return data
  },

  /** Partial update (citizen owner while editable / admin). A description change triggers re-analysis. */
  async update(id, data, config = {}) {
    const { data: body } = await api.patch(detail(id), toRequestBody(data), { timeout: AI_TIMEOUT_MS, ...config })
    return body
  },

  async remove(id) {
    const { data } = await api.delete(detail(id))
    return data
  },

  /** Non-paginated map points (max 3000), same filters as `list`. */
  async map(params = {}, config = {}) {
    const { data } = await api.get('/complaints/map/', { params, ...config })
    return data
  },

  /** `[TimelineEvent]` */
  async timeline(id, config = {}) {
    const { data } = await api.get(action(id, 'timeline'), config)
    return data
  },

  /** `[DuplicateLink]` */
  async duplicates(id, config = {}) {
    const { data } = await api.get(action(id, 'duplicates'), config)
    return data
  },

  /** Officer accepts the assignment. `{remarks?}` -> ComplaintDetail */
  async accept(id, data = {}) {
    const { data: body } = await api.post(action(id, 'accept'), data)
    return body
  },

  /** `{remarks}` (required) -> ComplaintDetail */
  async reject(id, data = {}) {
    const { data: body } = await api.post(action(id, 'reject'), data)
    return body
  },

  /** Officer starts work. `{remarks?}` -> ComplaintDetail */
  async start(id, data = {}) {
    const { data: body } = await api.post(action(id, 'start'), data)
    return body
  },

  /** `{status, remarks}` -> ComplaintDetail */
  async updateStatus(id, data = {}) {
    const { data: body } = await api.post(action(id, 'update-status'), data)
    return body
  },

  /** multipart `{remarks, after_image?}` -> ComplaintDetail (AI verification runs when an after image is sent). */
  async resolve(id, formData, config = {}) {
    const { data } = await api.post(action(id, 'resolve'), buildFormData(formData), {
      timeout: AI_TIMEOUT_MS,
      ...config,
    })
    return data
  },

  /** multipart `{before_image?, after_image?, remarks?}` (at least one image) -> 201 Evidence */
  async uploadEvidence(id, formData, config = {}) {
    const { data } = await api.post(action(id, 'evidence'), buildFormData(formData), config)
    return data
  },

  /** Run AI resolution verification -> Verification */
  async verify(id) {
    const { data } = await api.post(action(id, 'verify'), {}, { timeout: AI_TIMEOUT_MS })
    return data
  },

  /** `{status, score?, explanation}` -> Verification */
  async manualVerification(id, data = {}) {
    const { data: body } = await api.post(action(id, 'manual-verification'), data)
    return body
  },

  /** `{remarks?}` -> ComplaintDetail */
  async requestManualVerification(id, data = {}) {
    const { data: body } = await api.post(action(id, 'request-manual-verification'), data)
    return body
  },

  /** `{reason}` -> ComplaintDetail */
  async reopen(id, data = {}) {
    const { data: body } = await api.post(action(id, 'reopen'), data)
    return body
  },

  /** `{remarks}` -> TimelineEvent */
  async addRemark(id, data = {}) {
    const { data: body } = await api.post(action(id, 'remarks'), data)
    return body
  },

  /** Admin override. `{category?, severity?, priority_score?, reason}` -> ComplaintDetail */
  async overrideAI(id, data = {}) {
    const { data: body } = await api.post(action(id, 'override-ai'), data)
    return body
  },

  /** Re-run the AI pipeline (admin) -> ComplaintDetail + `analysis` */
  async reanalyze(id) {
    const { data } = await api.post(action(id, 'reanalyze'), {}, { timeout: AI_TIMEOUT_MS })
    return data
  },

  /** `{remarks?}` -> ComplaintDetail */
  async close(id, data = {}) {
    const { data: body } = await api.post(action(id, 'close'), data)
    return body
  },
}

export default complaintService
