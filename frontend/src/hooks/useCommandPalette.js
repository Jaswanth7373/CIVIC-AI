/**
 * Open the command palette from anywhere inside the dashboard shell:
 *   const palette = useCommandPalette()
 *   <button onClick={palette.open}>Search</button>   // palette.shortcut is "Ctrl K" or "⌘K"
 *
 * Outside the shell (public pages, tests) it returns an inert stand-in with `available: false`, so callers can
 * hide their trigger instead of checking for null.
 */
import { useContext } from 'react'
import { CommandPaletteContext } from '@/components/command/paletteContext'

const UNAVAILABLE = Object.freeze({
  available: false,
  isOpen: false,
  shortcut: '',
  open: () => {},
  close: () => {},
  toggle: () => {},
})

export function useCommandPalette() {
  return useContext(CommandPaletteContext) ?? UNAVAILABLE
}

export default useCommandPalette
