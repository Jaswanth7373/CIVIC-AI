/**
 * AI engine output -> the shapes the shared result components render (pure helpers, no React).
 *
 * - toPriorityBreakdown(priority): priority engine output, whose `components` are keyed by factor, -> the
 *   PriorityBreakdown shape `{final_score, priority_level, components: [{key, label, score, max, raw}], explanation}`
 *   (POST /ai/priority/ simulations, the `priority` of POST /ai/analyze/).
 * - toPrediction(analysis): POST /ai/analyze/ output -> the AIPrediction shape AIAnalysisPanel renders, mapped the
 *   way the backend maps it when it stores a prediction (apps/complaints/services/pipeline._persist_prediction).
 */

/** The priority engine's five factors in their documented order (severity first). */
export const PRIORITY_COMPONENT_ORDER = Object.freeze(['severity', 'public_impact', 'location_risk', 'frequency', 'duplicates'])

export function toPriorityBreakdown(priority) {
  if (!priority) return null
  const components = priority.components ?? {}
  const list = Array.isArray(components)
    ? components
    : PRIORITY_COMPONENT_ORDER.filter((key) => components[key]).map((key) => ({ key, ...components[key] }))
  return {
    final_score: priority.final_score,
    priority_level: priority.priority_level,
    components: list,
    explanation: priority.explanation,
  }
}

export function toPrediction(analysis) {
  if (!analysis) return null
  const vision = analysis.vision ?? {}
  const text = analysis.text ?? {}
  const fusion = analysis.fusion ?? {}
  const severity = analysis.severity ?? {}
  const versions = analysis.model_versions ?? {}
  return {
    image_category: vision.category ?? '',
    image_confidence: vision.confidence ?? null,
    text_category: text.category ?? '',
    text_confidence: text.confidence ?? null,
    final_category: analysis.category ?? null,
    final_category_slug: fusion.category || text.category || vision.category || '',
    multimodal_confidence: fusion.confidence ?? null,
    // The fusion engine's own verdict (agree / disagree / single_modality / none), read by AIAnalysisPanel.
    agreement: fusion.agreement ?? null,
    severity: severity.severity ?? '',
    severity_score: severity.score ?? null,
    severity_reason: severity.reason ?? '',
    severity_factors: severity.factors ?? {},
    detected_objects: vision.detected_objects ?? [],
    bounding_boxes: vision.bounding_boxes ?? [],
    keywords: text.keywords ?? [],
    impacts: text.impacts ?? [],
    probabilities: { image: vision.probabilities ?? {}, text: text.probabilities ?? {}, fused: fusion.probabilities ?? {} },
    modality_weights: fusion.weights ?? {},
    location_risk: analysis.location_risk ?? {},
    explanation: fusion.explanation ?? '',
    needs_review: Boolean(fusion.needs_review),
    model_mode: analysis.mode,
    is_demo: analysis.is_demo,
    model_version: `vision=${versions.vision || vision.model_version || 'none'}; text=${versions.text || text.model_version || 'none'}`,
    processing_time_ms: analysis.processing_time_ms ?? null,
  }
}
