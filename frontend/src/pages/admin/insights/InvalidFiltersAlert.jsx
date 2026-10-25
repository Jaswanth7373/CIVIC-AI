/**
 * InvalidFiltersAlert - one clear message when the page's filters cannot be applied (usually an outdated
 * link, e.g. a department that no longer exists), with the server's reason and a "Clear filters" action.
 * Pages render it instead of the same failure repeated in every widget (see filterValidationError).
 *
 * Props:
 * - error: the 400 validation error
 * - onReset(): clear the filters
 * - className
 */
import { X } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { getErrorMessage } from '@/utils/errors'

export function InvalidFiltersAlert({ error, onReset, className }) {
  return (
    <Alert
      tone="danger"
      title="These filters can't be applied"
      className={className}
      action={
        <Button variant="outline" size="sm" leftIcon={X} onClick={onReset}>
          Clear filters
        </Button>
      }
    >
      {getErrorMessage(error)} The link may be out of date; clear the filters to see every record.
    </Alert>
  )
}

export default InvalidFiltersAlert
