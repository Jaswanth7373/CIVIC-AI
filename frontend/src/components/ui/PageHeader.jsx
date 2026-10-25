import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { cn } from '@/utils/cn'

function BackLink({ back }) {
  const navigate = useNavigate()
  const location = useLocation()
  const className =
    'mb-2 inline-flex items-center gap-1 rounded-md text-sm font-semibold text-ink-2 transition-colors hover:text-ink pointer-coarse:min-h-11'

  if (back === true) {
    // location.key is "default" on the first page of the session: there is no in-app page to go back to.
    const canGoBack = location.key !== 'default'
    return (
      <button type="button" onClick={() => (canGoBack ? navigate(-1) : navigate('/'))} className={className}>
        <ChevronLeft aria-hidden className="size-4" />
        Back
      </button>
    )
  }
  const to = typeof back === 'string' ? back : back.to
  const label = typeof back === 'object' ? (back.label ?? 'Back') : 'Back'
  return (
    <Link to={to} className={className}>
      <ChevronLeft aria-hidden className="size-4" />
      {label}
    </Link>
  )
}

/**
 * Top of every screen: optional back link and breadcrumbs, the page title (h1), a description and actions.
 * A string `title` also sets the browser tab title ("<title> | CivicAI") unless `documentTitle={false}`.
 * The title is the shared-element target of route view transitions (layout/routeViewTransition.js): an element
 * on the previous page marked `data-vt-morph="<this page's path>"` morphs into it.
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.title
 * @param {import('react').ReactNode} [props.description]
 * @param {import('react').ReactNode} [props.actions] buttons on the right (wrap below the title on phones)
 * @param {Array<{label: string, to?: string}>} [props.breadcrumbs] the last item is the current page
 * @param {true|string|{to: string, label?: string}} [props.back] `true` = browser back, string = path
 * @param {string|false} [props.documentTitle] override (or disable) the tab title
 */
export function PageHeader({ title, description, actions, breadcrumbs, back, documentTitle, className, children }) {
  useDocumentTitle(documentTitle === false ? false : (documentTitle ?? (typeof title === 'string' ? title : undefined)))

  return (
    <header className={cn('mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {back ? <BackLink back={back} /> : null}
        {breadcrumbs?.length ? (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1 text-sm text-ink-3">
              {breadcrumbs.map((crumb, index) => {
                const last = index === breadcrumbs.length - 1
                return (
                  <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                    {crumb.to && !last ? (
                      <Link
                        to={crumb.to}
                        className="rounded-sm font-medium transition-colors hover:text-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                      >
                        {crumb.label}
                      </Link>
                    ) : (
                      <span aria-current={last ? 'page' : undefined} className={cn(last && 'text-ink-2')}>
                        {crumb.label}
                      </span>
                    )}
                    {!last ? <ChevronRight aria-hidden className="size-3.5" /> : null}
                  </li>
                )
              })}
            </ol>
          </nav>
        ) : null}
        {/* data-vt-morph-target: the item a user picked on the previous page (a list row, a palette result marked
            data-vt-morph) morphs into this title during the route view transition. */}
        <h1 data-vt-morph-target="" className="font-display text-2xl font-extrabold leading-tight tracking-tight text-ink sm:text-[1.75rem]">
          {title}
        </h1>
        {description ? <p className="mt-1.5 max-w-3xl text-sm text-ink-2 sm:text-[15px]">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export default PageHeader
