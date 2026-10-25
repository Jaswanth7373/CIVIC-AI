/**
 * useAcceptComplaint - "Accept" straight from a list or the dashboard queue.
 *
 *   const { accept, acceptingId } = useAcceptComplaint({ onAccepted: () => refetch() })
 *   <OfficerComplaintTable onAccept={accept} acceptingId={acceptingId} ... />
 *
 * POST /complaints/{id}/accept/, then a toast that reuses the verb and the caller's refresh. Failures (for
 * example the complaint was reassigned a moment ago) show the server's explanation in an error toast.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services/complaintService'
import { getErrorMessage } from '@/utils/errors'

export function useAcceptComplaint({ onAccepted } = {}) {
  const toast = useToast()
  const [acceptingId, setAcceptingId] = useState(null)
  const onAcceptedRef = useRef(onAccepted)

  useLayoutEffect(() => {
    onAcceptedRef.current = onAccepted
  })

  const accept = useCallback(
    async (complaint) => {
      if (!complaint) return
      setAcceptingId(complaint.id)
      try {
        const detail = await complaintService.accept(complaint.id, {})
        toast.success('Complaint accepted', `${complaint.complaint_number} is in your accepted work. Start work when the crew is on site.`)
        await onAcceptedRef.current?.(detail)
      } catch (err) {
        toast.error('Could not accept complaint', getErrorMessage(err))
      } finally {
        setAcceptingId(null)
      }
    },
    [toast],
  )

  return { accept, acceptingId }
}

export default useAcceptComplaint
