/**
 * FeedbackTable - recent citizen feedback (GET /feedback/ rows: `{id, complaint, complaint_number,
 * complaint_title, citizen, rating, text, sentiment, sentiment_score, sentiment_confidence, department,
 * category, created_at}`), newest first, each row linking to its complaint.
 *
 * Desktop: a table (date, complaint, rating, sentiment with its -1..+1 score, the comment, category and
 * department). Phones: FeedbackCard per row. Rows open /admin/complaints/<id> (mouse and keyboard).
 *
 * Props:
 * - data: rows; loading
 * - empty: node for the empty state
 * - className
 */
import { Link, useNavigate } from 'react-router-dom'
import { CategoryBadge, DepartmentBadge, FeedbackCard } from '@/components/complaints'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { StarRating } from '@/components/ui/StarRating'
import { cn } from '@/utils/cn'
import { getSentimentMeta } from '@/utils/constants'
import { formatDate, formatDateTime, formatNumber, timeAgo } from '@/utils/format'

const BASE_PATH = '/admin/complaints'

function signed(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return `${number > 0 ? '+' : ''}${formatNumber(number, { digits: 2 })}`
}

const COLUMNS = [
  {
    key: 'created_at',
    header: 'Date',
    render: (row) => (
      <span className="whitespace-nowrap">
        <time dateTime={row.created_at} title={formatDateTime(row.created_at)} className="block text-ink tabular">
          {formatDate(row.created_at)}
        </time>
        <span className="block text-xs text-ink-3">{timeAgo(row.created_at)}</span>
      </span>
    ),
  },
  {
    key: 'complaint',
    header: 'Complaint',
    className: 'max-w-64',
    render: (row) => (
      <div className="min-w-0">
        <Link to={`${BASE_PATH}/${row.complaint}`} className="text-xs font-semibold text-primary-ink tabular hover:underline">
          {row.complaint_number}
        </Link>
        <p className="truncate text-ink" title={row.complaint_title}>
          {row.complaint_title}
        </p>
      </div>
    ),
  },
  {
    key: 'rating',
    header: 'Rating',
    render: (row) => <StarRating value={Number(row.rating) || 0} readOnly size="sm" label="Rating" />,
  },
  {
    key: 'sentiment',
    header: 'Sentiment',
    render: (row) => {
      const meta = getSentimentMeta(row.sentiment)
      const score = signed(row.sentiment_score)
      return meta ? (
        <Badge tone={meta.tone} icon={meta.icon} size="sm">
          {meta.label}
          {score ? <span className="ml-1 font-bold tabular">{score}</span> : null}
        </Badge>
      ) : (
        <span className="text-xs text-ink-3">Not analysed</span>
      )
    },
  },
  {
    key: 'text',
    header: 'Feedback',
    className: 'min-w-64 max-w-md',
    render: (row) =>
      row.text ? (
        <p className="line-clamp-2 text-ink-2" title={row.text}>
          {row.text}
        </p>
      ) : (
        <span className="text-xs text-ink-3">Rating only</span>
      ),
  },
  {
    key: 'category',
    header: 'Category and department',
    hideOnMobile: true,
    render: (row) => (
      <div className="flex flex-col items-start gap-1">
        <CategoryBadge category={row.category} size="sm" />
        <DepartmentBadge department={row.department} size="sm" />
      </div>
    ),
  },
]

export function FeedbackTable({ data, loading = false, empty, className }) {
  const navigate = useNavigate()
  return (
    <DataTable
      columns={COLUMNS}
      data={data ?? []}
      loading={loading}
      rowKey="id"
      onRowClick={(row) => navigate(`${BASE_PATH}/${row.complaint}`)}
      caption="Recent citizen feedback"
      empty={empty}
      className={cn('relative', className)}
      mobileCard={(row) => <FeedbackCard feedback={row} showCitizen={false} className="rounded-none border-0" />}
    />
  )
}

export default FeedbackTable
