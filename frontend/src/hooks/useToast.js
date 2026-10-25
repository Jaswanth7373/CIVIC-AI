/**
 * Toast API: `const toast = useToast(); toast.success('Complaint accepted')`.
 * Methods: success / error / info / warning `(title, description?, options?)`, `show({tone, title,
 * description, duration})`, `dismiss(id)`. `const { toast } = useToast()` works too.
 */
import { useContext } from 'react'
import { ToastContext } from '@/context/contexts'

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast() must be used inside <ToastProvider>.')
  return context
}

export default useToast
