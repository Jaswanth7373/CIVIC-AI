import { cn } from '@/utils/cn'

/**
 * A keyboard key, as printed on a keycap: `<Kbd>Esc</Kbd>`, `<Kbd>Ctrl K</Kbd>`. Used for shortcut hints (the
 * command palette, the topbar search). Purely visual: a control's accessible name should spell the shortcut
 * out itself (e.g. aria-keyshortcuts), so hints can be hidden from assistive technology.
 *
 * @param {{className?: string, children: import('react').ReactNode}} props
 */
export function Kbd({ className, children, ...props }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-surface px-1.5',
        'font-sans text-[11px] font-semibold leading-none text-ink-3 shadow-[inset_0_-1px_0_var(--c-line-strong)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  )
}

export default Kbd
