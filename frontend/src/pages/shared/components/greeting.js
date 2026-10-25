/**
 * Copy helpers for the dashboard heroes (pure functions; kept out of the .jsx files so those export
 * components only, as React Fast Refresh requires).
 */
import { format } from 'date-fns'

/** Time-of-day greeting for the dashboard heading. */
export function greetingFor(date = new Date()) {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/** "Saturday, 18 October" - the line above the greeting. */
export function todayLabel(date = new Date()) {
  return format(date, 'EEEE, d MMMM')
}

/** First name of a user object (first_name, else the first word of full_name), or ''. */
export function firstNameOf(user) {
  return user?.first_name || String(user?.full_name ?? '').split(' ')[0] || ''
}
