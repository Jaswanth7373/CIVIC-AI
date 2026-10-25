/**
 * Set the browser tab title to "<title> | CivicAI" while the component is mounted (the previous title is
 * restored on unmount). An empty title shows the default "CivicAI - AI-Powered Civic Issue Management";
 * `false` leaves the tab title alone (the page sets it itself). PageHeader calls this automatically for
 * string titles.
 */
import { useEffect } from 'react'
import { APP_NAME, DEFAULT_DOCUMENT_TITLE } from '@/utils/constants'

export function formatDocumentTitle(title) {
  const text = typeof title === 'string' ? title.trim() : ''
  return text ? `${text} | ${APP_NAME}` : DEFAULT_DOCUMENT_TITLE
}

export function useDocumentTitle(title) {
  useEffect(() => {
    if (title === false) return undefined
    const previous = document.title
    document.title = formatDocumentTitle(title)
    return () => {
      document.title = previous
    }
  }, [title])
}

export default useDocumentTitle
