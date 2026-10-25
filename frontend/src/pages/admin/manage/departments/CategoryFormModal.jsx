/**
 * CategoryFormModal - create or edit a civic category (POST /categories/, PATCH /categories/{id}/).
 *
 * A category is data the AI engine reads at run time - no code change or retraining:
 * - keywords are blended into the text classifier's scores (English, Hinglish, Telugu terms all work),
 * - vision labels map detector / CLIP labels to the category,
 * - base severity (0-100) and the public-safety weight (0-1) feed the severity and priority engines,
 * - department / secondary department are its routing, the SLA override replaces the department deadline.
 * The slug is the class name the AI predicts; it is generated from the name and can never change after
 * creation (stored predictions refer to it), so it is read-only when editing.
 *
 * Props: open, onClose, category (CategoryOut | null), departments (DepartmentOut[]), onSaved(category)
 */
import { Lock, Save, Tag } from 'lucide-react'
import { useRef, useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { categoryService } from '@/services'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatHours, formatNumber } from '@/utils/format'
import { ColorField, IconPicker, RangeField, TagInput } from '../shared/FormControls'

const HEX = /^#[0-9A-F]{6}$/i
const SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

/** What the server will derive from the name (slugify -> underscores), shown as a preview. */
function slugPreview(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
}

function initialForm(category) {
  return {
    name: category?.name ?? '',
    slug: category?.slug ?? '',
    description: category?.description ?? '',
    icon: category?.icon ?? 'circle-alert',
    color: category?.color ?? '#6B7C85',
    department: category?.department != null ? String(category.department) : '',
    secondary_department: category?.secondary_department != null ? String(category.secondary_department) : '',
    keywords: Array.isArray(category?.keywords) ? category.keywords : [],
    vision_labels: Array.isArray(category?.vision_labels) ? category.vision_labels : [],
    base_severity: Number(category?.base_severity ?? 50),
    public_safety_weight: Number(category?.public_safety_weight ?? 0.5),
    sla_hours: category?.sla_hours != null ? String(category.sla_hours) : '',
    sort_order: String(category?.sort_order ?? 100),
    is_active: category?.is_active ?? true,
  }
}

const keywordNormalize = (term) => term.toLowerCase()
const labelNormalize = (term) => term.toLowerCase().replace(/\s+/g, '_')

export function CategoryFormModal({ open, onClose, category, departments, onSaved }) {
  const toast = useToast()
  const editing = Boolean(category)
  const [form, setForm] = useState(() => initialForm(category))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef(null)

  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }))
  }
  const bind = (key) => ({ value: form[key], onChange: (event) => set(key, event.target.value) })

  const departmentList = Array.isArray(departments) ? departments : []
  const departmentOptions = departmentList
    .filter((department) => department.is_active !== false || [form.department, form.secondary_department].includes(String(department.id)))
    .map((department) => ({
      value: String(department.id),
      label: department.is_active === false ? `${department.name} (inactive)` : department.name,
    }))
  const primary = departmentList.find((department) => String(department.id) === form.department)
  const slugShown = editing ? form.slug : form.slug || slugPreview(form.name)

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!form.name.trim()) nextErrors.name = 'Enter the category name citizens will see.'
    if (!editing && form.slug && !SLUG.test(form.slug)) nextErrors.slug = 'Use lower-case letters, digits and single underscores, e.g. broken_footpath.'
    if (!HEX.test(form.color.trim())) nextErrors.color = 'Enter a colour as #RRGGBB, e.g. #D9480F.'
    if (form.secondary_department && form.secondary_department === form.department) {
      nextErrors.secondary_department = 'Choose a different department than the primary one, or none.'
    }
    const sla = form.sla_hours === '' ? null : Number(form.sla_hours)
    if (sla !== null && (!Number.isInteger(sla) || sla < 1 || sla > 8760)) nextErrors.sla_hours = 'Enter whole hours from 1 to 8760, or leave it empty.'
    const sortOrder = Number(form.sort_order)
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 32767) nextErrors.sort_order = 'Enter a whole number from 0 to 32767.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      icon: form.icon,
      color: form.color.trim().toUpperCase(),
      department: form.department ? Number(form.department) : null,
      secondary_department: form.secondary_department ? Number(form.secondary_department) : null,
      keywords: form.keywords,
      vision_labels: form.vision_labels,
      base_severity: Math.round(form.base_severity),
      public_safety_weight: Math.round(form.public_safety_weight * 100) / 100,
      sla_hours: sla,
      sort_order: sortOrder,
      is_active: form.is_active,
    }
    if (!editing && form.slug) payload.slug = form.slug
    setSaving(true)
    setErrors({})
    try {
      const saved = editing ? await categoryService.update(category.id, payload) : await categoryService.create(payload)
      const name = saved?.name ?? payload.name
      toast.success(
        editing ? 'Category updated' : 'Category created',
        editing
          ? `${name} was saved.`
          : (saved?.is_active ?? payload.is_active)
            ? `${name} (${saved?.slug ?? slugShown}) is ready for the AI engine.`
            : `${name} (${saved?.slug ?? slugShown}) is saved but inactive: citizens and the AI engine use it once you activate it.`,
      )
      onSaved?.(saved)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error(editing ? 'Could not update the category' : 'Could not create the category', getErrorMessage(error))
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
      title={editing ? `Edit ${category.name}` : 'Add category'}
      description="Categories are what citizens report and what the AI engine predicts."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="category-form" loading={saving} leftIcon={editing ? Save : Tag}>
            {editing ? 'Save changes' : 'Add category'}
          </Button>
        </>
      }
    >
      <form id="category-form" onSubmit={submit} className="space-y-6" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" htmlFor="category-name" required error={errors.name}>
            <Input id="category-name" ref={firstFieldRef} {...bind('name')} maxLength={100} placeholder="Broken footpath" />
          </FormField>
          <FormField
            label="Slug (AI class name)"
            htmlFor="category-slug"
            optional={!editing}
            error={errors.slug}
            hint={editing ? 'Fixed after creation: stored AI predictions refer to it.' : `Leave empty to use “${slugPreview(form.name) || 'generated_from_name'}”.`}
          >
            <Input
              id="category-slug"
              value={editing ? form.slug : form.slug}
              onChange={(event) => set('slug', event.target.value.toLowerCase().replace(/[\s-]+/g, '_'))}
              readOnly={editing}
              placeholder={slugPreview(form.name) || 'broken_footpath'}
              maxLength={60}
              spellCheck={false}
              className="tabular"
              leftIcon={editing ? Lock : undefined}
            />
          </FormField>
        </div>
        <FormField label="Description" htmlFor="category-description" optional error={errors.description} hint="Also helps the production image model (CLIP prompts).">
          <Textarea id="category-description" {...bind('description')} rows={2} maxLength={500} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Icon" htmlFor="category-icon" error={errors.icon}>
            <IconPicker id="category-icon" value={form.icon} color={form.color} onChange={(icon) => set('icon', icon)} />
          </FormField>
          <FormField label="Colour" htmlFor="category-color" error={errors.color}>
            <ColorField id="category-color" value={form.color} onChange={(color) => set('color', color)} invalid={Boolean(errors.color)} />
          </FormField>
        </div>

        <section className="space-y-4 rounded-xl border border-line p-4">
          <h3 className="text-sm font-bold text-ink">Routing and deadline</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Department" htmlFor="category-department" error={errors.department} hint="Receives the complaints of this category.">
              <Select id="category-department" placeholder="General department (fallback)" options={departmentOptions} {...bind('department')} />
            </FormField>
            <FormField
              label="Secondary department"
              htmlFor="category-secondary"
              optional
              error={errors.secondary_department}
              hint="Used when the primary department is inactive."
            >
              <Select id="category-secondary" placeholder="None" options={departmentOptions} {...bind('secondary_department')} />
            </FormField>
            <FormField
              label="SLA override (hours)"
              htmlFor="category-sla"
              optional
              error={errors.sla_hours}
              hint={primary ? `Empty uses the department SLA: ${formatHours(primary.sla_hours)}.` : 'Empty uses the department SLA.'}
            >
              <Input id="category-sla" type="number" inputMode="numeric" min={1} max={8760} step={1} {...bind('sla_hours')} className="w-32 tabular" placeholder={primary ? String(primary.sla_hours) : ''} />
            </FormField>
            <FormField label="Sort order" htmlFor="category-sort" error={errors.sort_order} hint="Lower numbers are listed first in the report form.">
              <Input id="category-sort" type="number" inputMode="numeric" min={0} max={32767} step={1} {...bind('sort_order')} className="w-32 tabular" />
            </FormField>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-line p-4">
          <div>
            <h3 className="text-sm font-bold text-ink">What the AI engine uses</h3>
            <p className="mt-0.5 text-xs text-ink-3">Changes apply to the next analysis; nothing has to be retrained.</p>
          </div>
          <FormField label="Keywords" htmlFor="category-keywords" error={errors.keywords} hint="Words in a description that point to this category. Press Enter after each one.">
            <TagInput id="category-keywords" value={form.keywords} onChange={(keywords) => set('keywords', keywords)} normalize={keywordNormalize} placeholder="broken footpath, tiles missing" />
          </FormField>
          <FormField label="Vision labels" htmlFor="category-labels" error={errors.vision_labels} hint="Detector class names for photos; spaces become underscores.">
            <TagInput id="category-labels" value={form.vision_labels} onChange={(labels) => set('vision_labels', labels)} normalize={labelNormalize} placeholder="broken_footpath" />
          </FormField>
          <div className="grid gap-5 sm:grid-cols-2">
            <RangeField
              label="Base severity"
              value={form.base_severity}
              onChange={(value) => set('base_severity', value)}
              min={0}
              max={100}
              format={(value) => `${value}/100`}
              hint="How serious this kind of issue is before any photo or text evidence."
              error={errors.base_severity}
            />
            <RangeField
              label="Public-safety weight"
              value={form.public_safety_weight}
              onChange={(value) => set('public_safety_weight', value)}
              min={0}
              max={1}
              step={0.05}
              format={(value) => formatNumber(value, { digits: 2 })}
              hint="0 = no danger to people, 1 = direct danger (e.g. open manholes)."
              error={errors.public_safety_weight}
            />
          </div>
        </section>

        <Switch
          checked={form.is_active}
          onCheckedChange={(checked) => set('is_active', checked)}
          label="Active"
          description="Inactive categories are hidden from citizens and ignored by the AI engine."
        />
        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}

export default CategoryFormModal
