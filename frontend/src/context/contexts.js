/**
 * React context objects, kept apart from their providers.
 *
 * React Fast Refresh can only hot-swap a module that exports components exclusively; a module that also
 * exports a context object forces a full reload on every edit. So the `createContext` calls live here, the
 * providers live in `context/*Context.jsx`, and the consumer hooks live in `hooks/use*.js`.
 */
import { createContext } from 'react'

export const ThemeContext = createContext(null)
ThemeContext.displayName = 'ThemeContext'

export const ConfigContext = createContext(null)
ConfigContext.displayName = 'ConfigContext'

export const ToastContext = createContext(null)
ToastContext.displayName = 'ToastContext'

export const AuthContext = createContext(null)
AuthContext.displayName = 'AuthContext'

export const NotificationContext = createContext(null)
NotificationContext.displayName = 'NotificationContext'

export const ConfirmContext = createContext(null)
ConfirmContext.displayName = 'ConfirmContext'
