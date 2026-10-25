/**
 * ChartCard <-> chart wrapper wiring.
 *
 * ChartCard provides `{height, view, register, caption}`:
 * - `height`: the plot height requested on the card (undefined -> each chart uses its own default);
 * - `view`: 'chart' | 'table' - the card's chart / table toggle (the table is every chart's accessible twin);
 * - `caption`: the card title, the default accessible name of the chart and its table;
 * - `register(hasData, hasTable)`: a chart announces itself, whether it has data and whether it can render a
 *   table twin, so the card knows when to offer the table toggle and whether a refetch can keep the
 *   previous chart on screen instead of a skeleton.
 *
 * Two page-level switches, provided around a group of charts:
 * - ChartEntranceContext (default true): whether the charts play their entrance (bars rising, lines drawing,
 *   meters growing) when first seen. A page coming back in the same session provides `false`: its charts are
 *   drawn in their final state at once and only later data changes animate.
 * - ChartErrorModeContext (default 'full'): how a chart card shows a failed request - 'full' (the road-works
 *   error with "Try again") or 'quiet' (a muted placeholder, when the page already shows ONE error with one
 *   retry for all of its requests).
 */
import { createContext, useContext, useEffect } from 'react'

export const ChartCardContext = createContext(null)
ChartCardContext.displayName = 'ChartCardContext'

export const ChartEntranceContext = createContext(true)
ChartEntranceContext.displayName = 'ChartEntranceContext'

export const ChartErrorModeContext = createContext('full')
ChartErrorModeContext.displayName = 'ChartErrorModeContext'

/** The surrounding ChartCard's context, or null when the chart is used on its own. */
export function useChartCard() {
  return useContext(ChartCardContext)
}

/**
 * Accessible name for a chart's SVG (`<title>`): the chart's own `caption`, else its string `title`, else the
 * title of the ChartCard it sits in - charts placed in a titled card usually get no title of their own.
 */
export function useChartCaption(caption, title) {
  const card = useChartCard()
  return caption ?? (typeof title === 'string' ? title : undefined) ?? card?.caption
}

/** Register a chart with its ChartCard while mounted (no-op without a card). */
export function useChartRegistration(card, hasData, hasTable = true) {
  const register = card?.register
  useEffect(() => {
    if (!register) return undefined
    return register(Boolean(hasData), Boolean(hasTable))
  }, [register, hasData, hasTable])
}
