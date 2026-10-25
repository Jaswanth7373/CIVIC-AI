/**
 * Context object of the command palette (kept apart from its provider, so React Fast Refresh can hot-swap the
 * component files). Value: `{ available: true, isOpen, open(), close(), toggle(), shortcut }`.
 */
import { createContext } from 'react'

export const CommandPaletteContext = createContext(null)
CommandPaletteContext.displayName = 'CommandPaletteContext'
