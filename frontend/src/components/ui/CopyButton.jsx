import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { IconButton } from './IconButton'

const RESET_MS = 1800
/** Same icon sizes as IconButton's. */
const GLYPH_SIZES = { sm: 'size-4', md: 'size-5', lg: 'size-6' }

/** Copy text to the clipboard: the async Clipboard API, or a hidden textarea where it is unavailable (http). */
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('Copy is not available in this browser.')
}

/** The icon: a copy glyph that turns into a sign-green tick (springing in) for a moment after copying. */
function CopyGlyph({ copied, className }) {
  return (
    <span aria-hidden className={cn('relative grid place-items-center', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {copied ? (
          <motion.span
            key="done"
            className="grid place-items-center text-primary-ink"
            initial={{ opacity: 0, scale: 0.4, rotate: -20 }}
            animate={{ opacity: 1, scale: 1, rotate: 0, transition: SPRING.bouncy }}
            exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
          >
            <Check className="size-full" strokeWidth={2.6} />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            className="grid place-items-center"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
            exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}
          >
            <Copy className="size-full" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

/**
 * Icon button that copies `value` (a complaint number, a link) to the clipboard and confirms with a tick that
 * springs in for a moment (cinematic plan 6.2, "copy-to-clipboard ticks"). Screen readers hear "Copied" through
 * a polite live region; the button's name stays `label`. If copying fails, `onError` is called.
 *
 * @param {object} props
 * @param {string} props.value text to copy
 * @param {string} [props.label='Copy'] accessible name, e.g. "Copy complaint number"
 * @param {'sm'|'md'|'lg'} [props.size='sm']
 * @param {(error: unknown) => void} [props.onError]
 * @param {() => void} [props.onCopied]
 */
export function CopyButton({ value, label = 'Copy', size = 'sm', onError, onCopied, className }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(0)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = async () => {
    try {
      await writeClipboard(String(value ?? ''))
      setCopied(true)
      onCopied?.()
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), RESET_MS)
    } catch (error) {
      onError?.(error)
    }
  }

  return (
    <>
      <IconButton
        icon={<CopyGlyph copied={copied} className={GLYPH_SIZES[size] ?? GLYPH_SIZES.sm} />}
        label={label}
        size={size}
        onClick={copy}
        className={className}
        data-copied={copied || undefined}
      />
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </>
  )
}

export default CopyButton
