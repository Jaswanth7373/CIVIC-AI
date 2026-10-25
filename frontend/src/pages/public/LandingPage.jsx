/**
 * Landing page (public, "/").
 *
 * The first impression of CivicAI, built from live data only:
 * - hero: the CivicAI gantry sign over a live 3D city (real category and department names on the scene's signs),
 *   the specified headline / subtitle / calls to action, live platform figures (GET /api/analytics/public/) and a
 *   work order filled in live by the real AI engine (POST /api/ai/demo/ with a bundled sample photo - nothing is
 *   stored), shown as a glass dispatch card over the city;
 * - "How CivicAI Works": a pinned scroll story - the camera follows a report through the district (report,
 *   analyse, prioritise, route, verify) while the fifteen steps of the lifecycle scroll past;
 * - "Try your own photo": the same public endpoint with the visitor's photo and / or description;
 * - the other required sections (spec section 10), each with its own choreography that shows what the feature
 *   does (routing arcs fly to departments, duplicate photos slide together, priority bars fill to their real
 *   values, the before / after photo wipes, stars cascade ...). Routing, detection vocabulary and the category
 *   chart use the public categories list (GET /api/categories/); the multimodal diagram reuses the hero's result.
 *   They are told in three acts - Understand, Decide, Close the loop - each opened by a full-bleed night band
 *   (ActBand) with its sections as in-page direction signs, so the page keeps a rhythm after the story. Each act
 *   has its own ground and composition (LandingSection): act 1 editorial splits and spreads on one sheet; act 2
 *   centred overhead signs at a larger size, closing on its full-bleed moment - the routing table as a dispatch
 *   board on a night band under a lane line; act 3 evidence beside the text and the live figures at display
 *   scale.
 *
 * Motion follows the motion system (components/motion): one orchestrated hero moment, scroll-driven elsewhere,
 * heading reveals, nothing that loops on its own except the live scene. Reduced motion: every section renders
 * its final state and the 3D scenes a single composed still.
 */
import { Suspense, lazy, useState } from 'react'
import { ScrollProgress } from '@/components/motion/ScrollProgress'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { analyticsService } from '@/services/analyticsService'
import { categoryService } from '@/services/categoryService'
import '@/styles/landing.css'
import { ActBand } from './components/landing/ActBand'
import { ClosingBand } from './components/landing/ClosingBand'
import { runHeroDemo } from './components/landing/demoUtils'
import { DetectionSection } from './components/landing/DetectionSection'
import { DuplicateSection } from './components/landing/DuplicateSection'
import { FeedbackSection } from './components/landing/FeedbackSection'
import { HeroSection } from './components/landing/HeroSection'
import { HowSection } from './components/landing/HowSection'
import { MultimodalSection } from './components/landing/MultimodalSection'
import { PrioritySection } from './components/landing/PrioritySection'
import { RoutingSection } from './components/landing/RoutingSection'
import { TryDemoModal } from './components/landing/TryDemoModal'
import { VerificationSection } from './components/landing/VerificationSection'
import { MUTED_TEXT_AA } from './components/contrast'
import { Container } from './components/Section'

const AnalyticsSection = lazy(() => import('./components/landing/AnalyticsSection'))

/** The three acts of the feature sections (ids and titles of the sections that follow each band). */
const ACTS = Object.freeze({
  understand: {
    title: 'Understand',
    lead: 'The AI reads every report: what the photo shows, what the description says, and whether the two agree.',
    sections: [
      { id: 'ai-issue-detection', title: 'AI Issue Detection' },
      { id: 'multimodal-ai', title: 'Multimodal AI' },
    ],
  },
  decide: {
    title: 'Decide',
    lead: 'How urgent the issue is, whether it has already been reported, and which department should fix it.',
    sections: [
      { id: 'smart-prioritization', title: 'Smart Prioritization' },
      { id: 'duplicate-detection', title: 'Duplicate Detection' },
      { id: 'department-routing', title: 'Automatic Department Routing' },
    ],
  },
  close: {
    title: 'Close the loop',
    lead: 'The fix is checked against the original photo, the citizen has the last word, and the city learns from the pattern.',
    sections: [
      { id: 'resolution-verification', title: 'Resolution Verification' },
      { id: 'citizen-feedback', title: 'Citizen Feedback' },
      { id: 'smart-city-analytics', title: 'Smart City Analytics' },
    ],
  },
})

function AnalyticsFallback() {
  return (
    <div aria-hidden className="bg-surface pb-20 sm:pb-24 lg:pb-28">
      <Container>
        <span className="landing-junction mb-20 block sm:mb-24 lg:mb-28" />
        <Skeleton className="h-12 w-80 max-w-full" />
        <Skeleton className="mt-5 h-5 w-full max-w-xl" />
        <div className="mt-14 grid grid-cols-2 gap-x-6 gap-y-10 sm:mt-16 lg:grid-cols-4 lg:gap-x-10">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-28 rounded-xl" />
          ))}
        </div>
      </Container>
    </div>
  )
}

export default function LandingPage() {
  useDocumentTitle('')
  const demo = useApi((options) => runHeroDemo(options), [])
  const stats = useApi(() => analyticsService.publicStats(), [])
  const categories = useApi(() => categoryService.list(), [])
  const [tryOpen, setTryOpen] = useState(false)

  const openTry = () => setTryOpen(true)
  const categoryList = categories.data ?? null

  return (
    <div className={MUTED_TEXT_AA}>
      <ScrollProgress />
      <HeroSection
        demo={demo}
        onRetryDemo={() => demo.refetch({ force: true })}
        categories={categoryList}
        categoriesLoading={categories.loading}
        stats={stats.data}
        statsLoading={stats.loading}
        statsError={stats.error}
        onTryOwn={openTry}
      />
      <HowSection categories={categoryList} />
      <ActBand number={1} {...ACTS.understand} />
      <DetectionSection
        categories={categoryList}
        loading={categories.loading}
        error={categories.error}
        onRetry={() => categories.refetch()}
        onTryOwn={openTry}
      />
      <MultimodalSection demo={demo} categories={categoryList} />
      <ActBand number={2} {...ACTS.decide} />
      <PrioritySection />
      <DuplicateSection />
      <RoutingSection
        categories={categoryList}
        loading={categories.loading}
        error={categories.error}
        onRetry={() => categories.refetch()}
      />
      <ActBand number={3} {...ACTS.close} />
      <VerificationSection />
      <FeedbackSection />
      <Suspense fallback={<AnalyticsFallback />}>
        <AnalyticsSection
          stats={stats.data}
          statsLoading={stats.loading}
          statsError={stats.error}
          onRetryStats={() => stats.refetch()}
          categories={categoryList}
          categoriesLoading={categories.loading}
          categoriesError={categories.error}
          onRetryCategories={() => categories.refetch()}
        />
      </Suspense>
      <ClosingBand />

      <TryDemoModal open={tryOpen} onClose={() => setTryOpen(false)} categories={categoryList} />
    </div>
  )
}
