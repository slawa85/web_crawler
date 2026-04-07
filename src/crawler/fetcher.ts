import { createHash } from 'crypto'
import { fetch, type Response } from 'undici'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

const USER_AGENT = 'ExampleComCrawler/1.0 (+https://example.com/)'
const MAX_REDIRECTS = 10

export type FetchResult = {
  url: string             // final URL after redirects
  status: number
  body: string | null     // null if non-HTML content type
  contentHash: string
  redirectChain: string[]
  error?: string
}

function isHtml(contentType: string | null): boolean {
  if (contentType === null) return false
  const lower = contentType.toLowerCase()
  return lower.includes('text/html') || lower.includes('application/xhtml+xml')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Fetch a URL and return a structured result.
 *
 * - Follows redirects manually to record the full chain (max 10 hops)
 * - Only reads the body when Content-Type is HTML
 * - Enforces a 5MB body size cap
 * - Uses a 10-second timeout per request hop
 * - Returns a FetchResult with error set on network/timeout errors (status: 0)
 */
export async function fetchUrl(url: string): Promise<FetchResult> {
  const redirectChain: string[] = []
  let currentUrl = url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      const error = `Too many redirects (>${MAX_REDIRECTS}) — aborting`
      logger.warn({ url, redirectChain }, error)
      return { url: currentUrl, status: 0, body: null, contentHash: sha256(''), redirectChain, error }
    }

    let response: Response

    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',   // handle redirects manually to record chain
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.debug({ url: currentUrl, err }, 'Fetch network error')
      return { url: currentUrl, status: 0, body: null, contentHash: sha256(''), redirectChain, error }
    }

    const status = response.status

    // 3xx redirect handling
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location')
      if (location === null || location === '') {
        return {
          url: currentUrl,
          status,
          body: null,
          contentHash: sha256(''),
          redirectChain,
          error: 'Redirect with no Location header',
        }
      }

      // Detect redirect loop
      const resolved = new URL(location, currentUrl).toString()
      if (redirectChain.includes(resolved) || resolved === currentUrl) {
        return {
          url: currentUrl,
          status,
          body: null,
          contentHash: sha256(''),
          redirectChain,
          error: `Redirect loop detected at ${resolved}`,
        }
      }

      redirectChain.push(currentUrl)
      currentUrl = resolved
      // Consume response body to free the connection
      await response.body?.cancel()
      continue
    }

    // Non-redirect response — check content type before reading body
    const contentType = response.headers.get('content-type')

    if (!isHtml(contentType)) {
      // Binary or non-HTML — consume without storing
      await response.body?.cancel()
      return { url: currentUrl, status, body: null, contentHash: sha256(''), redirectChain }
    }

    // Check Content-Length header before streaming
    const clHeader = response.headers.get('content-length')
    if (clHeader !== null) {
      const contentLength = parseInt(clHeader, 10)
      if (!isNaN(contentLength) && contentLength > config.maxResponseBytes) {
        await response.body?.cancel()
        return {
          url: currentUrl,
          status,
          body: null,
          contentHash: sha256(''),
          redirectChain,
          error: `Response too large: ${contentLength} bytes`,
        }
      }
    }

    // Stream body with size cap
    let body: string
    try {
      const chunks: Uint8Array[] = []
      let totalBytes = 0
      const reader = response.body?.getReader()

      if (reader === undefined) {
        return { url: currentUrl, status, body: null, contentHash: sha256(''), redirectChain }
      }

      for (;;) {
        const readResult = await reader.read() as ReadableStreamReadResult<Uint8Array>
        const { done, value } = readResult
        if (done) break
        if (value !== undefined) {
          totalBytes += value.byteLength
          if (totalBytes > config.maxResponseBytes) {
            await reader.cancel()
            return {
              url: currentUrl,
              status,
              body: null,
              contentHash: sha256(''),
              redirectChain,
              error: `Response body exceeded ${config.maxResponseBytes} bytes`,
            }
          }
          chunks.push(value)
        }
      }

      body = Buffer.concat(chunks).toString('utf-8')
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.debug({ url: currentUrl, err }, 'Error reading response body')
      return { url: currentUrl, status, body: null, contentHash: sha256(''), redirectChain, error }
    }

    const contentHash = sha256(body)
    logger.debug({ url: currentUrl, status, bytes: body.length }, 'Fetched')
    return { url: currentUrl, status, body, contentHash, redirectChain }
  }

  // Unreachable — TypeScript needs this
  return {
    url: currentUrl,
    status: 0,
    body: null,
    contentHash: sha256(''),
    redirectChain,
    error: 'Unexpected loop exit',
  }
}
