/**
 * Column override for the citizen complaint tables: one "Complaint" cell with the number, the title as the
 * link to the complaint, and the area underneath.
 *
 * Why: browsers ignore max-width on table cells in automatic table layout, so long titles and addresses in
 * separate columns pushed the table past a laptop screen. A fixed-width cell keeps the table inside the page
 * (the title - the line people read - wraps to two lines before it is cut; the number is its small caption),
 * folds the location into the cell people read first, and the real link keeps "open in a new tab" and
 * screen-reader link lists working without a separate "View" column. Rows stay clickable as a whole
 * (ComplaintTable).
 */
import { MapPin } from 'lucide-react'
import { Link } from 'react-router-dom'
import { complaintPath, placeLabel } from './complaintHelpers'

export const LINKED_NUMBER_COLUMN = Object.freeze({
  key: 'number',
  header: 'Complaint',
  render: (row) => {
    const place = placeLabel(row.location)
    return (
      <div className="w-64 min-w-0 xl:w-[24rem] 2xl:w-[28rem]">
        <p className="text-xs font-semibold text-ink-3 tabular">{row.complaint_number}</p>
        <Link
          to={complaintPath(row.id)}
          title={row.title || row.description}
          className="line-clamp-2 font-semibold leading-snug text-ink hover:text-primary-ink hover:underline"
        >
          {row.title || row.description}
        </Link>
        {place ? (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-3" title={row.location?.address || place}>
            <MapPin aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{place}</span>
          </p>
        ) : null}
      </div>
    )
  },
})
