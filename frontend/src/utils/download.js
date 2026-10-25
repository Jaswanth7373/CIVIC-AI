/**
 * Browser file downloads for API responses (report exports).
 *
 * `saveBlob` uses the standard object-URL technique: wrap the Blob in a temporary `blob:` URL, click a hidden
 * `<a download>` link, then revoke the URL so the memory is released.
 */

/**
 * Extract the filename from a Content-Disposition header.
 * Supports RFC 5987 `filename*=UTF-8''report%20name.pdf` (preferred) and `filename="report.csv"`.
 */
export function filenameFromContentDisposition(header) {
  if (!header) return null
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''))
    } catch {
      return extended[1].trim()
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header)
  if (plain) return (plain[2] ?? plain[1]).trim().replace(/^"|"$/g, '') || null
  return null
}

/** Strip characters that are invalid in Windows / macOS / Linux filenames. */
export function sanitizeFilename(name, fallback = 'download') {
  const withoutControlChars = Array.from(String(name ?? ''))
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
  const cleaned = withoutControlChars
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

/** Trigger a download of `blob` as `filename`. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = sanitizeFilename(filename)
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoke on the next tick: some browsers start the download asynchronously after click().
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
