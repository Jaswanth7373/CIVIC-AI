import { AnimatePresence, motion } from 'framer-motion'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useRef } from 'react'
import { SPRING } from '@/components/motion/tokens'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/utils/cn'
import { THEME_OPTIONS } from '@/utils/constants'
import { DropdownMenu } from './DropdownMenu'
import { IconButton } from './IconButton'

/**
 * The trigger's icon: when the choice changes, the old icon turns away and the new one turns in (a quarter
 * turn with a spring), like a sign flipping on its post. Reduced motion: a plain swap.
 */
function ThemeIcon({ className }) {
  const { theme, resolvedTheme } = useTheme()
  const key = theme === 'system' ? 'system' : resolvedTheme
  const Icon = theme === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun
  return (
    <span aria-hidden className={cn('relative grid place-items-center', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={key}
          className="grid place-items-center"
          initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
          animate={{ opacity: 1, rotate: 0, scale: 1, transition: SPRING.bouncy }}
          exit={{ opacity: 0, rotate: 90, scale: 0.6, transition: { duration: 0.12 } }}
        >
          <Icon className="size-full" />
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/**
 * Theme picker: an icon button showing the current choice (sun / moon / monitor) that opens a menu with
 * Light, Dark and System. "System" follows the operating system setting live.
 *
 * Choosing a theme that changes the look reveals it in a circle that grows out of this button (ThemeContext,
 * View Transitions API; instant without the API or with reduced motion). The button carries
 * `data-theme-toggle`, so other controls that switch the theme (the command palette) can start the reveal here.
 *
 * @param {{align?: 'start'|'end', className?: string, buttonClassName?: string}} props
 */
export function ThemeToggle({ align = 'end', className, buttonClassName }) {
  const { theme, setTheme } = useTheme()
  const buttonRef = useRef(null)
  const current = THEME_OPTIONS.find((option) => option.value === theme)?.label ?? 'System'

  return (
    <DropdownMenu
      align={align}
      label="Theme"
      className={className}
      items={THEME_OPTIONS.map((option) => ({
        label: option.label,
        icon: option.icon,
        checked: theme === option.value,
        onClick: () => setTheme(option.value, { origin: buttonRef.current }),
      }))}
      trigger={
        <IconButton ref={buttonRef} icon={ThemeIcon} label={`Theme: ${current}`} data-theme-toggle="" className={buttonClassName} />
      }
    />
  )
}

export default ThemeToggle
