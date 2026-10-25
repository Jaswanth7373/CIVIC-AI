import { Camera, ImagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/utils/cn'
import { formatFileSize } from '@/utils/format'
import { Button } from './Button'

const TYPE_LABELS = {
  'image/jpeg': 'JPG',
  'image/jpg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/*': 'image',
  'application/pdf': 'PDF',
}

function acceptRules(accept) {
  return String(accept ?? '')
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
}

/** "image/jpeg,image/png,image/webp" -> "JPG, PNG or WebP" */
function describeAccept(accept) {
  const labels = [...new Set(acceptRules(accept).map((rule) => TYPE_LABELS[rule] ?? rule.replace(/^\./, '').toUpperCase()))]
  if (!labels.length) return 'Any file'
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`
}

/** Same matching rules as the `accept` attribute: exact MIME type, `type/*` wildcard or `.ext`. */
function matchesAccept(file, accept) {
  const rules = acceptRules(accept)
  if (!rules.length) return true
  const type = (file.type || '').toLowerCase()
  const name = (file.name || '').toLowerCase()
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule)
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1))
    return type === rule
  })
}

/**
 * Image picker with drag & drop, preview, replace / remove and (on touch devices) a camera button.
 *
 * Files are validated in the browser first (type against `accept`, size against `maxSizeMB`) so mistakes
 * are reported instantly; the server validates again. The preview uses an object URL that is revoked when
 * the file changes or the component unmounts (no memory leak).
 *
 * @param {object} props
 * @param {File|null} props.value selected file
 * @param {(file: File|null) => void} props.onChange
 * @param {string} [props.previewUrl] existing image to show when no new file is selected
 * @param {string} [props.accept='image/jpeg,image/png,image/webp']
 * @param {number} [props.maxSizeMB=8]
 * @param {boolean|'environment'|'user'} [props.capture] shows "Take photo" (rear camera by default) on phones
 * @param {import('react').ReactNode} [props.label='Photo']
 * @param {import('react').ReactNode} [props.hint]
 * @param {string} [props.error]
 * @param {(message: string) => void} [props.onError] called when a dropped / chosen file is rejected
 */
export function FileDropzone({
  value = null,
  onChange,
  previewUrl,
  accept = 'image/jpeg,image/png,image/webp',
  maxSizeMB = 8,
  capture,
  label = 'Photo',
  hint,
  error,
  disabled = false,
  required = false,
  id,
  className,
  onError,
}) {
  const inputRef = useRef(null)
  const cameraRef = useRef(null)
  const autoId = useId()
  const zoneId = id ?? `dropzone-${autoId}`
  const hintId = `${zoneId}-hint`
  const errorId = `${zoneId}-error`
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState('')
  const [objectUrl, setObjectUrl] = useState(null)

  useEffect(() => {
    if (!(value instanceof Blob) || !String(value.type).startsWith('image/')) {
      setObjectUrl(null)
      return undefined
    }
    const url = URL.createObjectURL(value)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [value])

  const message = error || localError
  const previewSource = objectUrl ?? (value ? null : previewUrl)
  const hintText = hint ?? `${describeAccept(accept)} up to ${maxSizeMB} MB`

  const reject = (text) => {
    setLocalError(text)
    onError?.(text)
  }

  const handleFiles = (files) => {
    const file = files?.[0]
    if (!file || disabled) return
    if (!matchesAccept(file, accept)) {
      reject(`This file type isn't supported. Choose a ${describeAccept(accept)} file.`)
      return
    }
    if (maxSizeMB && file.size > maxSizeMB * 1024 * 1024) {
      reject(`This file is ${formatFileSize(file.size)}. The maximum size is ${maxSizeMB} MB.`)
      return
    }
    setLocalError('')
    onChange?.(file)
  }

  const handleInputChange = (event) => {
    handleFiles(event.target.files)
    // Reset so choosing the same file again still fires a change event.
    event.target.value = ''
  }

  const openPicker = () => inputRef.current?.click()

  const dragHandlers = {
    onDragEnter: (event) => {
      event.preventDefault()
      if (!disabled) setDragging(true)
    },
    onDragOver: (event) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false)
    },
    onDrop: (event) => {
      event.preventDefault()
      setDragging(false)
      handleFiles(event.dataTransfer.files)
    },
  }

  const describedBy = [hintId, message ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={zoneId} className="text-sm font-semibold text-ink">
          {label}
          {required ? (
            <span aria-hidden className="text-signal-600 dark:text-signal-300">
              {' '}
              *
            </span>
          ) : null}
        </label>
      ) : null}

      {previewSource ? (
        <div
          {...dragHandlers}
          className={cn(
            'overflow-hidden rounded-xl border bg-sunken transition-colors',
            dragging ? 'border-primary ring-2 ring-primary/30' : 'border-line',
          )}
        >
          <img
            src={previewSource}
            alt={value ? `Selected photo ${value.name}` : 'Current photo'}
            className="aspect-[4/3] w-full object-cover transition-[opacity,scale] duration-500 ease-enter starting:scale-[1.03] starting:opacity-0 sm:aspect-video"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-3 py-2">
            <div className="min-w-0 text-xs">
              <p className="truncate font-medium text-ink">{value ? value.name : 'Current photo'}</p>
              {value ? <p className="text-ink-3">{formatFileSize(value.size)}</p> : null}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button id={zoneId} size="sm" variant="ghost" leftIcon={RefreshCw} onClick={openPicker} disabled={disabled} aria-describedby={describedBy}>
                Replace
              </Button>
              {capture ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={Camera}
                  onClick={() => cameraRef.current?.click()}
                  disabled={disabled}
                  className="hidden pointer-coarse:inline-flex"
                >
                  Retake
                </Button>
              ) : null}
              {value ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={Trash2}
                  onClick={() => onChange?.(null)}
                  disabled={disabled}
                  className="text-signal-600 hover:text-signal-700 dark:text-signal-300"
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            id={zoneId}
            onClick={openPicker}
            disabled={disabled}
            aria-describedby={describedBy}
            {...dragHandlers}
            className={cn(
              'group/drop flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center disabled:cursor-not-allowed disabled:opacity-60',
              'transition-[border-color,background-color,scale] duration-200 ease-standard',
              dragging
                ? 'scale-[1.01] border-primary bg-primary-soft'
                : message
                  ? 'border-signal-400 bg-surface hover:bg-surface-2'
                  : 'border-line-strong bg-surface hover:border-ink-3 hover:bg-surface-2',
            )}
          >
            <span
              className={cn(
                'grid size-12 place-items-center rounded-full bg-sunken text-ink-2 transition-[translate,background-color,color] duration-300 ease-spring',
                'group-hover/drop:-translate-y-0.5',
                dragging && '-translate-y-1 bg-primary text-white',
              )}
            >
              <ImagePlus aria-hidden className="size-6" />
            </span>
            <span className="text-sm font-semibold text-ink">
              <span className="pointer-coarse:hidden">
                Drag a photo here or <span className="text-primary-ink underline underline-offset-2">browse</span>
              </span>
              <span className="hidden pointer-coarse:inline">Choose a photo</span>
            </span>
            <span id={hintId} className="text-xs text-ink-3">
              {hintText}
            </span>
          </button>
          {capture ? (
            <Button
              variant="secondary"
              leftIcon={Camera}
              onClick={() => cameraRef.current?.click()}
              disabled={disabled}
              className="hidden pointer-coarse:inline-flex"
              fullWidth
            >
              Take photo
            </Button>
          ) : null}
        </div>
      )}

      {previewSource ? (
        <p id={hintId} className="text-xs text-ink-3">
          {hintText}
        </p>
      ) : null}
      {message ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-signal-600 dark:text-signal-300">
          {message}
        </p>
      ) : null}

      <input ref={inputRef} type="file" accept={accept} onChange={handleInputChange} className="hidden" tabIndex={-1} aria-hidden disabled={disabled} />
      {capture ? (
        <input
          ref={cameraRef}
          type="file"
          accept={accept}
          capture={capture === true ? 'environment' : capture}
          onChange={handleInputChange}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          disabled={disabled}
        />
      ) : null}
    </div>
  )
}

export default FileDropzone
