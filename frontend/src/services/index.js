/**
 * Barrel for the API layer: `import { complaintService, analyticsService } from '@/services'`.
 * Each module can also be imported directly (named or default export).
 */
export {
  AI_TIMEOUT_MS,
  API_URL,
  DEFAULT_TIMEOUT_MS,
  SESSION_EXPIRED_EVENT,
  buildFormData,
  clearTokens,
  containsFile,
  decodeJwt,
  default as api,
  ensureFreshAccessToken,
  getAccessToken,
  getRefreshToken,
  hasStoredSession,
  isTokenExpired,
  redirectToLogin,
  refreshAccessToken,
  serializeParams,
  setNavigator,
  setTokens,
  toRequestBody,
} from './api'
export { aiService } from './aiService'
export { analyticsService } from './analyticsService'
export { assignmentService } from './assignmentService'
export { authService } from './authService'
export { categoryService } from './categoryService'
export { complaintService } from './complaintService'
export { departmentService } from './departmentService'
export { duplicateService } from './duplicateService'
export { feedbackService } from './feedbackService'
export { notificationService } from './notificationService'
export { officerService } from './officerService'
export { systemService } from './systemService'
export { userService } from './userService'
