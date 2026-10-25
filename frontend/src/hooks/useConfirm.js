/**
 * Promise-based confirmation dialog (rendered by `<ConfirmProvider>` from components/ui/ConfirmDialog):
 *
 *   const confirm = useConfirm()
 *   const ok = await confirm({ title: 'Delete complaint?', message: 'This cannot be undone.',
 *                              confirmLabel: 'Delete complaint', tone: 'danger' })
 *   if (ok) ...
 *
 * Resolves to true when confirmed, false when cancelled (Cancel, Esc or clicking outside).
 * A plain string is accepted as the message: `await confirm('Discard your changes?')`.
 */
import { useContext } from 'react'
import { ConfirmContext } from '@/context/contexts'

export function useConfirm() {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm() must be used inside <ConfirmProvider>.')
  return confirm
}

export default useConfirm
