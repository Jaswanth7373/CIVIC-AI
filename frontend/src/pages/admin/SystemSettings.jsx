/**
 * System settings (admin) - the AI engine and the platform's reference data.
 *
 * Tabs (`?tab=` in the URL, so a tab can be linked):
 * - AI configuration: priority weights (live sum + stacked-bar preview), level thresholds, fusion, duplicate,
 *   hotspot, verification and automation settings; Save / Save & recalculate open complaints.
 * - Priority simulator: sliders -> the priority engine's breakdown and explanation (nothing stored).
 * - Model information: mode, Demo AI Mode explanation, every model / component with its status and version,
 *   and how to switch to production.
 * - Model playground: run the full submission pipeline on a test report, classify a description and / or photo,
 *   compare before / after photos with the verification engine, analyse feedback sentiment (nothing is stored).
 * - Risk zones: CRUD with a map (lazy-loaded Leaflet).
 * - Contact messages: the public contact form inbox, mark resolved.
 */
import { BrainCircuit, Cpu, FlaskConical, Inbox, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { Suspense, lazy } from 'react'
import { PageHeader, Skeleton, TabPanel, Tabs } from '@/components/ui'
import { AIConfigTab } from './manage/settings/AIConfigTab'
import { ContactMessagesTab } from './manage/settings/ContactMessagesTab'
import { ModelInfoTab } from './manage/settings/ModelInfoTab'
import { PlaygroundTab } from './manage/settings/PlaygroundTab'
import { PrioritySimulatorTab } from './manage/settings/PrioritySimulatorTab'
import { useUrlParams } from './manage/shared/useUrlParams'

const RiskZonesTab = lazy(() => import('./manage/settings/RiskZonesTab'))

const TABS = [
  { id: 'ai', label: 'AI configuration', icon: SlidersHorizontal },
  { id: 'simulator', label: 'Priority simulator', icon: FlaskConical },
  { id: 'models', label: 'Model information', icon: Cpu },
  { id: 'playground', label: 'Model playground', icon: BrainCircuit },
  { id: 'zones', label: 'Risk zones', icon: ShieldAlert },
  { id: 'messages', label: 'Contact messages', icon: Inbox },
]

const DESCRIPTIONS = {
  ai: 'How the AI engine scores, links and routes complaints. Changes apply to the next analysis.',
  simulator: 'See how the priority engine would score a complaint, before changing any weight.',
  models: 'Which models answer right now, their status and versions.',
  playground: 'Run the live models on your own text and photos. Nothing is stored.',
  zones: 'Places where an issue is more dangerous, so nearby complaints rise in priority.',
  messages: 'Questions and requests sent from the public contact page.',
}

export default function SystemSettings() {
  const { values, setValues } = useUrlParams({ tab: 'ai' })
  const tab = TABS.some((item) => item.id === values.tab) ? values.tab : 'ai'

  return (
    <>
      <PageHeader title="System settings" description={DESCRIPTIONS[tab]} />
      <Tabs tabs={TABS} value={tab} onChange={(next) => setValues({ tab: next })} idPrefix="settings" label="Settings sections" className="mb-5" />
      <TabPanel tabId="ai" value={tab} idPrefix="settings">
        <AIConfigTab />
      </TabPanel>
      <TabPanel tabId="simulator" value={tab} idPrefix="settings">
        <PrioritySimulatorTab />
      </TabPanel>
      <TabPanel tabId="models" value={tab} idPrefix="settings">
        <ModelInfoTab />
      </TabPanel>
      <TabPanel tabId="playground" value={tab} idPrefix="settings">
        <PlaygroundTab />
      </TabPanel>
      <TabPanel tabId="zones" value={tab} idPrefix="settings">
        <Suspense fallback={<Skeleton className="h-[420px] w-full rounded-xl" />}>
          <RiskZonesTab />
        </Suspense>
      </TabPanel>
      <TabPanel tabId="messages" value={tab} idPrefix="settings">
        <ContactMessagesTab />
      </TabPanel>
    </>
  )
}
