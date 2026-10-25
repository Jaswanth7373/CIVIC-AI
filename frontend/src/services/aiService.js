/**
 * AI engine endpoints (`/api/ai/*`). Every function resolves to `response.data`.
 *
 * `analyze`, `classify` and the multipart forms of `duplicates` / `verifyResolution` run the engine without
 * writing to the database (previews and the model playground). AI calls use a long timeout because the first
 * request may load a model.
 */
import api, { AI_TIMEOUT_MS, buildFormData, toRequestBody } from './api'

const AI = { timeout: AI_TIMEOUT_MS }

export const aiService = {
  /** multipart `{image?, description, latitude?, longitude?, address?, category?}` -> full engine output + steps. */
  async analyze(formData) {
    const { data } = await api.post('/ai/analyze/', buildFormData(formData), AI)
    return data
  },

  /**
   * multipart `{image?, description?}` (at least one) -> `{vision, text, fusion, category, is_demo, mode}`.
   * `config` is passed to axios, e.g. `{ signal }` so a superseded live suggestion can be aborted.
   */
  async classify(formData, config = {}) {
    const { data } = await api.post('/ai/classify/', buildFormData(formData), { ...AI, ...config })
    return data
  },

  /**
   * Public live demo for the landing page - no account needed, nothing is stored. Multipart `{image?,
   * description?}` (at least one, description <= 1000 chars) -> `{vision, text, fusion, category, severity_hint:
   * {level, score, reason}, is_demo, mode, disclaimer, processing_time_ms}`. Rate limited (429 with Retry-After).
   */
  async demo(formData) {
    const { data } = await api.post('/ai/demo/', buildFormData(formData), {
      ...AI,
      skipAuth: true,
      skipAuthRefresh: true,
      skipAuthRedirect: true,
    })
    return data
  },

  /**
   * `{complaint_id}` recalculates and returns a PriorityBreakdown; or a what-if simulation
   * `{severity_score, public_impact, location_risk, nearby_count, frequency_count, duplicate_count, category?, weights?}`.
   */
  async priority(data) {
    const { data: body } = await api.post('/ai/priority/', data, AI)
    return body
  },

  /**
   * `{complaint_id}` re-runs detection -> `[DuplicateLink]`; or multipart `{description, latitude, longitude, image?}`.
   * `config` is passed to axios, e.g. `{ signal }` to abort a check that a newer one replaced.
   */
  async duplicates(dataOrFormData, config = {}) {
    const { data } = await api.post('/ai/duplicates/', toRequestBody(dataOrFormData), { ...AI, ...config })
    return data
  },

  /** multipart `{before_image, after_image, category?}` -> engine output; or `{complaint_id}` -> Verification. */
  async verifyResolution(dataOrFormData) {
    const { data } = await api.post('/ai/verify-resolution/', toRequestBody(dataOrFormData), AI)
    return data
  },

  /** `{text, rating?}` -> sentiment output (admin model playground). */
  async sentiment(data) {
    const { data: body } = await api.post('/ai/sentiment/', data, AI)
    return body
  },

  /** Model descriptions, registry statuses and the current AI configuration. */
  async modelInfo() {
    const { data } = await api.get('/ai/model-info/')
    return data
  },

  /** AIConfiguration fields (+ updated_by, updated_at). */
  async getConfig() {
    const { data } = await api.get('/ai/config/')
    return data
  },

  /**
   * Save the AI configuration (weights must sum to 100, thresholds ordered).
   * `{ recalculate: true }` also recalculates the priority of open complaints with the new weights.
   */
  async updateConfig(data, { recalculate = false } = {}) {
    const { data: body } = await api.put('/ai/config/', data, {
      params: recalculate ? { recalculate: 'true' } : undefined,
      timeout: recalculate ? AI_TIMEOUT_MS : undefined,
    })
    return body
  },
}

export default aiService
