import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { hasOpenLayers } from '@/components/ui/overlay'
import { CommandPalette } from './CommandPalette'
import { shortcutLabel } from './commands'
import { CommandPaletteContext } from './paletteContext'

/**
 * Provides the command palette to the dashboard shell: renders it, opens / closes it with Ctrl+K (⌘K on
 * Apple devices) from anywhere - also while typing in a field - and exposes `useCommandPalette()` for visible
 * triggers (the topbar search).
 *
 * The shortcut is ignored while another dialog, drawer or menu is open (its own keyboard handling comes first).
 * A chosen page or complaint is navigated to at once while the palette fades out; actions that change the
 * whole screen (the theme reveal) run after it has gone, so they start from a clear page.
 */
export function CommandPaletteProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false)
  const navigate = useNavigate()
  const afterCloseRef = useRef(null)
  const isOpenRef = useRef(isOpen)

  useEffect(() => {
    isOpenRef.current = isOpen
  }, [isOpen])

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((current) => !current), [])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key?.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.isComposing || event.repeat) return
      if (!isOpenRef.current && hasOpenLayers()) return
      event.preventDefault()
      setIsOpen((current) => !current)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const run = useCallback(
    (command) => {
      setIsOpen(false)
      if (command.to) navigate(command.to)
      else if (command.afterClose) afterCloseRef.current = command.perform
      else command.perform?.()
    },
    [navigate],
  )

  const handleExitComplete = useCallback(() => {
    const pending = afterCloseRef.current
    afterCloseRef.current = null
    pending?.()
  }, [])

  const value = useMemo(
    () => ({ available: true, isOpen, open, close, toggle, shortcut: shortcutLabel() }),
    [isOpen, open, close, toggle],
  )

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette open={isOpen} onClose={close} onRun={run} onExitComplete={handleExitComplete} />
    </CommandPaletteContext.Provider>
  )
}

export default CommandPaletteProvider
