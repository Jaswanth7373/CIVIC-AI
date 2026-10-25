/**
 * Whether the app is switching theme under its circular view-transition reveal (ThemeContext sets
 * `data-view-transition="theme"` on <html> for the duration). The scenes then take the new palette at once instead
 * of easing to it: the browser captures the new page state in the frame right after the switch, so a scene that
 * snaps is revealed by the circle already in its new light; easing would finish ~1.5 s after the circle.
 * Without the API (an instant switch) the scenes keep their eased blend.
 */
export function themeRevealing() {
  return typeof document !== 'undefined' && document.documentElement.dataset.viewTransition === 'theme'
}
