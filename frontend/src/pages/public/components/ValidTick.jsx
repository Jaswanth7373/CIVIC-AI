/**
 * Sign-green tick inside a text field (an Input's `rightSlot`) once its value is well formed - positive inline
 * validation, so a correct field confirms itself before the form is sent. Decorative: the field's label, hint
 * and error carry the meaning for assistive technology.
 *
 * Always render it (it is empty while `show` is false): an Input that gains or loses its right slot rebuilds its
 * markup and would drop the caret mid-typing.
 *
 * @param {{show: boolean}} props
 */
import { Check } from 'lucide-react'

export function ValidTick({ show }) {
  return (
    <span aria-hidden className="grid size-8 place-items-center text-sign-600 dark:text-sign-300">
      {show ? <Check className="size-4 animate-pop-in" strokeWidth={3} /> : null}
    </span>
  )
}

export default ValidTick
