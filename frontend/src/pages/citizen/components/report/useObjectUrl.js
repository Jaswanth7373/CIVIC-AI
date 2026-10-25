/**
 * useObjectUrl - a temporary `blob:` URL for a File (image previews), revoked when the file changes or the
 * component unmounts, so previews never leak memory.
 */
import { useEffect, useState } from 'react'

export function useObjectUrl(file) {
  const [entry, setEntry] = useState({ file: null, url: null })

  useEffect(() => {
    if (!(file instanceof Blob)) return undefined
    const url = URL.createObjectURL(file)
    setEntry({ file, url })
    return () => URL.revokeObjectURL(url)
  }, [file])

  return file instanceof Blob && entry.file === file ? entry.url : null
}

export default useObjectUrl
