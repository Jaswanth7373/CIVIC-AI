/**
 * AI engine parameters shown on the public explainer pages.
 *
 * Signed-in visitors see the LIVE values of this deployment: GET /api/ai/model-info/ (any authenticated user)
 * returns the current AIConfiguration under `config`. Guests cannot read that endpoint, so they see the
 * documented defaults below - the same defaults as `AIConfiguration` in backend/apps/core/models.py - and the
 * page says that they are defaults an administrator can tune.
 */
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { aiService } from '@/services/aiService'

export const DEFAULT_ENGINE_SETTINGS = Object.freeze({
  weight_severity: 40,
  weight_public_impact: 25,
  weight_location_risk: 15,
  weight_frequency: 10,
  weight_duplicates: 10,
  threshold_medium: 26,
  threshold_high: 51,
  threshold_critical: 76,
  image_modality_weight: 0.55,
  text_modality_weight: 0.45,
  min_category_confidence: 0.3,
  duplicate_threshold: 0.72,
  duplicate_radius_m: 300,
  duplicate_window_days: 30,
  duplicate_text_weight: 0.4,
  duplicate_image_weight: 0.3,
  duplicate_location_weight: 0.3,
  hotspot_eps_m: 400,
  hotspot_min_samples: 3,
  hotspot_alert_threshold: 5,
  verification_resolved_threshold: 70,
  verification_partial_threshold: 45,
  auto_assign_officer: true,
  auto_verify_resolution: true,
  nearby_radius_m: 500,
  frequency_window_days: 30,
  sla_alert_hours: 48,
})

/**
 * `{settings, source: 'live' | 'default', modelInfo, loading}`. `modelInfo` is the full /ai/model-info/
 * payload (models, components, registry, mode) for signed-in users, otherwise null.
 */
export function useEngineSettings() {
  const { isAuthenticated } = useAuth()
  const { data, loading } = useApi(() => (isAuthenticated ? aiService.modelInfo() : Promise.resolve(null)), [isAuthenticated])
  const live = data?.config && typeof data.config === 'object' ? data.config : null
  return {
    settings: { ...DEFAULT_ENGINE_SETTINGS, ...(live ?? {}) },
    source: live ? 'live' : 'default',
    modelInfo: data ?? null,
    loading: isAuthenticated && loading,
  }
}

/** 0.4 -> "0.40", 40 -> "40" (weights are shown the way the formulas use them). */
export function formatWeight(value, digits = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return Number.isInteger(number) ? String(number) : number.toFixed(digits)
}
