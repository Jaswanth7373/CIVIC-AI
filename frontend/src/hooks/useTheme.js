/**
 * Access the theme context: `{ theme ('light' | 'dark' | 'system'), resolvedTheme ('light' | 'dark'), isDark,
 * setTheme(theme, options?), toggleTheme(options?), themes }`.
 *
 * `options.origin` (a viewport point `{x, y}` or an element) is where the new theme's circular reveal starts,
 * usually the control that was used; without it the reveal starts near the top-right corner. The reveal only
 * runs where the View Transitions API exists and motion is welcome - otherwise the theme switches at once.
 */
import { useContext } from 'react'
import { ThemeContext } from '@/context/contexts'

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme() must be used inside <ThemeProvider>.')
  return context
}

export default useTheme
