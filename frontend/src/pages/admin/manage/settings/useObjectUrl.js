import { useEffect, useState } from 'react'

/**
 * Object URL for a chosen File (null without one), revoked when the file changes or the component unmounts, so
 * the model playground can show the photo it analysed (with detections, or before / after) without uploading it
 * anywhere else.
 */
export function useObjectUrl(file) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!file) {
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
