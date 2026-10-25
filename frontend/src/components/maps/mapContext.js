/**
 * `InsideMapContext` is true for everything rendered as a child of BaseMap. Components that can live both on
 * and off a map (MapLegend) read it to decide between a Leaflet control and plain inline markup.
 */
import { createContext } from 'react'

export const InsideMapContext = createContext(false)
InsideMapContext.displayName = 'InsideMapContext'
