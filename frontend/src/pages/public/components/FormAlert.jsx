/**
 * Form-level error of the public forms (login, registration, contact): the danger Alert, opened and closed with
 * a short height + fade so the fields below are eased down instead of jumping. The Alert keeps role="alert", so
 * it is announced the moment it appears. Reduced motion: it simply appears and disappears.
 *
 * Place it first in a `space-y-5` form: the gap below it is padding inside the animated box (whose own margin
 * is removed), so the fields glide back up when it closes instead of jumping the last 20 px.
 *
 * @param {{message?: string, title: string}} props the alert shows while `message` is non-empty
 */
import { AnimatePresence, motion } from 'framer-motion'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { DURATION, EASE } from '@/components/motion/tokens'
import { Alert } from '@/components/ui/Alert'

export function FormAlert({ message, title }) {
  const reduced = usePrefersReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {message ? (
        <motion.div
          key="form-alert"
          className="mb-0 overflow-hidden"
          initial={reduced ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={reduced ? undefined : { height: 0, opacity: 0 }}
          transition={{ duration: DURATION.base, ease: EASE.standard }}
        >
          <div className="pb-5">
            <Alert tone="danger" title={title}>
              {message}
            </Alert>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default FormAlert
