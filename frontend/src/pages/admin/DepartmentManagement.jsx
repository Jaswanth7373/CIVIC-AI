/**
 * Departments & categories (admin) - the organisation the AI routes work to.
 *
 * Tabs (`?tab=` in the URL): Departments (CRUD with SLA, contacts and live counts), Categories (CRUD of what
 * citizens report and the AI predicts: keywords, vision labels, severity weights, SLA override) and Routing
 * (the category -> department matrix). Each tab loads its own data when it is opened.
 */
import { Building2, GitBranch, Tag } from 'lucide-react'
import { PageHeader, TabPanel, Tabs } from '@/components/ui'
import { CategoriesTab } from './manage/departments/CategoriesTab'
import { DepartmentsTab } from './manage/departments/DepartmentsTab'
import { RoutingTab } from './manage/departments/RoutingTab'
import { useUrlParams } from './manage/shared/useUrlParams'

const TABS = [
  { id: 'departments', label: 'Departments', icon: Building2 },
  { id: 'categories', label: 'Categories', icon: Tag },
  { id: 'routing', label: 'Routing', icon: GitBranch },
]

export default function DepartmentManagement() {
  const { values, setValues } = useUrlParams({ tab: 'departments' })
  const tab = TABS.some((item) => item.id === values.tab) ? values.tab : 'departments'

  return (
    <>
      <PageHeader
        title="Departments & categories"
        description="Who resolves which kind of issue. Departments own the work, categories describe it for citizens and the AI engine, and routing connects the two."
      />
      <Tabs tabs={TABS} value={tab} onChange={(next) => setValues({ tab: next })} idPrefix="org" label="Organisation sections" className="mb-5" />
      <TabPanel tabId="departments" value={tab} idPrefix="org">
        <DepartmentsTab />
      </TabPanel>
      <TabPanel tabId="categories" value={tab} idPrefix="org">
        <CategoriesTab />
      </TabPanel>
      <TabPanel tabId="routing" value={tab} idPrefix="org">
        <RoutingTab />
      </TabPanel>
    </>
  )
}
