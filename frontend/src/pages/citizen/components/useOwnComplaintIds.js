/**
 * useOwnComplaintIds - the ids of the signed-in citizen's own complaints, as a Set.
 *
 * AI duplicate checks and duplicate links can point at complaints filed by OTHER citizens; those cannot be
 * opened from a citizen account (the API answers 404 outside the citizen's scope). Pages use this set to
 * link only to complaints the citizen can actually open and to show the others in place.
 *
 * Source: GET /api/complaints/map/ - scoped to the citizen's own complaints, non-paginated and lightweight
 * (id + pin fields only), so one request covers every complaint the citizen has. Fetched only when `enabled`.
 */
import { useMemo } from 'react'
import { useApi } from '@/hooks/useApi'
import { complaintService } from '@/services/complaintService'

export function useOwnComplaintIds(enabled = true) {
  const { data, loading } = useApi(() => (enabled ? complaintService.map() : Promise.resolve(null)), [enabled])
  const ids = useMemo(() => new Set((Array.isArray(data) ? data : []).map((item) => item.id)), [data])
  return { ids, loading: enabled && loading }
}

export default useOwnComplaintIds
