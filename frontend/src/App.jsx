/**
 * CivicAI application root: global providers + the route table (BUILD_SPEC 5.5).
 *
 * Providers (outermost first): MotionConfig (honours prefers-reduced-motion for every framer-motion
 * animation) -> Theme -> Config -> Toast -> Auth -> Notification -> Confirm -> RouterProvider.
 * Auth sits inside Toast so it can announce an expired session; Notification needs Auth to know whom to poll.
 *
 * Routing: `createBrowserRouter` (data router). Every page is code-split with React.lazy, so a visitor only
 * downloads the screens they open; the layouts render <Suspense> around their <Outlet />, so the shell stays
 * visible while a page chunk loads. Each area has a pathless child route with `errorElement`, which keeps the
 * layout on screen when a page crashes; the root errorElement is the last resort.
 */
import { MotionConfig } from 'framer-motion'
import { Suspense, lazy } from 'react'
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom'
import {
  DashboardLayout,
  GuestRoute,
  ProtectedRoute,
  PublicLayout,
  RouteErrorBoundary,
  ScrollToTop,
} from '@/components/layout'
import { ConfirmProvider } from '@/components/ui/ConfirmDialog'
import { PageLoader } from '@/components/ui/PageLoader'
import { AuthProvider } from '@/context/AuthContext'
import { ConfigProvider } from '@/context/ConfigContext'
import { NotificationProvider } from '@/context/NotificationContext'
import { ThemeProvider } from '@/context/ThemeContext'
import { ToastProvider } from '@/context/ToastContext'
import { setNavigator } from '@/services/api'

/* ---- Public pages ---- */
const LandingPage = lazy(() => import('@/pages/public/LandingPage'))
const AboutPage = lazy(() => import('@/pages/public/AboutPage'))
const FeaturesPage = lazy(() => import('@/pages/public/FeaturesPage'))
const HowItWorksPage = lazy(() => import('@/pages/public/HowItWorksPage'))
const ContactPage = lazy(() => import('@/pages/public/ContactPage'))
const LoginPage = lazy(() => import('@/pages/public/LoginPage'))
const RegisterPage = lazy(() => import('@/pages/public/RegisterPage'))
const NotFoundPage = lazy(() => import('@/pages/public/NotFoundPage'))
const UnauthorizedPage = lazy(() => import('@/pages/public/UnauthorizedPage'))

/* ---- Citizen ---- */
const CitizenDashboard = lazy(() => import('@/pages/citizen/CitizenDashboard'))
const SubmitComplaint = lazy(() => import('@/pages/citizen/SubmitComplaint'))
const MyComplaints = lazy(() => import('@/pages/citizen/MyComplaints'))
const ComplaintDetails = lazy(() => import('@/pages/citizen/ComplaintDetails'))
const ComplaintTracking = lazy(() => import('@/pages/citizen/ComplaintTracking'))
const FeedbackPage = lazy(() => import('@/pages/citizen/FeedbackPage'))

/* ---- Officer ---- */
const OfficerDashboard = lazy(() => import('@/pages/officer/OfficerDashboard'))
const AssignedComplaints = lazy(() => import('@/pages/officer/AssignedComplaints'))
const OfficerComplaintDetails = lazy(() => import('@/pages/officer/OfficerComplaintDetails'))
const ResolutionUpdate = lazy(() => import('@/pages/officer/ResolutionUpdate'))
const ResolutionVerification = lazy(() => import('@/pages/officer/ResolutionVerification'))

/* ---- Admin ---- */
const AdminDashboard = lazy(() => import('@/pages/admin/AdminDashboard'))
const AllComplaints = lazy(() => import('@/pages/admin/AllComplaints'))
const ComplaintManagement = lazy(() => import('@/pages/admin/ComplaintManagement'))
const DuplicateReview = lazy(() => import('@/pages/admin/DuplicateReview'))
const UserManagement = lazy(() => import('@/pages/admin/UserManagement'))
const OfficerManagement = lazy(() => import('@/pages/admin/OfficerManagement'))
const DepartmentManagement = lazy(() => import('@/pages/admin/DepartmentManagement'))
const AIAnalytics = lazy(() => import('@/pages/admin/AIAnalytics'))
const HotspotMap = lazy(() => import('@/pages/admin/HotspotMap'))
const FeedbackAnalytics = lazy(() => import('@/pages/admin/FeedbackAnalytics'))
const Reports = lazy(() => import('@/pages/admin/Reports'))
const SystemSettings = lazy(() => import('@/pages/admin/SystemSettings'))
const AuditLogs = lazy(() => import('@/pages/admin/AuditLogs'))

/* ---- Shared (used under every role prefix) ---- */
const ProfilePage = lazy(() => import('@/pages/shared/ProfilePage'))
const NotificationsPage = lazy(() => import('@/pages/shared/NotificationsPage'))

/** Root route element: scroll handling for every navigation + a last-resort Suspense boundary. */
function RootLayout() {
  return (
    <>
      <ScrollToTop />
      <Suspense fallback={<PageLoader fullScreen />}>
        <Outlet />
      </Suspense>
    </>
  )
}

/**
 * A role area (`/citizen`, `/officer`, `/admin`): guarded by role, rendered in the dashboard shell,
 * `/<role>` redirects to `/<role>/dashboard`, unknown sub-paths show NotFound inside the shell.
 */
function roleArea(role, children) {
  return {
    path: role,
    element: (
      <ProtectedRoute roles={[role]}>
        <DashboardLayout />
      </ProtectedRoute>
    ),
    children: [
      {
        errorElement: <RouteErrorBoundary />,
        children: [
          { index: true, element: <Navigate to={`/${role}/dashboard`} replace /> },
          ...children,
          { path: 'profile', element: <ProfilePage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  }
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteErrorBoundary />,
    children: [
      {
        element: <PublicLayout />,
        children: [
          {
            errorElement: <RouteErrorBoundary />,
            children: [
              { index: true, element: <LandingPage /> },
              { path: 'about', element: <AboutPage /> },
              { path: 'features', element: <FeaturesPage /> },
              { path: 'how-it-works', element: <HowItWorksPage /> },
              { path: 'contact', element: <ContactPage /> },
              {
                element: <GuestRoute />,
                children: [
                  { path: 'login', element: <LoginPage /> },
                  { path: 'register', element: <RegisterPage /> },
                ],
              },
              { path: 'unauthorized', element: <UnauthorizedPage /> },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
      roleArea('citizen', [
        { path: 'dashboard', element: <CitizenDashboard /> },
        { path: 'report', element: <SubmitComplaint /> },
        { path: 'complaints', element: <MyComplaints /> },
        { path: 'complaints/:id', element: <ComplaintDetails /> },
        { path: 'complaints/:id/track', element: <ComplaintTracking /> },
        { path: 'feedback', element: <FeedbackPage /> },
      ]),
      roleArea('officer', [
        { path: 'dashboard', element: <OfficerDashboard /> },
        { path: 'complaints', element: <AssignedComplaints /> },
        { path: 'complaints/:id', element: <OfficerComplaintDetails /> },
        { path: 'complaints/:id/resolve', element: <ResolutionUpdate /> },
        { path: 'complaints/:id/verify', element: <ResolutionVerification /> },
      ]),
      roleArea('admin', [
        { path: 'dashboard', element: <AdminDashboard /> },
        { path: 'complaints', element: <AllComplaints /> },
        { path: 'complaints/:id', element: <ComplaintManagement /> },
        { path: 'duplicates', element: <DuplicateReview /> },
        { path: 'users', element: <UserManagement /> },
        { path: 'officers', element: <OfficerManagement /> },
        { path: 'departments', element: <DepartmentManagement /> },
        { path: 'ai-analytics', element: <AIAnalytics /> },
        { path: 'hotspots', element: <HotspotMap /> },
        { path: 'feedback', element: <FeedbackAnalytics /> },
        { path: 'reports', element: <Reports /> },
        { path: 'settings', element: <SystemSettings /> },
        { path: 'audit-logs', element: <AuditLogs /> },
      ]),
    ],
  },
])

// Session-expiry redirects from the API layer stay inside the SPA (no full page reload).
setNavigator((to) => router.navigate(to, { replace: true }))

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <ConfigProvider>
          <ToastProvider>
            <AuthProvider>
              <NotificationProvider>
                <ConfirmProvider>
                  <RouterProvider router={router} />
                </ConfirmProvider>
              </NotificationProvider>
            </AuthProvider>
          </ToastProvider>
        </ConfigProvider>
      </ThemeProvider>
    </MotionConfig>
  )
}
