/**
 * Authentication endpoints (`/api/auth/*`). Every function resolves to `response.data`.
 *
 * Token storage is handled by AuthContext (`useAuth().login/register/logout`), which calls these functions and
 * then stores the returned tokens. Pages should use the context rather than calling login/register directly,
 * otherwise the session would not be remembered.
 */
import api, { toRequestBody } from './api'

export const authService = {
  /** `{email, password, confirm_password, first_name, last_name, phone?}` -> `{user, access, refresh}` (role citizen). */
  async register(data) {
    const { data: body } = await api.post('/auth/register/', data, { skipAuth: true })
    return body
  },

  /** `{email, password}` -> `{access, refresh, user}`. Wrong credentials reject with 401 "Invalid email or password." */
  async login(credentials) {
    const { data } = await api.post('/auth/login/', credentials, { skipAuth: true })
    return data
  },

  /** `refreshToken` -> `{access, refresh}` (rotated). Normally done automatically by the api interceptors. */
  async refresh(refreshToken) {
    const { data } = await api.post('/auth/refresh/', { refresh: refreshToken }, { skipAuth: true })
    return data
  },

  /** Blacklists the refresh token on the server -> `{detail: "Logged out."}`. */
  async logout(refreshToken, config = {}) {
    const { data } = await api.post('/auth/logout/', { refresh: refreshToken }, { skipAuthRedirect: true, ...config })
    return data
  },

  /** Current user (User shape with citizen_profile / officer_profile / stats). */
  async getProfile(config = {}) {
    const { data } = await api.get('/auth/profile/', config)
    return data
  },

  /**
   * Partial profile update. Accepts JSON (`citizen_profile` nested) or FormData / an object containing an
   * `avatar` File (sent as multipart; citizen fields may then be flat: `address`, `city`, ...).
   */
  async updateProfile(dataOrFormData, config = {}) {
    const { data } = await api.patch('/auth/profile/', toRequestBody(dataOrFormData), config)
    return data
  },

  /** `{old_password, new_password}`. */
  async changePassword(data) {
    const { data: body } = await api.post('/auth/change-password/', data)
    return body
  },
}

export default authService
