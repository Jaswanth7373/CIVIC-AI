/**
 * "Skip to content" link: the first focusable element on every page, visible only when focused, so keyboard
 * and screen-reader users can jump past the navigation straight to `#main-content`.
 */
export function SkipLink({ target = 'main-content' }) {
  return (
    <a
      href={`#${target}`}
      className="sr-only focus:not-sr-only focus:fixed focus:left-[max(1rem,env(safe-area-inset-left))] focus:top-[max(0.75rem,env(safe-area-inset-top))] focus:z-[100] focus:rounded-lg focus:bg-marking-500 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-asphalt-950"
    >
      Skip to content
    </a>
  )
}

export default SkipLink
