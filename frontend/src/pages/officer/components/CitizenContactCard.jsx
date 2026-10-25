/**
 * CitizenContactCard - who reported the issue and how to reach them from the site (call or e-mail), for
 * example when the exact spot is hard to find.
 *
 * Props: { citizen: UserMini | null, className }
 */
import { Mail, Phone, UserRound } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'

export function CitizenContactCard({ citizen, className }) {
  return (
    <Card className={className}>
      <CardHeader title="Citizen contact" icon={UserRound} />
      <CardBody>
        {citizen ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar src={citizen.avatar} name={citizen.full_name} size="md" decorative />
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{citizen.full_name}</p>
                <p className="text-xs text-ink-3">Reported this complaint</p>
              </div>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-3">Phone</dt>
                <dd className="font-medium text-ink tabular">{citizen.phone || 'Not shared'}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-3">Email</dt>
                <dd className="min-w-0 truncate font-medium text-ink">{citizen.email || 'Not shared'}</dd>
              </div>
            </dl>
            <div className="grid grid-cols-2 gap-2">
              {citizen.phone ? (
                <Button variant="outline" size="sm" leftIcon={Phone} href={`tel:${citizen.phone}`}>
                  Call citizen
                </Button>
              ) : null}
              {citizen.email ? (
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={Mail}
                  href={`mailto:${citizen.email}`}
                  className={citizen.phone ? undefined : 'col-span-2'}
                >
                  Email citizen
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-3">The citizen's contact details are not available for this complaint.</p>
        )}
      </CardBody>
    </Card>
  )
}

export default CitizenContactCard
