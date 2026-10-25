/**
 * The four steps of the report wizard. Each step is a controlled view of the form held by SubmitComplaint;
 * it renders fields, shows the field errors it owns, and reports changes through callbacks.
 *
 * - PhotoStep: FileDropzone (drag & drop, preview, replace / remove, "Take photo" with the rear camera on
 *   phones) + the live AI suggestion once a photo is chosen
 * - DetailsStep: description (10-2000 characters with a counter), the AI suggestion next to the optional
 *   category select, incident date and time (defaults to now, never in the future), optional title
 * - LocationStep: LocationPicker (search, GPS, click or drag) + the address fields it fills in, all editable
 * - ReviewStep: everything at a glance with an edit button per section, and the nearby-duplicates check
 */
import { ImagePlus, MapPin, Pencil, ScanLine, ScanSearch, ShieldCheck, Sun } from 'lucide-react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { LocationPicker } from '@/components/maps/LocationPicker'
import { MiniMap } from '@/components/maps/MiniMap'
import { Button } from '@/components/ui/Button'
import { FileDropzone } from '@/components/ui/FileDropzone'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { formatDateTime, formatFileSize, formatPercent } from '@/utils/format'
import { toRatio } from '@/components/ai/aiUtils'
import { AISuggestion } from './AISuggestion'
import {
  ADDRESS_FIELDS,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  STEP_INDEX,
  TITLE_MAX,
  parseLocalInputValue,
  toLocalInputValue,
} from './reportForm'
import { SimilarReports } from './SimilarReports'
import { useObjectUrl } from './useObjectUrl'

const PHOTO_TIPS = [
  { icon: ScanLine, text: 'Show the whole problem, with the road or a wall around it for scale.' },
  { icon: Sun, text: 'Daylight works best. Avoid blurry or very dark photos.' },
  { icon: ShieldCheck, text: 'Keep faces and number plates out of the frame where you can.' },
]

export function PhotoStep({ form, onImage, error, suggestion, categories, onApplyCategory, accept, maxSizeMB }) {
  const chipProps = { suggestion, selected: form.category, onApply: onApplyCategory, categories }
  return (
    // Container queries: next to the photo when the step itself is wide enough, under it otherwise (the
    // step is narrower on laptops, where the checklist rail takes a column).
    <div className="@container space-y-4">
      <div className={cn(form.image && 'grid gap-4 @xl:grid-cols-[minmax(0,1fr)_15rem] @xl:items-start')}>
        <FileDropzone
          id="report-photo"
          value={form.image}
          onChange={onImage}
          accept={accept}
          maxSizeMB={maxSizeMB}
          capture="environment"
          error={error}
          label={
            <>
              Photo <span className="font-normal text-ink-3">(optional, but it helps a lot)</span>
            </>
          }
        />
        {form.image ? (
          <>
            <AISuggestion {...chipProps} stacked className="hidden @xl:mt-7 @xl:block" />
            <AISuggestion {...chipProps} className="@xl:hidden" />
          </>
        ) : null}
      </div>
      <ul className="grid gap-2 rounded-xl bg-surface-2 px-4 py-3 text-xs text-ink-2 sm:grid-cols-3 sm:gap-4">
        {PHOTO_TIPS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2">
            <Icon aria-hidden className="mt-px size-4 shrink-0 text-ink-3" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function DetailsStep({ form, errors, onField, suggestion, categories, onApplyCategory }) {
  const categoryOptions = (categories ?? []).map((category) => ({ value: category.slug, label: category.name }))
  const nowValue = toLocalInputValue(new Date())
  return (
    <div className="space-y-5">
      <FormField
        label="What is the problem?"
        htmlFor="report-description"
        required
        error={errors.description}
        hint={`At least ${DESCRIPTION_MIN} characters. Say what it is, how big it is and whether it is dangerous.`}
      >
        <Textarea
          id="report-description"
          rows={5}
          maxLength={DESCRIPTION_MAX}
          value={form.description}
          onChange={(event) => onField('description', event.target.value)}
          placeholder="For example: deep pothole in the left lane outside the Ameerpet metro exit. Two-wheelers swerve into traffic to avoid it."
        />
      </FormField>

      <AISuggestion
        suggestion={suggestion}
        selected={form.category}
        onApply={onApplyCategory}
        categories={categories}
        idleHint="Write at least 15 characters, or add a photo, and the AI suggests a category."
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          label="Category"
          htmlFor="report-category"
          optional
          error={errors.category}
          hint="Your choice is a hint. The AI checks the photo and the description either way."
        >
          <Select
            id="report-category"
            placeholder="Not sure, let the AI decide"
            options={categoryOptions}
            value={form.category}
            onChange={(event) => onField('category', event.target.value)}
          />
        </FormField>
        <FormField
          label="When did you notice it?"
          htmlFor="report-incident"
          required
          error={errors.incident_at}
          hint="Set to now. Change it if you saw the problem earlier."
        >
          <Input
            id="report-incident"
            type="datetime-local"
            max={nowValue}
            value={form.incidentAt}
            onChange={(event) => onField('incidentAt', event.target.value)}
          />
        </FormField>
      </div>

      <FormField
        label="Short title"
        htmlFor="report-title"
        optional
        error={errors.title}
        hint="Leave it empty and CivicAI writes one from the category and the place."
      >
        <Input
          id="report-title"
          maxLength={TITLE_MAX}
          value={form.title}
          onChange={(event) => onField('title', event.target.value)}
          placeholder="For example: Deep pothole outside Ameerpet metro"
        />
      </FormField>
    </div>
  )
}

export function LocationStep({ form, errors, onPosition, onAddress, onAddressField, addressSource }) {
  const wide = useMediaQuery(BREAKPOINTS.md)
  const fieldError = (key) => errors[key]
  return (
    <div className="space-y-5">
      <LocationPicker
        value={form.position}
        onChange={onPosition}
        onAddress={onAddress}
        height={wide ? 360 : 300}
        error={errors.latitude || errors.longitude}
      />
      <fieldset className="min-w-0 space-y-4">
        <legend className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-ink">
          Address
          {addressSource ? (
            <span className="text-xs font-normal text-ink-3">
              {addressSource === 'fallback'
                ? 'Approximate address from the map. Please check it.'
                : 'Filled in from the map pin. Correct anything that is wrong.'}
            </span>
          ) : (
            <span className="text-xs font-normal text-ink-3">Filled in automatically when you place the pin.</span>
          )}
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {ADDRESS_FIELDS.map((field) => (
            <FormField
              key={field.key}
              label={field.label}
              htmlFor={`report-${field.key}`}
              optional
              error={fieldError(field.key)}
              className={cn(field.key === 'address' && 'sm:col-span-2')}
              hint={field.key === 'landmark' ? 'A shop, school or bus stop nearby helps the officer find the spot.' : undefined}
            >
              <Input
                id={`report-${field.key}`}
                value={form.address[field.key]}
                maxLength={field.maxLength}
                autoComplete={field.autoComplete}
                inputMode={field.key === 'pincode' ? 'numeric' : undefined}
                onChange={(event) => onAddressField(field.key, event.target.value)}
              />
            </FormField>
          ))}
        </div>
      </fieldset>
    </div>
  )
}

function ReviewSection({ title, editLabel, onEdit, children, className }) {
  return (
    <section className={cn('border-t border-line py-4 first:border-t-0 first:pt-0', className)}>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="font-display text-sm font-bold text-ink">{title}</h3>
        <Button size="sm" variant="ghost" leftIcon={Pencil} onClick={onEdit}>
          {editLabel}
        </Button>
      </div>
      {children}
    </section>
  )
}

export function ReviewStep({ form, categories, suggestion, similar, ownIds, onEdit }) {
  const photoUrl = useObjectUrl(form.image)
  const chosen = (categories ?? []).find((category) => category.slug === form.category) ?? null
  const suggested = suggestion?.result?.category ?? null
  const suggestedRatio = toRatio(suggestion?.result?.fusion?.confidence)
  const incident = parseLocalInputValue(form.incidentAt)
  const address = form.address
  const locality = [address.area, [address.city, address.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ')

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line px-4 py-4 sm:px-5">
        <ReviewSection title="Photo" editLabel={form.image ? 'Change photo' : 'Add photo'} onEdit={() => onEdit(STEP_INDEX.photo)}>
          {form.image && photoUrl ? (
            <div className="flex items-center gap-3">
              <img src={photoUrl} alt="Your photo of the problem" className="h-20 w-28 shrink-0 rounded-lg bg-sunken object-cover" />
              <div className="min-w-0 text-xs text-ink-3">
                <p className="truncate font-medium text-ink-2">{form.image.name}</p>
                <p className="tabular">{formatFileSize(form.image.size)}</p>
              </div>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink-3">
              <ImagePlus aria-hidden className="size-4" />
              No photo. The AI will decide from the description alone.
            </p>
          )}
        </ReviewSection>

        <ReviewSection title="Details" editLabel="Edit details" onEdit={() => onEdit(STEP_INDEX.details)}>
          <p className="whitespace-pre-line break-words text-sm text-ink">{form.description.trim()}</p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-xs font-medium text-ink-3">Category</dt>
              <dd className="mt-1">
                {chosen ? (
                  <CategoryBadge category={chosen} size="sm" />
                ) : (
                  <span className="text-ink-2">
                    Let the AI decide
                    {suggested ? (
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                        Likely <CategoryBadge category={suggested} size="sm" />
                        {suggestedRatio != null ? <span className="tabular">{formatPercent(suggestedRatio)}</span> : null}
                      </span>
                    ) : null}
                  </span>
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium text-ink-3">Noticed</dt>
              <dd className="mt-1 text-ink-2 tabular">{incident ? formatDateTime(incident) : 'Now'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium text-ink-3">Title</dt>
              <dd className="mt-1 break-words text-ink-2">{form.title.trim() || 'Written automatically'}</dd>
            </div>
          </dl>
        </ReviewSection>

        <ReviewSection title="Location" editLabel="Edit location" onEdit={() => onEdit(STEP_INDEX.location)}>
          {form.position ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="min-w-0 text-sm">
                <p className="flex items-start gap-1.5 font-medium text-ink">
                  <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-ink" />
                  <span className="min-w-0 break-words">{address.address || 'Pinned on the map'}</span>
                </p>
                {address.landmark ? <p className="mt-1 pl-[22px] text-ink-2">Near {address.landmark}</p> : null}
                {locality ? <p className="mt-1 pl-[22px] text-ink-2">{locality}</p> : null}
                <p className="mt-1 pl-[22px] text-xs text-ink-3 tabular">
                  {form.position.lat.toFixed(6)}, {form.position.lng.toFixed(6)}
                </p>
              </div>
              <MiniMap lat={form.position.lat} lng={form.position.lng} height={140} showLinks={false} label="Pinned location" />
            </div>
          ) : (
            <p className="text-sm text-signal-600 dark:text-signal-300">No location yet. Place the pin on the map.</p>
          )}
        </ReviewSection>
      </div>

      <SimilarReports similar={similar} ownIds={ownIds} />

      <p className="flex items-start gap-2 text-xs text-ink-3">
        <ScanSearch aria-hidden className="mt-px size-3.5 shrink-0" />
        Submitting runs the AI analysis: it classifies the photo and the description, scores severity and priority,
        checks for duplicates and routes the complaint to a department and an officer.
      </p>
    </div>
  )
}
