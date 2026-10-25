import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/utils/cn'
import { FIELD_BASE, FIELD_SIZES } from './fieldStyles'

/**
 * Search box with a debounced `onSearch(term)`: the callback fires `delay` ms after the user stops typing,
 * immediately on Enter, and immediately when the clear (x) button is pressed. It never fires on mount.
 * `value` (optional) keeps the box in sync with external state such as a `?search=` URL parameter.
 *
 * @param {object} props
 * @param {(term: string) => void} props.onSearch
 * @param {string} [props.value] external value (e.g. from the URL)
 * @param {string} [props.defaultValue]
 * @param {number} [props.delay=350]
 * @param {string} [props.placeholder='Search']
 * @param {string} [props.label='Search'] accessible name
 * @param {'sm'|'md'|'lg'} [props.size='md']
 */
export function SearchInput({
  value,
  defaultValue = '',
  onSearch,
  onChange,
  delay = 350,
  placeholder = 'Search',
  label = 'Search',
  size = 'md',
  autoFocus = false,
  className,
  inputClassName,
  ...props
}) {
  const [term, setTerm] = useState(value ?? defaultValue)
  const [syncedValue, setSyncedValue] = useState(value)
  const inputRef = useRef(null)
  const onSearchRef = useRef(onSearch)
  const lastSearchedRef = useRef(value ?? defaultValue)
  const timerRef = useRef(0)

  // Adopt a new external value during render (React's "adjusting state when a prop changes" pattern).
  if (value !== undefined && value !== syncedValue) {
    setSyncedValue(value)
    setTerm(value)
  }

  useEffect(() => {
    onSearchRef.current = onSearch
  })

  useEffect(() => {
    if (value !== undefined) lastSearchedRef.current = value
  }, [value])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const fire = (next) => {
    window.clearTimeout(timerRef.current)
    if (next === lastSearchedRef.current) return
    lastSearchedRef.current = next
    onSearchRef.current?.(next)
  }

  const handleChange = (event) => {
    const next = event.target.value
    setTerm(next)
    onChange?.(event)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => fire(next.trim()), delay)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      fire(term.trim())
    } else if (event.key === 'Escape' && term) {
      event.stopPropagation()
      setTerm('')
      fire('')
    }
  }

  const clear = () => {
    setTerm('')
    fire('')
    inputRef.current?.focus()
  }

  return (
    <div role="search" className={cn('relative w-full', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
      <input
        ref={inputRef}
        type="search"
        value={term}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={label}
        autoFocus={autoFocus}
        enterKeyHint="search"
        autoComplete="off"
        className={cn(
          FIELD_BASE,
          FIELD_SIZES[size] ?? FIELD_SIZES.md,
          'pl-9 pr-10 [&::-webkit-search-cancel-button]:appearance-none',
          inputClassName,
        )}
        {...props}
      />
      {term ? (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-ink-3 transition-[color,background-color,opacity,scale] duration-200 ease-spring hover:bg-sunken hover:text-ink starting:scale-75 starting:opacity-0 pointer-coarse:size-9"
        >
          <X aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  )
}

export default SearchInput
