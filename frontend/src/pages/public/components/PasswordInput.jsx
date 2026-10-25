/**
 * Password field with a show / hide toggle (an icon button inside the input). Inside a <FormField> the
 * label, hint and error wiring is automatic, exactly like <Input>. The toggle is a real button with an
 * accessible name and `aria-pressed`, so keyboard and screen-reader users can reveal the password too.
 * Once toggled, the eye pops as it swaps (not on first render; still with reduced motion).
 */
import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { cn } from '@/utils/cn'

export function PasswordInput({ ref, ...props }) {
  const [visible, setVisible] = useState(false)
  const [toggled, setToggled] = useState(false)
  const iconClass = cn('size-4', toggled && 'animate-pop-in')
  return (
    <Input
      ref={ref}
      {...props}
      type={visible ? 'text' : 'password'}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      rightSlot={
        <IconButton
          icon={visible ? <EyeOff aria-hidden className={iconClass} /> : <Eye aria-hidden className={iconClass} />}
          label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          size="sm"
          onClick={() => {
            setToggled(true)
            setVisible((current) => !current)
          }}
        />
      }
    />
  )
}

export default PasswordInput
