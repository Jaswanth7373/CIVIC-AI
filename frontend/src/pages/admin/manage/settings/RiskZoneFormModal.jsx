/**
 * RiskZoneFormModal - create or edit a risk zone (POST /risk-zones/, PATCH /risk-zones/{id}/).
 *
 * A risk zone is a sensitive place (school, hospital, junction ...) with a radius and a 1-5 risk level. The
 * location-risk engine raises the priority of complaints inside it, scaled by the level and the proximity.
 *
 * Props: open, onClose, zone (RiskZone | null), onSaved(zone)
 */
import { MapPinPlus, Save } from 'lucide-react'
import { useRef, useState } from 'react'
import { LocationPicker } from '@/components/maps'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { systemService } from '@/services'
import { RISK_ZONE_TYPES } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatDistance } from '@/utils/format'
import { RangeField } from '../shared/FormControls'
import { RISK_LEVEL_LABELS } from './riskZoneMeta'

function initialForm(zone) {
  return {
    name: zone?.name ?? '',
    zone_type: zone?.zone_type ?? 'school',
    location: zone ? { lat: Number(zone.latitude), lng: Number(zone.longitude) } : null,
    radius_m: Number(zone?.radius_m ?? 300),
    risk_level: Number(zone?.risk_level ?? 3),
    description: zone?.description ?? '',
    is_active: zone?.is_active ?? true,
  }
}

export default function RiskZoneFormModal({ open, onClose, zone, onSaved }) {
  const toast = useToast()
  const editing = Boolean(zone)
  const [form, setForm] = useState(() => initialForm(zone))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef(null)

  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }))
  }

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!form.name.trim()) nextErrors.name = 'Name the place, e.g. "Government school, Ameerpet".'
    if (!form.location) nextErrors.location = 'Place the zone on the map: search, use your location or click the map.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    const payload = {
      name: form.name.trim(),
      zone_type: form.zone_type,
      latitude: form.location.lat,
      longitude: form.location.lng,
      radius_m: Math.round(form.radius_m),
      risk_level: Math.round(form.risk_level),
      description: form.description.trim(),
      is_active: form.is_active,
    }
    setSaving(true)
    setErrors({})
    try {
      const saved = editing ? await systemService.updateRiskZone(zone.id, payload) : await systemService.createRiskZone(payload)
      const name = saved?.name ?? payload.name
      toast.success(
        editing ? 'Risk zone updated' : 'Risk zone added',
        (saved?.is_active ?? payload.is_active)
          ? `${name} now affects the location risk of nearby complaints.`
          : `${name} is saved but switched off, so it does not change any priority until you activate it.`,
      )
      onSaved?.(saved)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error(editing ? 'Could not update the risk zone' : 'Could not add the risk zone', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      initialFocusRef={firstFieldRef}
      onClose={saving ? undefined : onClose}
      size="xl"
      title={editing ? `Edit ${zone.name}` : 'Add risk zone'}
      description="Complaints inside the radius get a higher location-risk factor in their priority."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="risk-zone-form" loading={saving} leftIcon={editing ? Save : MapPinPlus}>
            {editing ? 'Save changes' : 'Add risk zone'}
          </Button>
        </>
      }
    >
      <form id="risk-zone-form" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" htmlFor="zone-name" required error={errors.name}>
            <Input id="zone-name" ref={firstFieldRef} value={form.name} onChange={(event) => set('name', event.target.value)} maxLength={150} />
          </FormField>
          <FormField label="Type" htmlFor="zone-type" error={errors.zone_type}>
            <Select id="zone-type" value={form.zone_type} onChange={(event) => set('zone_type', event.target.value)} options={RISK_ZONE_TYPES} />
          </FormField>
        </div>
        <div>
          <LocationPicker
            value={form.location}
            onChange={(location) => set('location', location)}
            onAddress={(address) => {
              if (!form.name.trim() && address?.display_name) set('name', address.display_name.split(',')[0])
            }}
            height={280}
            label="Risk zone location"
            error={errors.location || errors.latitude || errors.longitude}
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <RangeField
            label="Radius"
            value={form.radius_m}
            onChange={(value) => set('radius_m', value)}
            min={10}
            max={5000}
            step={10}
            format={(value) => formatDistance(value)}
            hint="Complaints within this distance count as inside the zone."
            error={errors.radius_m}
          />
          <RangeField
            label="Risk level"
            value={form.risk_level}
            onChange={(value) => set('risk_level', value)}
            min={1}
            max={5}
            step={1}
            format={(value) => `${value}/5 ${RISK_LEVEL_LABELS[value] ?? ''}`.trim()}
            hint="5 = places where an issue endangers many people (school gates, hospital entrances)."
            error={errors.risk_level}
          />
        </div>
        <FormField label="Description" htmlFor="zone-description" optional error={errors.description}>
          <Textarea id="zone-description" value={form.description} onChange={(event) => set('description', event.target.value)} maxLength={255} rows={2} />
        </FormField>
        <Switch
          checked={form.is_active}
          onCheckedChange={(checked) => set('is_active', checked)}
          label="Active"
          description="Inactive zones are kept but ignored by the location-risk engine."
        />
        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}
