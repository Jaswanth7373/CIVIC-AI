/**
 * RiskZonesTab - the sensitive places used by the location-risk engine, on a map and in a table.
 *
 * Data: GET /risk-zones/ (non-paginated). Create / edit in a modal with a map picker; delete asks first
 * (DELETE /risk-zones/{id}/). On the map each zone is a circle of its real radius, filled in a single-hue
 * sequential scale by risk level (legend below the map), inactive zones dashed and grey. Lazy-loaded by the
 * settings page because it uses Leaflet.
 */
import { MapPinPlus, MapPinned, MoreHorizontal, Pencil, ShieldAlert, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Circle, Tooltip as MapTooltip } from 'react-leaflet'
import { BaseMap, FitBounds } from '@/components/maps'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataTable } from '@/components/ui/DataTable'
import { DropdownMenu } from '@/components/ui/DropdownMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import { systemService } from '@/services'
import { getErrorMessage } from '@/utils/errors'
import { formatDistance, formatNumber } from '@/utils/format'
import { SummaryLine } from '../shared/Controls'
import { toList } from '../shared/listUtils'
import RiskZoneFormModal from './RiskZoneFormModal'
import { RISK_LEVEL_COLORS, RISK_LEVEL_LABELS, riskColor, zoneTypeLabel } from './riskZoneMeta'

function RiskLevel({ level }) {
  const value = Math.round(Number(level) || 0)
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap" title={RISK_LEVEL_LABELS[value]}>
      <span aria-hidden className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((step) => (
          <span key={step} className="h-3 w-1.5 rounded-sm" style={{ backgroundColor: step <= value ? riskColor(value) : 'var(--c-sunken)' }} />
        ))}
      </span>
      <span className="text-xs font-semibold text-ink tabular">{value}/5</span>
    </span>
  )
}

function ZoneMap({ zones, onSelect }) {
  const points = useMemo(() => zones.map((zone) => ({ latitude: zone.latitude, longitude: zone.longitude })), [zones])
  return (
    <BaseMap height={null} className="h-[340px] sm:h-[420px]" label="Risk zones map">
      {zones.map((zone) => {
        const color = zone.is_active ? riskColor(zone.risk_level) : '#8c9a96'
        return (
          <Circle
            key={zone.id}
            center={[Number(zone.latitude), Number(zone.longitude)]}
            radius={Number(zone.radius_m) || 100}
            pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: zone.is_active ? 0.22 : 0.08, dashArray: zone.is_active ? undefined : '6 6' }}
            eventHandlers={{ click: () => onSelect(zone) }}
          >
            <MapTooltip direction="top" sticky>
              <span className="font-sans text-xs">
                <strong>{zone.name}</strong>
                <br />
                {zoneTypeLabel(zone.zone_type)}, risk {zone.risk_level}/5, {formatDistance(zone.radius_m)}
                {zone.is_active ? '' : ', inactive'}
              </span>
            </MapTooltip>
          </Circle>
        )
      })}
      {points.length ? <FitBounds points={points} padding={36} maxZoom={15} /> : null}
    </BaseMap>
  )
}

export function RiskZonesTab() {
  const toast = useToast()
  const confirm = useConfirm()
  const zones = useApi(() => systemService.riskZones(), [])
  const [form, setForm] = useState({ open: false, zone: null, session: 0 })
  const [pendingId, setPendingId] = useState(null)
  const rows = toList(zones.data)

  const openForm = (zone = null) => setForm((current) => ({ open: true, zone, session: current.session + 1 }))
  const closeForm = () => setForm((current) => ({ ...current, open: false }))

  const remove = async (zone) => {
    const ok = await confirm({
      title: `Delete ${zone.name}?`,
      message: 'New complaints near it no longer get its location-risk bonus. Existing priorities stay until they are recalculated. To pause it instead, edit the zone and switch it off.',
      confirmLabel: 'Delete risk zone',
      tone: 'danger',
    })
    if (!ok) return
    setPendingId(zone.id)
    try {
      await systemService.deleteRiskZone(zone.id)
      toast.success('Risk zone deleted', `${zone.name} was removed.`)
      zones.refetch()
    } catch (error) {
      toast.error('Could not delete the risk zone', getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  // Shared by the table's last column and the phone cards (below md the table renders as cards only).
  const actionsMenu = (row) => (
    <DropdownMenu
      label={`Actions for ${row.name}`}
      trigger={<IconButton icon={MoreHorizontal} label={`Actions for ${row.name}`} size="sm" loading={pendingId === row.id} />}
      items={[
        { label: 'Edit risk zone', icon: Pencil, onClick: () => openForm(row) },
        { divider: true },
        { label: 'Delete risk zone', icon: Trash2, danger: true, onClick: () => remove(row) },
      ]}
    />
  )

  const columns = [
    {
      key: 'name',
      header: 'Zone',
      className: 'max-w-72',
      render: (row) => (
        <span className="block min-w-0">
          <span className="block truncate font-semibold text-ink">{row.name}</span>
          <span className="block truncate text-xs text-ink-3">{row.zone_type_display ?? zoneTypeLabel(row.zone_type)}</span>
        </span>
      ),
    },
    { key: 'risk', header: 'Risk level', render: (row) => <RiskLevel level={row.risk_level} /> },
    { key: 'radius', header: 'Radius', align: 'right', render: (row) => <span className="tabular">{formatDistance(row.radius_m)}</span> },
    {
      key: 'location',
      header: 'Coordinates',
      hideOnMobile: true,
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-ink-2 tabular">
          {Number(row.latitude).toFixed(5)}, {Number(row.longitude).toFixed(5)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={row.is_active ? 'green' : 'neutral'} size="sm" dot>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: actionsMenu,
    },
  ]

  if (zones.error && !zones.data) {
    return <ErrorState title="Risk zones could not be loaded" error={zones.error} onRetry={() => zones.refetch()} />
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          icon={MapPinned}
          title="Where the location risk comes from"
          description="Complaints inside a zone score higher on location risk, the more so the closer they are and the higher its level."
          actions={
            <Button leftIcon={MapPinPlus} onClick={() => openForm(null)}>
              Add risk zone
            </Button>
          }
        />
        <CardBody>
          {!zones.data ? <Skeleton className="h-[340px] w-full rounded-xl sm:h-[420px]" /> : <ZoneMap zones={rows} onSelect={openForm} />}
          <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-2" aria-label="Risk level legend">
            {Object.entries(RISK_LEVEL_COLORS).map(([level, color]) => (
              <li key={level} className="flex items-center gap-1.5">
                <span aria-hidden className="size-3 rounded-full border-2" style={{ borderColor: color, backgroundColor: `${color}55` }} />
                <span className="tabular">{level}</span> {RISK_LEVEL_LABELS[level]}
              </li>
            ))}
            <li className="flex items-center gap-1.5 text-ink-3">
              <span aria-hidden className="size-3 rounded-full border-2 border-dashed border-asphalt-400" />
              Inactive
            </li>
          </ul>
        </CardBody>
      </Card>

      <div>
        <SummaryLine className="mb-2" count={zones.data ? rows.length : undefined} noun="risk zone" loading={zones.loading && Boolean(zones.data)}>
          {zones.data ? <span className="text-ink-3">{formatNumber(rows.filter((row) => row.is_active).length)} active</span> : null}
        </SummaryLine>
        <DataTable
          caption="Risk zones"
          className="relative"
          columns={columns}
          data={rows}
          loading={zones.loading}
          rowKey="id"
          onRowClick={(row) => openForm(row)}
          rowClassName={(row) => (row.is_active ? undefined : 'opacity-70')}
          empty={
            <EmptyState
              bordered={false}
              icon={ShieldAlert}
              title="No risk zones yet"
              description="Add schools, hospitals, junctions and markets so complaints near them are prioritised."
              action={
                <Button leftIcon={MapPinPlus} onClick={() => openForm(null)}>
                  Add risk zone
                </Button>
              }
            />
          }
          mobileCard={(row) => (
            <div className="flex items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{row.name}</p>
                <p className="text-xs text-ink-3">
                  {row.zone_type_display ?? zoneTypeLabel(row.zone_type)}, {formatDistance(row.radius_m)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <RiskLevel level={row.risk_level} />
                <Badge tone={row.is_active ? 'green' : 'neutral'} size="sm" dot>
                  {row.is_active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <div className="-mr-1.5 -mt-1 shrink-0">{actionsMenu(row)}</div>
            </div>
          )}
        />
      </div>

      <RiskZoneFormModal
        key={form.session}
        open={form.open}
        onClose={closeForm}
        zone={form.zone}
        onSaved={() => {
          closeForm()
          zones.refetch()
        }}
      />
    </div>
  )
}

export default RiskZonesTab
