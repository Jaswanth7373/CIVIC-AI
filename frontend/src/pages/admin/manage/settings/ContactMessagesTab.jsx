/**
 * ContactMessagesTab - messages sent from the public contact page.
 *
 * Data: GET /contact/ (`is_resolved`, `search`, paginated, newest first). "Mark resolved" / "Reopen" saves
 * PATCH /contact/{id}/ `{is_resolved}` and updates the row in place. Replies go out by email (mailto link),
 * because the platform does not send mail on the administrator's behalf.
 */
import { CheckCheck, Inbox, Mail, RotateCcw, SearchX } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { systemService } from '@/services'
import { getErrorMessage } from '@/utils/errors'
import { formatDateTime, timeAgo } from '@/utils/format'
import { ListPagination, SummaryLine } from '../shared/Controls'
import { compactParams, toList } from '../shared/listUtils'

const PAGE_SIZE = 10
const STATUS_FILTER = [
  { value: 'false', label: 'Open messages' },
  { value: 'true', label: 'Resolved' },
  { value: '', label: 'All messages' },
]

function MessageItem({ message, busy, onToggle }) {
  const [expanded, setExpanded] = useState(false)
  const long = String(message.message ?? '').length > 280
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-[15px] font-bold text-ink">{message.subject}</p>
          <p className="mt-0.5 text-xs text-ink-3">
            {message.name},{' '}
            <a href={`mailto:${message.email}?subject=${encodeURIComponent(`Re: ${message.subject}`)}`} className="font-medium text-primary-ink hover:underline">
              {message.email}
            </a>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={message.is_resolved ? 'green' : 'yellow'} size="sm" dot>
            {message.is_resolved ? 'Resolved' : 'Open'}
          </Badge>
          <time dateTime={message.created_at} title={formatDateTime(message.created_at)} className="text-xs text-ink-3">
            {timeAgo(message.created_at)}
          </time>
        </div>
      </div>
      <p className={`mt-3 whitespace-pre-line text-sm text-ink-2 ${long && !expanded ? 'line-clamp-4' : ''}`}>{message.message}</p>
      {long ? (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-9">
          {expanded ? 'Show less' : 'Show the whole message'}
        </button>
      ) : null}
      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-line pt-3">
        <Button variant="ghost" size="sm" leftIcon={Mail} href={`mailto:${message.email}?subject=${encodeURIComponent(`Re: ${message.subject}`)}`}>
          Reply by email
        </Button>
        {message.is_resolved ? (
          <Button variant="outline" size="sm" leftIcon={RotateCcw} loading={busy} onClick={() => onToggle(message, false)}>
            Reopen
          </Button>
        ) : (
          <Button variant="secondary" size="sm" leftIcon={CheckCheck} loading={busy} onClick={() => onToggle(message, true)}>
            Mark resolved
          </Button>
        )}
      </div>
    </li>
  )
}

export function ContactMessagesTab() {
  const toast = useToast()
  const [filters, setFilters] = useState({ is_resolved: 'false', search: '' })
  const [page, setPage] = useState(1)
  const [busyId, setBusyId] = useState(null)
  const messages = useApi(() => systemService.contactMessages(compactParams({ ...filters, page, page_size: PAGE_SIZE })), [filters, page])
  const rows = toList(messages.data)

  const update = (patch) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(1)
  }

  const toggle = async (message, resolved) => {
    setBusyId(message.id)
    try {
      const saved = await systemService.updateContactMessage(message.id, { is_resolved: resolved })
      messages.setData((current) =>
        current && Array.isArray(current.results)
          ? { ...current, results: current.results.map((row) => (row.id === message.id ? { ...row, ...saved } : row)) }
          : current,
      )
      toast.success(resolved ? 'Message resolved' : 'Message reopened', `“${message.subject}” from ${message.name}.`)
    } catch (error) {
      toast.error(resolved ? 'Could not resolve the message' : 'Could not reopen the message', getErrorMessage(error))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          value={filters.search}
          onSearch={(search) => update({ search })}
          placeholder="Search name, email, subject or text"
          label="Search messages"
          className="sm:max-w-sm sm:flex-1"
        />
        <Select
          aria-label="Message status"
          value={filters.is_resolved}
          onChange={(event) => update({ is_resolved: event.target.value })}
          options={STATUS_FILTER}
          containerClassName="sm:w-48"
        />
      </div>

      <SummaryLine count={messages.data?.count} noun="message" loading={messages.loading && Boolean(messages.data)} />

      {messages.error && !messages.data ? (
        <ErrorState title="Messages could not be loaded" error={messages.error} onRetry={() => messages.refetch()} />
      ) : messages.loading && !messages.data ? (
        <ul aria-hidden className="space-y-3">
          {[0, 1].map((index) => (
            <li key={index} className="space-y-2 rounded-xl border border-line p-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton lines={3} />
            </li>
          ))}
        </ul>
      ) : rows.length ? (
        <ul className="space-y-3">
          {rows.map((message) => (
            <MessageItem key={message.id} message={message} busy={busyId === message.id} onToggle={toggle} />
          ))}
        </ul>
      ) : filters.search ? (
        <EmptyState icon={SearchX} title="No messages match" description="Try another name, email or word." />
      ) : (
        <EmptyState
          icon={Inbox}
          title={filters.is_resolved === 'false' ? 'No open messages' : 'No messages yet'}
          description={
            filters.is_resolved === 'false'
              ? 'Every message from the public contact page has been handled. New ones appear here.'
              : 'Messages sent from the public contact page appear here.'
          }
          action={
            filters.is_resolved ? (
              <Button variant="outline" onClick={() => update({ is_resolved: '' })}>
                Show all messages
              </Button>
            ) : null
          }
        />
      )}

      <ListPagination className="mt-2" data={messages.data} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  )
}

export default ContactMessagesTab
