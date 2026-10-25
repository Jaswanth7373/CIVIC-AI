/**
 * Department and routing endpoints (`/api/departments/*`). Non-paginated lists.
 * Every function resolves to `response.data`.
 *
 * Routing = which department handles each category (`CivicCategory.department` + optional secondary
 * department used as a fallback). `categoryService` lives in its own module and is re-exported here because
 * the admin "Departments & categories" screen uses both.
 */
import api from './api'

export { categoryService } from './categoryService'

export const departmentService = {
  /** `[DepartmentOut]`. `{include_inactive: true}` (admin) also returns deactivated departments. */
  async list(params = {}, config = {}) {
    const { data } = await api.get('/departments/', { params, ...config })
    return data
  },

  async get(id) {
    const { data } = await api.get(`/departments/${id}/`)
    return data
  },

  async create(data) {
    const { data: body } = await api.post('/departments/', data)
    return body
  },

  async update(id, data) {
    const { data: body } = await api.patch(`/departments/${id}/`, data)
    return body
  },

  /** Admin. Deactivates a department that still has complaints or officers, otherwise deletes it. */
  async remove(id) {
    const { data } = await api.delete(`/departments/${id}/`)
    return data
  },

  /** `[{category: CategoryMini, department: DepartmentMini|null, secondary_department: DepartmentMini|null}]` */
  async routing() {
    const { data } = await api.get('/departments/routing/')
    return data
  },

  /** `mappings: [{category: id, department: id|null, secondary_department: id|null}]` -> the updated routing list. */
  async updateRouting(mappings) {
    const { data } = await api.put('/departments/routing/', { mappings })
    return data
  },
}

export default departmentService
