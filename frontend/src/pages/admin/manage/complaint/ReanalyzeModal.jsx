/**
 * ReanalyzeModal - re-run the AI pipeline for a stored complaint and replay what it did.
 *
 * POST /complaints/{id}/reanalyze/ -> ComplaintDetail + `analysis: {steps, summary}`. The dialog first says
 * what a re-run changes (a new AIPrediction row; category and severity are only replaced when no administrator
 * overrode them; a manual priority override is kept; an assigned officer stays). While the request runs,
 * AnalysisProgress shows an honest indeterminate state, then replays the measured steps.
 *
 * Props: open, onClose, complaint (ComplaintDetail), onDone(detail)
 */
import { ScanSearch } from 'lucide-react'
import { useState } from 'react'
import { AnalysisProgress } from '@/components/complaints'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services'
import { getErrorMessage } from '@/utils/errors'

export function ReanalyzeModal({ open, onClose, complaint, onDone }) {
  const toast = useToast()
  const [phase, setPhase] = useState('confirm') // confirm | running | done | error
  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState(null)

  const run = async () => {
    setPhase('running')
    setError(null)
    try {
      const detail = await complaintService.reanalyze(complaint.id)
      setAnalysis(detail?.analysis ?? null)
      setPhase('done')
      toast.success('AI analysis re-run', `${complaint.complaint_number} was analysed again.`)
      onDone?.(detail)
    } catch (err) {
      setError(err)
      setPhase('error')
      toast.error('Could not re-run the AI analysis', getErrorMessage(err))
    }
  }

  const busy = phase === 'running'

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      size="lg"
      title="Re-run AI analysis"
      description={`${complaint.complaint_number}: the photo, description and location go through the AI pipeline again.`}
      closeOnOverlayClick={!busy}
      footer={
        phase === 'confirm' || phase === 'error' ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={run} leftIcon={ScanSearch}>
              {phase === 'error' ? 'Try again' : 'Re-run AI analysis'}
            </Button>
          </>
        ) : phase === 'done' ? (
          <Button onClick={onClose}>Back to the complaint</Button>
        ) : null
      }
    >
      {phase === 'confirm' || phase === 'error' ? (
        <div className="space-y-3 text-sm text-ink-2">
          <p>A re-run stores a new AI prediction next to the old one and recalculates the priority. It keeps:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>category and severity corrections made by an administrator,</li>
            <li>a manually set priority score,</li>
            <li>the officer who is already assigned, and reviewed duplicate decisions.</li>
          </ul>
          {phase === 'error' ? (
            <Alert tone="danger" title="The analysis did not finish">
              {getErrorMessage(error)}
            </Alert>
          ) : null}
        </div>
      ) : (
        <AnalysisProgress
          running={busy}
          steps={analysis?.steps}
          summary={analysis?.summary}
          complaintNumber={complaint.complaint_number}
        />
      )}
    </Modal>
  )
}

export default ReanalyzeModal
