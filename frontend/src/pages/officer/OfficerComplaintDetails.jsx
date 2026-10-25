/**
 * Officer complaint details (/officer/complaints/:id) - page 18 of the requirements: the work order an
 * officer takes to the site.
 *
 * GET /api/complaints/{id}/ (ComplaintDetail) drives everything, including which buttons exist
 * (`allowed_actions`). Layout: the header and the progress strip with the next step and its actions; then
 * the citizen's report (text + photo with the AI's detection boxes); a side column with the location,
 * directions, citizen contact and service-level dates; then the AI analysis, priority breakdown, possible
 * duplicates (reviewable by the department), resolution evidence, timeline, assignment and feedback.
 * On phones the side column follows the citizen's report, so the map and the directions are near the top.
 *
 * Mutations: accept / start / reject return the updated ComplaintDetail (stored directly); a remark
 * returns a TimelineEvent (appended); a duplicate review refetches the complaint.
 *
 * Phones: once the next-step strip has scrolled out of view, the next action rides in a floating dock at the
 * bottom of the screen (WorkOrderDock), so it is within reach anywhere on the long work order without ever being
 * on screen twice.
 */
import { Brain, Copy, Gauge, GitMerge, History, Star, TriangleAlert } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AIAnalysisPanel } from '@/components/ai/AIAnalysisPanel'
import { ComplaintTimeline } from '@/components/complaints/ComplaintTimeline'
import { DuplicatePanel } from '@/components/complaints/DuplicatePanel'
import { FeedbackCard } from '@/components/complaints/FeedbackCard'
import { PriorityBreakdown } from '@/components/complaints/PriorityBreakdown'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import { categoryService } from '@/services/categoryService'
import { duplicateService } from '@/services/duplicateService'
import { getErrorMessage } from '@/utils/errors'
import { AssignmentCard } from './components/AssignmentCard'
import { CitizenContactCard } from './components/CitizenContactCard'
import { ComplaintHeader } from './components/ComplaintHeader'
import { ComplaintLoadError, ComplaintPageSkeleton } from './components/ComplaintPageState'
import { LocationCard } from './components/LocationCard'
import { OFFICER_BASE_PATH, allowedSet, complaintPath, isAssignedTo, latestEvent } from './components/officerUtils'
import { ReportedIssueCard } from './components/ReportedIssueCard'
import { ResolutionCard } from './components/ResolutionCard'
import { useOfficerComplaint } from './components/useOfficerComplaint'
import { WorkOrderFactsCard } from './components/WorkOrderFactsCard'
import { WorkOrderDock, WorkOrderProgress } from './components/WorkOrderProgress'

function StatusAlerts({ complaint }) {
  const alerts = []
  if (complaint.duplicate_of) {
    alerts.push(
      <Alert key="merged" tone="info" icon={GitMerge} title="Merged into an earlier report">
        This complaint was confirmed as the same issue as{' '}
        <Link to={complaintPath(complaint.duplicate_of.id)} className="font-semibold text-primary-ink tabular hover:underline">
          {complaint.duplicate_of.complaint_number}
        </Link>
        , which carries the work.
      </Alert>,
    )
  }
  if (complaint.status === 'rejected') {
    const rejection = latestEvent(complaint, 'rejected')
    alerts.push(
      <Alert key="rejected" tone="danger" title="This complaint was rejected">
        {rejection?.remarks ? `Reason: ${rejection.remarks}` : 'No reason was recorded.'}
      </Alert>,
    )
  }
  if (complaint.needs_manual_review && complaint.status !== 'rejected') {
    const verification = ['resolved', 'verified'].includes(complaint.status)
    alerts.push(
      <Alert
        key="review"
        tone="warning"
        icon={TriangleAlert}
        title={verification ? 'The resolution needs a manual decision' : 'Flagged for manual review'}
        action={
          verification ? (
            <Button size="sm" variant="outline" to={complaintPath(complaint.id, 'verify')}>
              Open verification
            </Button>
          ) : null
        }
      >
        {verification
          ? 'The AI verification was not conclusive. Compare the before and after photos and decide.'
          : 'The AI was not confident about this complaint (low confidence or the photo and description disagree). Check the category before starting work.'}
      </Alert>,
    )
  }
  if (!alerts.length) return null
  return <div className="mb-5 space-y-3">{alerts}</div>
}

export default function OfficerComplaintDetails() {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const { complaint, error, refetch, setData } = useOfficerComplaint()
  const { data: categories } = useApi(() => categoryService.list(), [])
  const { hash } = useLocation()
  const loadedId = complaint?.id
  const nextStepRef = useRef(null)

  // Links such as the dashboard's "Review" open `#duplicates`; the section exists only once the complaint loaded.
  useEffect(() => {
    if (!loadedId || !hash) return
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' })
  }, [loadedId, hash])

  if (!complaint) {
    return error ? <ComplaintLoadError error={error} onRetry={() => refetch()} /> : <ComplaintPageSkeleton />
  }

  const allowed = allowedSet(complaint)
  const mine = isAssignedTo(complaint, user?.id)
  const duplicates = Array.isArray(complaint.duplicates) ? complaint.duplicates : []
  const pendingDuplicates = duplicates.filter((link) => link.status === 'pending_review').length
  const canReview = allowed.has('review_duplicates')
  const feedback = Array.isArray(complaint.feedback) ? complaint.feedback : []

  const appendTimelineEvent = (event) => {
    if (!event) return
    setData((current) => (current ? { ...current, timeline: [...(current.timeline ?? []), event] } : current))
  }

  const reviewDuplicate = async (duplicateId, status, link) => {
    if (status === 'confirmed_duplicate') {
      const newer = link?.direction === 'original' ? complaint : link?.other
      const original = link?.direction === 'original' ? link?.other : complaint
      const ok = await confirm({
        title: `Confirm ${newer?.complaint_number ?? 'this report'} as a duplicate?`,
        message: `It is merged into ${original?.complaint_number ?? 'the earlier report'} and closed, and its citizen is told the issue is handled there. This cannot be undone from the officer workspace.`,
        confirmLabel: 'Confirm duplicate',
        tone: 'warning',
      })
      if (!ok) return
    }
    try {
      await duplicateService.review(duplicateId, { status })
    } catch (err) {
      toast.error('Could not save the duplicate review', getErrorMessage(err))
      throw err
    }
    toast.success(
      status === 'confirmed_duplicate' ? 'Duplicate confirmed' : 'Marked as not a duplicate',
      status === 'confirmed_duplicate' ? 'The newer report was merged and closed.' : 'Both complaints stay open as separate issues.',
    )
    await refetch()
  }

  return (
    <>
      <ComplaintHeader complaint={complaint} page="details" />
      <StatusAlerts complaint={complaint} />

      <WorkOrderProgress
        complaint={complaint}
        currentUserId={user?.id}
        onUpdated={setData}
        onRemarkAdded={appendTimelineEvent}
        actionsRef={nextStepRef}
      />

      {pendingDuplicates && canReview ? (
        <Alert
          tone="warning"
          icon={Copy}
          title={pendingDuplicates === 1 ? '1 possible duplicate needs a review' : `${pendingDuplicates} possible duplicates need a review`}
          className="mb-5"
          action={
            <Button size="sm" variant="outline" href="#duplicates">
              Review duplicates
            </Button>
          }
        >
          The AI found reports of what looks like the same issue nearby. Confirming one merges the newer report into the original.
        </Alert>
      ) : null}

      {/*
        Two columns from xl; below xl the column wrappers are `display: contents`, so every card joins one grid
        and `order` puts the site information (map, directions, contact, SLA) right after the report. From md the
        citizen contact and the service-level card share a row.
      */}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] xl:items-start">
        <div className="contents xl:block xl:min-w-0 xl:space-y-5">
          <ReportedIssueCard complaint={complaint} className="order-1 md:col-span-2" />

          <Card className="order-5 md:col-span-2">
            <CardHeader
              title="AI analysis"
              icon={Brain}
              description="How the image model and the text classifier read this report, and why it got its severity."
            />
            <CardBody>
              <AIAnalysisPanel prediction={complaint.ai_prediction} categories={categories ?? []} />
            </CardBody>
          </Card>

          <Card id="duplicates" className="order-7 scroll-mt-24 md:col-span-2">
            <CardHeader
              title="Possible duplicates"
              icon={Copy}
              description={
                canReview
                  ? 'Reports the AI linked to this one by text, photo and distance. Review each link.'
                  : 'Reports the AI linked to this one by text, photo and distance.'
              }
            />
            <CardBody>
              <DuplicatePanel duplicates={duplicates} canReview={canReview} onReview={reviewDuplicate} basePath={OFFICER_BASE_PATH} />
            </CardBody>
          </Card>

          <ResolutionCard complaint={complaint} className="order-8 md:col-span-2" />
          <AssignmentCard assignment={complaint.current_assignment} history={complaint.assignments} mine={mine} className="order-10 md:col-span-2" />

          {feedback.length ? (
            <Card className="order-11 md:col-span-2">
              <CardHeader
                title="Citizen feedback"
                icon={Star}
                description="The citizen's rating of the resolution, with its analysed sentiment."
              />
              <CardBody className="space-y-3">
                {feedback.map((item) => (
                  <FeedbackCard key={item.id} feedback={item} showComplaint={false} />
                ))}
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="contents xl:block xl:min-w-0 xl:space-y-5">
          <LocationCard location={complaint.location} color={complaint.category?.color} className="order-2 md:col-span-2" />
          <CitizenContactCard citizen={complaint.citizen} className="order-3" />
          <WorkOrderFactsCard complaint={complaint} className="order-4" />

          <Card className="order-6 md:col-span-2">
            <CardHeader title="Priority" icon={Gauge} description="The five factors behind the score that orders your queue." />
            <CardBody>
              <PriorityBreakdown priority={complaint.priority} compact />
            </CardBody>
          </Card>

          <Card className="order-9 md:col-span-2">
            <CardHeader title="Timeline" icon={History} description="Every step of this complaint, including internal notes." />
            <CardBody>
              <ComplaintTimeline events={complaint.timeline} status={complaint.status} />
            </CardBody>
          </Card>
        </div>
      </div>

      <WorkOrderDock complaint={complaint} currentUserId={user?.id} onUpdated={setData} watch={nextStepRef} />
    </>
  )
}
