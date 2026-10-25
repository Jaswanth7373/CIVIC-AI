/**
 * useOfficerComplaint - the ComplaintDetail behind `/officer/complaints/:id/*`.
 *
 *   const { id, complaint, loading, error, refetch, setData } = useOfficerComplaint()
 *
 * `complaint` is only the loaded record when it belongs to the id in the URL, so moving from one complaint
 * to another (a duplicate link, the browser back button) never shows the previous complaint under the new
 * address while the next one loads. Mutations that return a ComplaintDetail can hand it to `setData`.
 */
import { useParams } from 'react-router-dom'
import { useApi } from '@/hooks/useApi'
import { complaintService } from '@/services/complaintService'

export function useOfficerComplaint() {
  const { id } = useParams()
  const { data, loading, error, refetch, setData } = useApi(() => complaintService.get(id), [id])
  const complaint = data && String(data.id) === String(id) ? data : null
  return { id, complaint, loading, error, refetch, setData }
}

export default useOfficerComplaint
