import { cn } from '@/utils/cn'

/**
 * The grab bar at the top of a bottom sheet (Modal / Drawer on phones): a short rounded pill in a 24px tall zone
 * that, with the sheet's header, starts the swipe-down-to-close drag (pass the `handleProps` of useSheetDrag).
 * Decorative for assistive technology - the close button and Esc remain the accessible ways out.
 */
export function SheetHandle({ className, style, ...props }) {
  return (
    <div
      aria-hidden
      className={cn('flex h-6 shrink-0 cursor-grab items-start justify-center pt-2.5 active:cursor-grabbing', className)}
      style={style}
      {...props}
    >
      <span className="h-1 w-10 rounded-full bg-line-strong" />
    </div>
  )
}

export default SheetHandle
