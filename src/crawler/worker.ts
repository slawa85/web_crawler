import { dequeueUrl, enqueueUrls, markDone, markFailed, requeueForRetry, updateNextFetch, type QueuedUrl, type UrlRecord } from '../db/frontier.js'
import { fetchUrl } from './fetcher.js'
import { extractUrls } from './parser.js'
import { isInScope } from './normalizer.js'
import { ensureDomainInfo, isUrlAllowed, getNextFetchAt } from './politeness.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

export type ActiveWorkers = {
  count: number
}

/**
 * Run a single worker loop.
 *
 * The worker continues until `shuttingDown` is set to true.
 * It increments/decrements `activeWorkers.count` around each dequeue→enqueue
 * cycle so the orchestrator can determine when it is safe to terminate.
 */
export async function runWorker(
  workerId: number,
  shuttingDown: { value: boolean },
  activeWorkers: ActiveWorkers,
): Promise<void> {
  logger.info({ workerId }, 'Worker started')

  while (!shuttingDown.value) {
    activeWorkers.count++

    let url

    try {
      url = await dequeueUrl()
    } catch (err) {
      logger.error({ err, workerId }, 'dequeueUrl threw — worker backing off')
      activeWorkers.count--
      await sleep(1000)
      continue
    }

    if (url === null) {
      activeWorkers.count--
      // Skip the idle sleep if shutdown was signalled — exit on the next loop check.
      if (!shuttingDown.value) {
        await sleep(500)
      }
      continue
    }

    logger.debug({ workerId, url: url.url, depth: url.depth }, 'Dequeued URL')

    // ── Politeness check ──────────────────────────────────────────────────────
    let domainInfo

    try {
      domainInfo = await ensureDomainInfo(url.domain)
    } catch (err) {
      logger.error({ err, workerId, url: url.url }, 'ensureDomainInfo failed — marking URL failed')
      try {
        await markFailed(url.id, `ensureDomainInfo error: ${String(err)}`)
      } catch (innerErr) {
        logger.error({ innerErr }, 'markFailed also failed')
      }
      activeWorkers.count--
      continue
    }

    if (!isUrlAllowed(url.url, domainInfo)) {
      logger.debug({ url: url.url }, 'Disallowed by robots.txt — marking failed')
      try {
        await markFailed(url.id, 'disallowed by robots.txt')
      } catch (err) {
        logger.error({ err }, 'markFailed failed after robots disallow')
      }
      activeWorkers.count--
      continue
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────
    let result

    try {
      result = await fetchUrl(url.url)
    } catch (err) {
      logger.error({ err, workerId, url: url.url }, 'fetchUrl threw unexpectedly')
      try {
        await handleFetchFailure(url, 0, `unexpected fetch error: ${String(err)}`, workerId)
      } catch (innerErr) {
        logger.error({ innerErr }, 'handleFetchFailure also failed')
      }
      activeWorkers.count--
      continue
    }

    if (result.error !== undefined) {
      logger.debug({ url: url.url, error: result.error, status: result.status }, 'Fetch returned error')
      try {
        await handleFetchFailure(url, result.status, result.error, workerId)
      } catch (err) {
        logger.error({ err }, 'handleFetchFailure failed after fetch error')
      }
      activeWorkers.count--
      continue
    }

    // ── Retryable HTTP status (429 / 5xx) ─────────────────────────────────────
    if (isRetryableStatus(result.status)) {
      logger.debug({ url: url.url, status: result.status }, 'Retryable HTTP status')
      try {
        await handleFetchFailure(url, result.status, `HTTP ${result.status}`, workerId)
      } catch (err) {
        logger.error({ err }, 'handleFetchFailure failed after retryable status')
      }
      activeWorkers.count--
      continue
    }

    // ── Scope check after redirects ───────────────────────────────────────────
    if (!isInScope(result.url)) {
      logger.warn({ originalUrl: url.url, finalUrl: result.url }, 'Final URL after redirects is out of scope — skipping')
      try {
        await markFailed(url.id, `redirect led out of scope: ${result.url}`)
      } catch (err) {
        logger.error({ err }, 'markFailed failed after out-of-scope redirect')
      }
      activeWorkers.count--
      continue
    }

    // ── Parse and enqueue discovered URLs ─────────────────────────────────────
    if (result.body !== null) {
      const rawUrls = extractUrls(result.body, result.url)

      const newRecords: UrlRecord[] = rawUrls
        .filter((u) => isInScope(u))
        .filter(() => url.depth + 1 <= config.maxDepth)
        .map((u): UrlRecord => ({
          url: u,
          depth: url.depth + 1,
          parentUrl: url.url,
        }))

      if (newRecords.length > 0) {
        try {
          const inserted = await enqueueUrls(newRecords, config.maxDepth, config.maxPages)
          logger.debug({ url: url.url, discovered: newRecords.length, inserted }, 'Enqueued new URLs')
        } catch (err) {
          // enqueue failure is non-fatal: log and mark current URL as failed instead of crashing worker
          logger.error({ err, url: url.url }, 'enqueueUrls failed — marking URL failed')
          try {
            await markFailed(url.id, `enqueueUrls error: ${String(err)}`)
          } catch (innerErr) {
            logger.error({ innerErr }, 'markFailed also failed')
          }
          activeWorkers.count--
          continue
        }
      }
    }

    // ── Mark done and update politeness timer ─────────────────────────────────
    try {
      await markDone(url.id, result.status, result.contentHash)
    } catch (err) {
      logger.error({ err, url: url.url }, 'markDone failed')
    }

    try {
      const nextAt = getNextFetchAt(url.domain, domainInfo.crawlDelayMs)
      await updateNextFetch(url.domain, nextAt)
    } catch (err) {
      logger.error({ err, domain: url.domain }, 'updateNextFetch failed')
    }

    activeWorkers.count--
  }

  logger.info({ workerId }, 'Worker stopped')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

/**
 * Handle a fetch failure by either requeueing for retry (transient errors) or
 * marking as permanently failed.
 *
 * Retryable: network errors (status 0), HTTP 429, HTTP 5xx.
 */
async function handleFetchFailure(
  url: QueuedUrl,
  status: number,
  error: string,
  workerId: number,
): Promise<void> {
  const retryable = status === 0 || isRetryableStatus(status)

  if (retryable && url.retryCount < config.maxRetries) {
    const backoffMs = Math.min(5000 * Math.pow(3, url.retryCount), 60_000) // 5s, 15s, 45s (capped at 60s)
    logger.warn(
      { workerId, url: url.url, retryCount: url.retryCount + 1, backoffMs, status },
      'Requeueing URL for retry with backoff',
    )
    await requeueForRetry(
      url.id,
      url.retryCount + 1,
      status === 0 ? null : status,
      backoffMs,
    )
  } else {
    const suffix = url.retryCount > 0 ? ` (after ${url.retryCount} retries)` : ''
    await markFailed(url.id, `${error}${suffix}`, status === 0 ? null : status)
  }
}
