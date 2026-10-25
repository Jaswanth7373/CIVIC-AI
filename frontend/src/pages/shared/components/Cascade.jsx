/**
 * Cascade - a first-load list entrance (components/motion Stagger) that waits for the real content.
 *
 * Until `ready` the children render plain - skeletons never play the entrance - and when the data arrives
 * the content mounts inside a Stagger, so the cascade (and the CountUp counters inside it) runs on what the
 * user actually reads. Wrap each block in <StaggerItem index={i}>: outside a Stagger it renders plain.
 *
 * @param {object} props
 * @param {boolean} props.ready
 * @param {import('react').ElementType} [props.as='div']
 * @param {number} [props.delay] [props.step] [props.max] [props.y] Stagger timing (see components/motion)
 */
import { Stagger } from '@/components/motion/Stagger'

export function Cascade({ ready, as: Component = 'div', delay, step, max, y, children, ...props }) {
  if (!ready) return <Component {...props}>{children}</Component>
  const timing = Object.fromEntries(Object.entries({ delay, step, max, y }).filter(([, value]) => value !== undefined))
  return (
    <Stagger as={Component} {...timing} {...props}>
      {children}
    </Stagger>
  )
}

export default Cascade
