/**
 * PhotoTipsCard - how to take evidence photos the AI verification can compare.
 *
 * The verification aligns the after photo onto the before photo by matching image features (ORB + RANSAC),
 * then measures change inside the area where the issue was detected; the same viewpoint and light make that
 * comparison reliable. Props: { maxImageMB, className }
 */
import { Camera, Crosshair, Sun, Users } from 'lucide-react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'

export function PhotoTipsCard({ maxImageMB = 8, className }) {
  const tips = [
    {
      icon: Crosshair,
      title: 'Same spot, same angle',
      text: 'Stand where the before photo was taken. The AI lines the two photos up by matching details in the scene.',
    },
    { icon: Sun, title: 'Good light', text: 'Daylight, no flash glare, and the repaired spot in the middle of the frame.' },
    { icon: Users, title: 'Clear view', text: 'Wait until people and vehicles no longer cover the repair.' },
    { icon: Camera, title: 'File', text: `JPG, PNG or WebP up to ${maxImageMB} MB. On a phone, "Take photo" opens the camera.` },
  ]
  return (
    <Card className={className}>
      <CardHeader title="Photos the AI can verify" icon={Camera} />
      <CardBody>
        <ul className="space-y-3">
          {tips.map((tip) => {
            const Icon = tip.icon
            return (
              <li key={tip.title} className="flex items-start gap-3">
                <span aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-sunken text-ink-2">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{tip.title}</p>
                  <p className="text-xs text-ink-2">{tip.text}</p>
                </div>
              </li>
            )
          })}
        </ul>
      </CardBody>
    </Card>
  )
}

export default PhotoTipsCard
