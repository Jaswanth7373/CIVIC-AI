/**
 * ModelRegistry - every AI model and engine component the server reports, with version and live status
 * (`model_info.models` and `model_info.components` from GET /analytics/ai/, i.e. ai.model_info).
 *
 * Models: name, task, framework, version, status (active / available / not installed / weights missing /
 * fallback) and whether it is a demo technique. Components (priority, duplicates, DBSCAN hotspots, fusion,
 * severity) also say whether they run on the admin's live settings ("parameters": "configured"); their
 * detail line spells out the live weights and thresholds.
 *
 * Narrow spaces (phones, or the table narrower than 48rem): one card per model with its status beside the name,
 * so the live status never scrolls out of view.
 *
 * Props:
 * - modelInfo: the `model_info` object
 * - className
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { TabPanel, Tabs } from '@/components/ui/Tabs'
import { cn } from '@/utils/cn'
import { modelDisplayName, modelStatus } from './insightUtils'

function NameCell({ row }) {
  return (
    <div className="min-w-56 max-w-xl">
      <p className="font-semibold text-ink">{modelDisplayName(row)}</p>
      {row.task ? <p className="text-xs text-ink-2">{row.task}</p> : null}
      {row.detail ? <p className="mt-1 text-xs leading-relaxed text-ink-3">{row.detail}</p> : null}
    </div>
  )
}

function StatusCell({ row }) {
  const status = modelStatus(row.status)
  return (
    <Badge tone={status.tone} size="sm" dot>
      {status.label}
    </Badge>
  )
}

function ModeCell({ isDemo }) {
  return isDemo ? (
    <Badge tone="yellow" size="sm">
      Demo technique
    </Badge>
  ) : (
    <Badge tone="neutral" size="sm">
      Production
    </Badge>
  )
}

function SettingsCell({ parameters }) {
  return parameters === 'configured' ? (
    <Badge tone="green" size="sm">
      Live settings
    </Badge>
  ) : (
    <Badge tone="neutral" size="sm">
      Defaults
    </Badge>
  )
}

/** Phone card: name and status on one line, then what it does, then version, framework and kind. */
function RegistryCard({ row, component = false }) {
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{modelDisplayName(row)}</p>
          {row.task ? <p className="text-xs text-ink-2">{row.task}</p> : null}
        </div>
        <StatusCell row={row} />
      </div>
      {row.detail ? <p className="text-xs leading-relaxed text-ink-3">{row.detail}</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-2">
        {row.version ? <span className="break-all tabular">{row.version}</span> : null}
        {!component && row.framework ? <span>{row.framework}</span> : null}
        {component ? <SettingsCell parameters={row.parameters} /> : <ModeCell isDemo={row.is_demo} />}
      </div>
    </div>
  )
}

const MODEL_COLUMNS = [
  { key: 'name', header: 'Model', render: (row) => <NameCell row={row} /> },
  {
    key: 'framework',
    header: 'Framework',
    hideOnMobile: true,
    className: 'text-ink-2 align-top',
    render: (row) => row.framework || '—',
  },
  {
    key: 'version',
    header: 'Version',
    className: 'align-top',
    render: (row) => <span className="text-xs text-ink-2 tabular md:whitespace-nowrap">{row.version || '—'}</span>,
  },
  { key: 'status', header: 'Status', className: 'align-top', render: (row) => <StatusCell row={row} /> },
  { key: 'mode', header: 'Kind', hideOnMobile: true, className: 'align-top', render: (row) => <ModeCell isDemo={row.is_demo} /> },
]

const COMPONENT_COLUMNS = [
  { key: 'name', header: 'Component', render: (row) => <NameCell row={row} /> },
  {
    key: 'version',
    header: 'Version',
    className: 'align-top',
    render: (row) => <span className="text-xs text-ink-2 tabular md:whitespace-nowrap">{row.version || '—'}</span>,
  },
  { key: 'status', header: 'Status', className: 'align-top', render: (row) => <StatusCell row={row} /> },
  {
    key: 'parameters',
    header: 'Settings',
    hideOnMobile: true,
    className: 'align-top',
    render: (row) => <SettingsCell parameters={row.parameters} />,
  },
]

export function ModelRegistry({ modelInfo, className }) {
  const [tab, setTab] = useState('models')
  const models = Array.isArray(modelInfo?.models) ? modelInfo.models : []
  const components = Array.isArray(modelInfo?.components) ? modelInfo.components : []

  return (
    <div className={cn('min-w-0', className)}>
      <Tabs
        idPrefix="ai-registry"
        label="Model registry"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'models', label: 'Models', count: models.length },
          { id: 'components', label: 'Engine components', count: components.length },
        ]}
        className="px-4 sm:px-5"
      />
      <TabPanel tabId="models" value={tab} idPrefix="ai-registry">
        <DataTable
          columns={MODEL_COLUMNS}
          data={models}
          rowKey={(row, index) => `${row.name}-${row.version}-${index}`}
          caption="AI models"
          className="relative rounded-t-none border-0"
          mobileCard={(row) => <RegistryCard row={row} />}
        />
      </TabPanel>
      <TabPanel tabId="components" value={tab} idPrefix="ai-registry">
        <DataTable
          columns={COMPONENT_COLUMNS}
          data={components}
          rowKey={(row, index) => row.key ?? `${row.name}-${index}`}
          caption="AI engine components"
          className="relative rounded-t-none border-0"
          mobileCard={(row) => <RegistryCard row={row} component />}
        />
      </TabPanel>
    </div>
  )
}

export default ModelRegistry
