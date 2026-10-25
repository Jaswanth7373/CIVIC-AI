/**
 * PaginationBar - the shared <Pagination> with a local layout fix for its Previous / Next buttons.
 *
 * The shared component styles those buttons with `inline-grid`, which stacks the chevron and the
 * "Previous" / "Next" label on two rows from the sm breakpoint up. Until the component itself switches to
 * `inline-flex` (reported to its owner), this wrapper lays the two buttons out in one row. Props are passed
 * through unchanged.
 */
import { Pagination } from '@/components/ui/Pagination'

export function PaginationBar(props) {
  return (
    <div className="[&>nav>div>button]:inline-flex [&>nav>div>button]:items-center">
      <Pagination {...props} />
    </div>
  )
}

export default PaginationBar
