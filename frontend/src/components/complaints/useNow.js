/**
 * `useNow(intervalMs)` - the current time in epoch milliseconds, refreshed on a shared clock.
 *
 * SLA countdowns and "5 minutes ago" labels need a clock that ticks, but a table with 50 rows must not start
 * 50 timers. All components that use the same interval subscribe to ONE `setInterval` (a tiny external
 * store read through React's `useSyncExternalStore`); the timer stops when the last subscriber unmounts.
 * Snapshots are cached per tick, so every subscriber renders with the same timestamp.
 */
import { useCallback, useSyncExternalStore } from 'react'

const clocks = new Map()

function getClock(intervalMs) {
  let clock = clocks.get(intervalMs)
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), timer: 0 }
    clocks.set(intervalMs, clock)
  }
  return clock
}

function subscribeTo(intervalMs, listener) {
  const clock = getClock(intervalMs)
  clock.listeners.add(listener)
  if (!clock.timer) {
    clock.now = Date.now()
    clock.timer = window.setInterval(() => {
      clock.now = Date.now()
      clock.listeners.forEach((notify) => notify())
    }, intervalMs)
  }
  return () => {
    clock.listeners.delete(listener)
    if (!clock.listeners.size && clock.timer) {
      window.clearInterval(clock.timer)
      clock.timer = 0
    }
  }
}

export function useNow(intervalMs = 60_000) {
  const subscribe = useCallback((listener) => subscribeTo(intervalMs, listener), [intervalMs])
  const getSnapshot = useCallback(() => getClock(intervalMs).now, [intervalMs])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export default useNow
