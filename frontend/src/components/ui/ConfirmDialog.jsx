import { CircleHelp, TriangleAlert } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { ConfirmContext } from '@/context/contexts'
import { cn } from '@/utils/cn'
import { Button } from './Button'
import { Modal } from './Modal'

const TONES = {
  danger: { icon: TriangleAlert, chip: 'bg-signal-50 text-signal-600 dark:bg-signal-500/15 dark:text-signal-300', button: 'danger' },
  warning: { icon: TriangleAlert, chip: 'bg-marking-50 text-marking-700 dark:bg-marking-500/15 dark:text-marking-300', button: 'warning' },
  primary: { icon: CircleHelp, chip: 'bg-primary-soft text-primary-ink', button: 'primary' },
}

/**
 * Confirmation dialog (presentational). Most screens use the promise API instead:
 * `const ok = await useConfirm()({ title, message, confirmLabel, tone })`.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {import('react').ReactNode} props.title
 * @param {import('react').ReactNode} [props.message]
 * @param {string} [props.confirmLabel='Confirm'] use a specific verb, e.g. "Delete complaint"
 * @param {string} [props.cancelLabel='Cancel']
 * @param {'danger'|'warning'|'primary'} [props.tone='primary']
 * @param {boolean} [props.loading]
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null)
  const style = TONES[tone] ?? TONES.primary
  const Icon = style.icon
  return (
    <Modal
      open={open}
      onClose={loading ? undefined : onCancel}
      size="sm"
      hideCloseButton
      aria-label={typeof title === 'string' ? title : 'Confirm'}
      initialFocusRef={tone === 'danger' ? cancelRef : undefined}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={style.button} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-4 py-1">
        <span className={cn('grid size-10 shrink-0 animate-pop-in place-items-center rounded-full [animation-delay:90ms] motion-reduce:animate-none', style.chip)}>
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 pt-1">
          <h2 className="font-display text-lg font-bold leading-snug text-ink">{title}</h2>
          {message ? <div className="mt-1.5 text-sm text-ink-2">{message}</div> : null}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Provides the promise-based `confirm()` used by `useConfirm()`. One dialog instance serves the whole app;
 * if a new confirmation is requested while one is open, the previous one resolves to false.
 */
export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null)
  const resolverRef = useRef(null)

  const settle = useCallback((result) => {
    resolverRef.current?.(result)
    resolverRef.current = null
    setRequest((current) => (current ? { ...current, open: false } : current))
  }, [])

  const confirm = useCallback((options = {}) => {
    const normalized = typeof options === 'string' ? { message: options } : options
    resolverRef.current?.(false)
    return new Promise((resolve) => {
      resolverRef.current = resolve
      setRequest({
        open: true,
        title: normalized.title ?? 'Are you sure?',
        message: normalized.message ?? normalized.description ?? '',
        confirmLabel: normalized.confirmLabel ?? 'Confirm',
        cancelLabel: normalized.cancelLabel ?? 'Cancel',
        tone: normalized.tone ?? 'primary',
      })
    })
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={Boolean(request?.open)}
        title={request?.title}
        message={request?.message}
        confirmLabel={request?.confirmLabel}
        cancelLabel={request?.cancelLabel}
        tone={request?.tone}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  )
}

export default ConfirmDialog
