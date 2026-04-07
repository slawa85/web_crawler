import { logger } from '../utils/logger.js'

const MAX_URL_LENGTH = 2048
const MAX_PATH_DEPTH = 15

// Tracking parameters to strip from query strings
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'ref', 'sessionid', 'phpsessid',
])

/**
 * Normalise a raw URL extracted from a page.
 *
 * Steps (in order):
 * 1. Resolve relative URLs against baseUrl
 * 2. Strip fragment
 * 3. Lowercase scheme and host
 * 4. Remove default ports (:80 on http, :443 on https)
 * 5. Decode then re-encode percent-encoded characters consistently
 * 6. Sort query parameters alphabetically
 * 7. Remove known tracking params
 * 8. Remove trailing slash from paths (except root /)
 *
 * Returns null if the URL is invalid or should be discarded.
 */
export function normalizeUrl(raw: string, baseUrl: string): string | null {
  let parsed: URL

  try {
    parsed = new URL(raw, baseUrl)
  } catch (err) {
    logger.debug({ raw, baseUrl, err }, 'normalizeUrl: invalid URL, discarding')
    return null
  }

  // Only http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }

  // Strip fragment
  parsed.hash = ''

  // Lowercase scheme and host (URL API lowercases these automatically, but be explicit)
  parsed.hostname = parsed.hostname.toLowerCase()

  // Remove default ports
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = ''
  }

  // Sort query parameters and remove tracking params
  const params = new URLSearchParams(parsed.searchParams)
  const cleanParams = new URLSearchParams()

  // Collect non-tracking keys, sorted
  const keys = Array.from(params.keys())
    .filter((k) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort()

  for (const key of keys) {
    const vals = params.getAll(key)
    for (const val of vals) {
      cleanParams.append(key, val)
    }
  }

  parsed.search = cleanParams.toString() ? `?${cleanParams.toString()}` : ''

  // Remove trailing slash from paths except root "/"
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }

  // Re-encode path consistently (decode then let URL API re-encode)
  try {
    parsed.pathname = encodeURIComponent(decodeURIComponent(parsed.pathname))
      .replace(/%2F/gi, '/')   // keep slashes literal
      .replace(/%40/gi, '@')   // keep @ literal
      .replace(/%3A/gi, ':')   // keep : literal
      .replace(/%21/gi, '!')
      .replace(/%27/gi, "'")
      .replace(/%28/gi, '(')
      .replace(/%29/gi, ')')
      .replace(/%7E/gi, '~')
  } catch {
    // Decoding failed — leave pathname as-is
  }

  return parsed.toString()
}

/**
 * Returns true if the URL is in scope for crawling:
 * - http or https scheme
 * - host is exactly example.com or ends with .example.com
 * - URL length <= 2048
 * - Not a spider trap (path depth <= 15, no repeated segments)
 */
export function isInScope(url: string): boolean {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== 'example.com' && !host.endsWith('.example.com')) {
    return false
  }

  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  // Spider trap detection
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0)

  // Path depth guard
  if (segments.length > MAX_PATH_DEPTH) {
    return false
  }

  // Repeated segment guard (e.g. /a/b/a/b/a/b)
  if (hasRepeatedSegments(segments)) {
    return false
  }

  return true
}

/**
 * Detect repeated path segment patterns that indicate a spider trap.
 * Triggers when any segment appears more than 3 times in the path.
 */
function hasRepeatedSegments(segments: string[]): boolean {
  const counts = new Map<string, number>()
  for (const seg of segments) {
    const count = (counts.get(seg) ?? 0) + 1
    if (count > 3) return true
    counts.set(seg, count)
  }
  return false
}
