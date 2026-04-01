import * as cheerio from 'cheerio'
import { normalizeUrl, isInScope } from './normalizer.js'
import { logger } from '../utils/logger.js'

/**
 * Extract all in-scope, normalised URLs from an HTML document.
 *
 * Extracts from:
 *   - <a href>              navigation links
 *   - <link rel="canonical"> canonical URL
 *   - <link rel="alternate"> alternate versions
 *
 * Does NOT extract: script[src], img[src], link[rel=stylesheet]
 *
 * Resolves <base href> first so relative URLs are resolved correctly.
 */
export function extractUrls(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html)

  // Determine the effective base URL: <base href> takes precedence over pageUrl
  const baseHref = $('base[href]').first().attr('href')
  let baseUrl = pageUrl

  if (baseHref !== undefined && baseHref !== '') {
    try {
      baseUrl = new URL(baseHref, pageUrl).toString()
    } catch {
      logger.debug({ baseHref, pageUrl }, 'parser: invalid <base href>, falling back to pageUrl')
    }
  }

  const rawUrls: string[] = []

  // <a href>
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href')
    if (href !== undefined && href !== '') {
      rawUrls.push(href)
    }
  })

  // <link rel="canonical">
  $('link[rel="canonical"][href]').each((_i, el) => {
    const href = $(el).attr('href')
    if (href !== undefined && href !== '') {
      rawUrls.push(href)
    }
  })

  // <link rel="alternate">
  $('link[rel="alternate"][href]').each((_i, el) => {
    const href = $(el).attr('href')
    if (href !== undefined && href !== '') {
      rawUrls.push(href)
    }
  })

  const result: string[] = []
  const seen = new Set<string>()

  for (const raw of rawUrls) {
    let normalized: string | null = null

    try {
      normalized = normalizeUrl(raw, baseUrl)
    } catch (err) {
      logger.debug({ raw, baseUrl, err }, 'parser: normalizeUrl threw unexpectedly, skipping')
      continue
    }

    if (normalized === null) continue
    if (!isInScope(normalized)) continue
    if (seen.has(normalized)) continue

    seen.add(normalized)
    result.push(normalized)
  }

  logger.debug({ pageUrl, extracted: result.length, rawCount: rawUrls.length }, 'parser: extracted URLs')
  return result
}
