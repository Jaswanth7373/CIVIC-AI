/**
 * A temporary `blob:` URL for a File / Blob (to show a photo the visitor picked), revoked when the file changes
 * or the component unmounts so the browser can free the memory. Returns null when there is no file.
 */
import { useEffect, useState } from 'react'

export function useObjectUrl(file) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    if (!(file instanceof Blob)) {
      setUrl(null)
      return undefined
    }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])

  return url
}

export default useObjectUrl
