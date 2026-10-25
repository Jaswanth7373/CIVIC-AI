/**
 * Profile (/citizen/profile, /officer/profile, /admin/profile) - the signed-in user's own account.
 *
 * The page reads the user from GET /api/auth/profile/ (fresh stats and civic points) and writes through
 * useAuth().updateProfile (PATCH /api/auth/profile/), which also refreshes the user shown in the topbar and
 * menus. Sections: identity (avatar upload / removal with preview, role, civic points for citizens, account
 * details), personal information (+ the citizen profile for citizens), the read-only officer profile for
 * officers, and the password change form.
 */
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { authService } from '@/services/authService'
import { ChangePasswordForm, IdentityCard, OfficerSummary, PersonalInfoForm } from './components/ProfileSections'

function ProfileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading profile" className="grid items-start gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6">
        <Skeleton circle className="size-24" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-52" />
        <Skeleton className="mt-4 h-20 w-full" />
      </div>
      <div className="space-y-5">
        <div className="space-y-4 rounded-xl border border-line bg-surface p-5">
          <Skeleton className="h-5 w-48" />
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        </div>
        <div className="space-y-4 rounded-xl border border-line bg-surface p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  )
}

export default function ProfilePage() {
  const { user, updateProfile } = useAuth()
  const { data, error, refetch, setData } = useApi(() => authService.getProfile(), [])
  const profile = data ?? null

  const handleUpdate = async (changes) => {
    const updated = await updateProfile(changes)
    setData(updated)
    return updated
  }

  return (
    <>
      <PageHeader
        title="Profile"
        description={
          (profile ?? user)?.role === 'citizen'
            ? 'Your photo, contact details, home address and password.'
            : 'Your photo, contact details and password.'
        }
      />
      {profile ? (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="min-w-0 lg:sticky lg:top-24">
            <IdentityCard profile={profile} onUpdate={handleUpdate} />
          </div>
          <div className="min-w-0 space-y-5">
            <PersonalInfoForm key={profile.id} profile={profile} onUpdate={handleUpdate} />
            {profile.role === 'officer' ? <OfficerSummary profile={profile} /> : null}
            <ChangePasswordForm />
          </div>
        </div>
      ) : error ? (
        <ErrorState title="Your profile could not be loaded" error={error} onRetry={refetch} />
      ) : (
        <ProfileSkeleton />
      )}
    </>
  )
}
