/**
 * Form controls of the admin editors (departments, categories, officers, AI settings).
 *
 * - TagInput: a list of short terms (category keywords, vision labels, officer skills) as removable chips.
 *   Enter or a comma adds the typed term, Backspace in the empty box removes the last chip, and a pasted
 *   comma / line separated list is split into chips. Inside a <FormField> the id and aria wiring are automatic.
 * - ColorField: native colour picker + a #RRGGBB text box (the API stores upper-case hex) + the palette of the
 *   default categories as quick swatches.
 * - IconPicker: searchable grid of the curated civic icons (utils/icons ICON_OPTIONS) in a popover. The grid
 *   is a radio group with a roving tab stop: arrow keys move, Enter / Space choose.
 * - RangeField: a labelled slider with its formatted value (base severity, safety weight, priority what-ifs).
 */
import { ChevronDown, Search, X } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { readableInk, safeColor } from '@/components/charts/palette'
import { Input } from '@/components/ui/Input'
import { Popover } from '@/components/ui/Popover'
import { FIELD_BASE } from '@/components/ui/fieldStyles'
import { useFormFieldProps } from '@/components/ui/formFieldContext'
import { cn } from '@/utils/cn'
import { ICON_OPTIONS, getIcon, renderIcon } from '@/utils/icons'

/* ---------------------------------------------------------------------------------------------------------- */
/* TagInput                                                                                                   */
/* ---------------------------------------------------------------------------------------------------------- */

const SPLIT = /[,\n;]/

/**
 * @param {{value: string[], onChange: (next: string[]) => void, placeholder?: string,
 *   normalize?: (term: string) => string, maxItems?: number, invalid?: boolean, disabled?: boolean,
 *   id?: string, 'aria-describedby'?: string, className?: string}} props
 */
export function TagInput({ value = [], onChange, placeholder = 'Type and press Enter', normalize, maxItems = 100, invalid, disabled, className, ...props }) {
  const fieldProps = useFormFieldProps(props)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)
  const tags = Array.isArray(value) ? value : []
  const isInvalid = Boolean(invalid) || fieldProps['aria-invalid'] === true || fieldProps['aria-invalid'] === 'true'

  const clean = (term) => {
    const text = String(term ?? '').replace(/\s+/g, ' ').trim()
    return normalize ? normalize(text) : text
  }

  const add = (raw) => {
    const terms = String(raw ?? '')
      .split(SPLIT)
      .map(clean)
      .filter(Boolean)
    if (!terms.length) return
    const seen = new Set(tags.map((tag) => tag.toLowerCase()))
    const next = [...tags]
    terms.forEach((term) => {
      if (!seen.has(term.toLowerCase()) && next.length < maxItems) {
        seen.add(term.toLowerCase())
        next.push(term)
      }
    })
    if (next.length !== tags.length) onChange?.(next)
    setDraft('')
  }

  const remove = (index) => {
    onChange?.(tags.filter((_, position) => position !== index))
    inputRef.current?.focus()
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add(draft)
    } else if (event.key === 'Backspace' && !draft && tags.length) {
      event.preventDefault()
      remove(tags.length - 1)
    }
  }

  const handlePaste = (event) => {
    const text = event.clipboardData?.getData('text') ?? ''
    if (SPLIT.test(text)) {
      event.preventDefault()
      add(`${draft},${text}`)
    }
  }

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) inputRef.current?.focus()
      }}
      className={cn(
        'flex min-h-10 w-full min-w-0 cursor-text flex-wrap items-center gap-1.5 rounded-lg border bg-surface p-1.5 transition-colors',
        'focus-within:border-primary focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
        isInvalid ? 'border-signal-500 dark:border-signal-400' : 'border-line-strong hover:border-ink-3',
        disabled && 'cursor-not-allowed bg-surface-2 opacity-70',
        className,
      )}
    >
      {tags.map((tag, index) => (
        <span
          key={`${tag}-${index}`}
          className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-surface-2 py-0.5 pl-2 pr-0.5 text-xs font-medium text-ink ring-1 ring-inset ring-line"
        >
          <span className="truncate">{tag}</span>
          {!disabled ? (
            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove ${tag}`}
              className="grid size-5 shrink-0 place-items-center rounded text-ink-3 transition-colors hover:bg-sunken hover:text-ink pointer-coarse:size-8"
            >
              <X aria-hidden className="size-3" />
            </button>
          ) : null}
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        {...fieldProps}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => add(draft)}
        placeholder={tags.length >= maxItems ? 'Limit reached' : tags.length ? 'Add another' : placeholder}
        enterKeyHint="enter"
        autoComplete="off"
        aria-invalid={isInvalid || undefined}
        className="min-w-[9rem] flex-1 bg-transparent px-1.5 py-1 text-base text-ink placeholder:text-ink-3 focus-visible:outline-hidden sm:text-sm"
      />
    </div>
  )
}

/* ---------------------------------------------------------------------------------------------------------- */
/* ColorField                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

/** Colours of the default categories (BUILD_SPEC section 1) - a starting point that matches existing data. */
const PRESET_COLORS = ['#D9480F', '#9C6B30', '#0B8EA8', '#E0A800', '#3B5BDB', '#C92A2A', '#9C36B5', '#2F9E44', '#6B7C85']
const HEX6 = /^#[0-9a-f]{6}$/i

/**
 * @param {{value: string, onChange: (hex: string) => void, id?: string, invalid?: boolean}} props
 */
export function ColorField({ value, onChange, id, invalid, ...props }) {
  const fieldProps = useFormFieldProps({ id, ...props })
  const valid = HEX6.test(String(value ?? '').trim())
  const picker = valid ? String(value).trim().toLowerCase() : '#6b7c85'
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={picker}
          onChange={(event) => onChange?.(event.target.value.toUpperCase())}
          aria-label="Pick a colour"
          className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-line-strong bg-surface p-1 pointer-coarse:h-11"
        />
        <Input
          {...fieldProps}
          value={value ?? ''}
          onChange={(event) => onChange?.(event.target.value.toUpperCase())}
          placeholder="#D9480F"
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          invalid={invalid}
          className="w-32 tabular"
        />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested colours">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange?.(color)}
            aria-label={`Use colour ${color}`}
            aria-pressed={String(value).toUpperCase() === color}
            className={cn(
              'size-6 rounded-md ring-1 ring-inset ring-black/10 transition-transform hover:scale-110 pointer-coarse:size-9',
              String(value).toUpperCase() === color && 'outline-2 outline-offset-2 outline-ink',
            )}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------------------------------------- */
/* IconPicker                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

const GRID_COLUMNS = 6

/** Coloured sign plate with the icon (same look as CategoryBadge / DepartmentBadge plates). */
export function IconPlate({ icon, color, size = 'md', className }) {
  const fill = safeColor(color, '#6a7a77')
  const sizes = size === 'lg' ? 'size-10 rounded-lg [&_svg]:size-5' : size === 'sm' ? 'size-6 rounded-md [&_svg]:size-3.5' : 'size-8 rounded-md [&_svg]:size-4'
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center', sizes, className)} style={{ backgroundColor: fill, color: readableInk(fill) }}>
      {renderIcon(getIcon(icon), { strokeWidth: 2.2 })}
    </span>
  )
}

function IconGrid({ value, onPick }) {
  const [query, setQuery] = useState('')
  const gridRef = useRef(null)
  const term = query.trim().toLowerCase()
  const options = useMemo(
    () => (term ? ICON_OPTIONS.filter((option) => option.label.toLowerCase().includes(term) || option.value.includes(term)) : ICON_OPTIONS),
    [term],
  )
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const [focusIndex, setFocusIndex] = useState(null)
  const activeIndex = focusIndex != null && focusIndex < options.length ? focusIndex : selectedIndex

  const moveTo = (index) => {
    const next = Math.min(options.length - 1, Math.max(0, index))
    setFocusIndex(next)
    gridRef.current?.querySelectorAll('[role="radio"]')[next]?.focus()
  }

  const handleKeyDown = (event) => {
    const moves = {
      ArrowRight: activeIndex + 1,
      ArrowLeft: activeIndex - 1,
      ArrowDown: activeIndex + GRID_COLUMNS,
      ArrowUp: activeIndex - GRID_COLUMNS,
      Home: 0,
      End: options.length - 1,
    }
    if (event.key in moves) {
      event.preventDefault()
      moveTo(moves[event.key])
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setFocusIndex(null)
          }}
          placeholder="Search icons"
          aria-label="Search icons"
          className={cn(FIELD_BASE, 'h-9 pl-9 pr-3 pointer-coarse:h-11')}
        />
      </div>
      {options.length ? (
        <div
          ref={gridRef}
          role="radiogroup"
          aria-label="Icons"
          onKeyDown={handleKeyDown}
          className="scrollbar-thin grid max-h-64 grid-cols-6 gap-1 overflow-y-auto pr-1"
        >
          {options.map((option, index) => {
            const checked = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={option.label}
                title={option.label}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => onPick(option.value)}
                onFocus={() => setFocusIndex(index)}
                className={cn(
                  'grid aspect-square place-items-center rounded-md text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:-outline-offset-2',
                  checked && 'bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary',
                )}
              >
                <option.Icon aria-hidden className="size-5" />
              </button>
            )
          })}
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-ink-3">No icon matches “{query.trim()}”.</p>
      )}
    </div>
  )
}

/**
 * @param {{value: string, onChange: (name: string) => void, color?: string, id?: string}} props
 */
export function IconPicker({ value, onChange, color, id, ...props }) {
  const fieldProps = useFormFieldProps({ id, ...props })
  const current = ICON_OPTIONS.find((option) => option.value === value)
  return (
    <Popover
      label="Choose an icon"
      placement="bottom-start"
      panelClassName="w-[min(20rem,calc(100vw-2rem))] p-3"
      trigger={
        <button
          type="button"
          id={fieldProps.id}
          aria-describedby={fieldProps['aria-describedby']}
          className={cn(FIELD_BASE, 'inline-flex h-10 items-center gap-2.5 px-1.5 pr-3 text-left pointer-coarse:h-11')}
        >
          <IconPlate icon={value} color={color} size="sm" className="size-7" />
          <span className="min-w-0 flex-1 truncate">{current?.label ?? (value || 'Choose an icon')}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-3" />
        </button>
      }
    >
      {({ close }) => (
        <IconGrid
          value={value}
          onPick={(name) => {
            onChange?.(name)
            close()
          }}
        />
      )}
    </Popover>
  )
}

/* ---------------------------------------------------------------------------------------------------------- */
/* RangeField                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * @param {{label: import('react').ReactNode, value: number, onChange: (value: number) => void, min?: number,
 *   max?: number, step?: number, format?: (value: number) => string, hint?: import('react').ReactNode,
 *   error?: string, disabled?: boolean, id?: string, className?: string}} props
 */
export function RangeField({ label, value, onChange, min = 0, max = 100, step = 1, format, hint, error, disabled, id, className }) {
  const autoId = useId()
  const inputId = id ?? `range-${autoId}`
  const number = Number.isFinite(Number(value)) ? Number(value) : min
  const text = format ? format(number) : String(number)
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <label htmlFor={inputId} className="text-sm font-semibold text-ink">
          {label}
        </label>
        <output htmlFor={inputId} className="font-display text-base font-bold text-ink tabular">
          {text}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={number}
        disabled={disabled}
        aria-valuetext={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${inputId}-help` : undefined}
        onChange={(event) => onChange?.(Number(event.target.value))}
        className="h-6 w-full cursor-pointer accent-primary disabled:cursor-not-allowed pointer-coarse:h-10"
      />
      {hint || error ? (
        <p id={`${inputId}-help`} className={cn('mt-0.5 text-xs', error ? 'font-medium text-signal-600 dark:text-signal-300' : 'text-ink-3')}>
          {error || hint}
        </p>
      ) : null}
    </div>
  )
}
