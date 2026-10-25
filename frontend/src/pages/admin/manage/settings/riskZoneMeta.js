/**
 * Risk-zone presentation helpers. Risk level 1-5 is a magnitude, so it uses ONE hue (hazard orange) from
 * light to dark - a sequential scale, never a rainbow - and is always written out as "4/5" too.
 */
import { RISK_ZONE_TYPES } from '@/utils/constants'

export const RISK_LEVEL_COLORS = Object.freeze({
  1: '#fbc08a',
  2: '#f79c4f',
  3: '#e8730c',
  4: '#c25c06',
  5: '#984605',
})

export const RISK_LEVEL_LABELS = Object.freeze({
  1: 'Low',
  2: 'Moderate',
  3: 'Elevated',
  4: 'High',
  5: 'Very high',
})

export function riskColor(level) {
  return RISK_LEVEL_COLORS[Math.min(5, Math.max(1, Math.round(Number(level) || 1)))]
}

export function zoneTypeLabel(value) {
  return RISK_ZONE_TYPES.find((type) => type.value === value)?.label ?? value
}
