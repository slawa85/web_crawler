import postgres from 'postgres'
import { getSql } from './connection.js'
import { logger } from '../utils/logger.js'

// TypeScript's Omit<T, K> does not preserve call signatures on interfaces.
// TransactionSql extends Omit<Sql, ...> so its tagged-template call signature is lost.
// We cast to Sql<{}> inside begin() callbacks to restore the call signature.
// Intersecting the two types causes infinite instantiation, so we cast at the use site.
type CallableSql = postgres.Sql<Record<string, unknown>>

// ── Public types ──────────────────────────────────────────────────────────────

export type UrlRecord = {
  url: string
  depth: number
  parentUrl: string | null
}

export type QueuedUrl = {
  id: bigint
  url: string
  domain: string
  depth: number
  parentUrl: string | null
  retryCount: number
}

export type FrontierStats = {
  pending: number
  inProgress: number
  done: number
  failed: number
  maxDepth: number
  http2xx: number
  http3xx: number
  http4xx: number
  http429: number   // subset of http4xx — rate-limit responses specifically
  http5xx: number
  httpErrors: number
}

export type DomainInfo = {
  domain: string
  robotsTxt: string | null
  crawlDelayMs: number
  isAllowed: boolean
  fetchedAt: Date
}

// ── Internal error helper ─────────────────────────────────────────────────────

class CrawlerError extends Error {
  constructor(
    message: string,
    // Error.cause is a built-in property in ES2022 — noImplicitOverride requires `override`
    public override readonly cause: unknown,
  ) {
    super(message)
    this.name = 'CrawlerError'
  }
}

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Bulk-insert URLs into the frontier.
 * Respects maxDepth and maxPages limits.
 * Returns the count of rows actually inserted.
 */
export async function enqueueUrls(
  urls: UrlRecord[],
  maxDepth: number,
  maxPages: number,
): Promise<number> {
  if (urls.length === 0) return 0

  const sql = getSql()

  // Filter by depth before touching DB
  const eligible = urls.filter((u) => u.depth <= maxDepth)
  if (eligible.length === 0) return 0

  try {
    const result = await sql.begin(async (rawTx) => {
      // Cast to Sql<{}> restores the tagged-template call signature lost via Omit<Sql, ...>
      const tx = rawTx as unknown as CallableSql

      // Check total count (pending + in_progress + done) vs maxPages ceiling.
      // Note: maxPages is a soft limit under concurrent load — multiple workers
      // may pass this check simultaneously before any of them insert, so the
      // final row count can slightly exceed maxPages.
      const [row] = await tx<[{ total: string }]>`
        SELECT COUNT(*) AS total
        FROM url_frontier
        WHERE status IN ('pending', 'in_progress', 'done', 'failed')
      `
      const total = parseInt(row?.total ?? '0', 10)
      if (total >= maxPages) {
        logger.debug({ total, maxPages }, 'maxPages ceiling reached — skipping enqueue')
        return 0
      }

      // How many slots remain
      const slots = maxPages - total
      const toInsert = eligible.slice(0, slots)

      if (toInsert.length === 0) return 0

      // Build parallel arrays for unnest — avoids the sql() fragment helper
      // which must share the same connection instance as the enclosing tagged
      // template (tx). Using unnest keeps everything in one clean tx`` call.
      // domain is extracted here (application-level) to match the plain column
      // added in migrate.ts (no longer a GENERATED ALWAYS AS expression).
      const insertUrls:    string[]       = toInsert.map((u) => u.url)
      const insertDepths:  number[]       = toInsert.map((u) => u.depth)
      const insertParents: (string|null)[] = toInsert.map((u) => u.parentUrl ?? null)
      const insertDomains: string[]       = toInsert.map((u) => new URL(u.url).hostname)

      const inserted = await tx<Array<{ id: bigint }>>`
        INSERT INTO url_frontier (url, depth, parent_url, domain)
        SELECT
          unnest(${insertUrls}::text[]),
          unnest(${insertDepths}::int[]),
          unnest(${insertParents}::text[]),
          unnest(${insertDomains}::text[])
        ON CONFLICT (url) DO NOTHING
        RETURNING id
      `

      return inserted.length
    })

    logger.debug({ inserted: result }, 'Enqueued URLs')
    return result
  } catch (err) {
    logger.error({ err }, 'enqueueUrls failed')
    throw new CrawlerError('enqueueUrls failed', err)
  }
}

/**
 * Domain-aware dequeue.
 * Only picks a URL from a domain with no in_progress rows, preventing
 * concurrent workers from hammering the same domain.
 * Returns null if no eligible URL exists.
 */
export async function dequeueUrl(): Promise<QueuedUrl | null> {
  const sql = getSql()

  try {
    // Wrapping in a transaction is required because pg_try_advisory_xact_lock
    // is transaction-scoped — it is released automatically at transaction end.
    // Without an explicit transaction the lock would be released immediately
    // after the SELECT, defeating the per-domain concurrency guard.
    //
    // pg_try_advisory_xact_lock(hashtext(domain)) acquires a non-blocking
    // transaction-scoped advisory lock keyed on the domain hash. If another
    // concurrent transaction already holds the lock for that domain,
    // pg_try_advisory_xact_lock returns false and the row is skipped by the
    // sub-SELECT, making the per-domain guard truly atomic with no TOCTOU race.
    const result = await sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as CallableSql

      const rows = await tx<Array<{
        id: bigint
        url: string
        domain: string
        depth: number
        parent_url: string | null
      }>>`
        UPDATE url_frontier
        SET status = 'in_progress', updated_at = now()
        WHERE id = (
          SELECT id FROM url_frontier
          WHERE status = 'pending'
            AND next_fetch_at <= now()
            AND pg_try_advisory_xact_lock(hashtext(domain))
          ORDER BY next_fetch_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, url, domain, depth, parent_url
      `

      return rows
    })

    if (result.length === 0) return null

    const row = result[0]
    if (row === undefined) return null

    return {
      id: row.id,
      url: row.url,
      domain: row.domain,
      depth: row.depth,
      parentUrl: row.parent_url,
    }
  } catch (err) {
    logger.error({ err }, 'dequeueUrl failed')
    throw new CrawlerError('dequeueUrl failed', err)
  }
}

/**
 * Mark a URL as successfully fetched.
 */
export async function markDone(
  id: bigint,
  httpStatus: number,
  contentHash: string,
): Promise<void> {
  const sql = getSql()
  try {
    await sql`
      UPDATE url_frontier
      SET status        = 'done',
          fetched_at    = now(),
          http_status   = ${httpStatus},
          content_hash  = ${contentHash}
      WHERE id = ${String(id)}
    `
  } catch (err) {
    logger.error({ err, id }, 'markDone failed')
    throw new CrawlerError('markDone failed', err)
  }
}

/**
 * Mark a URL as failed with an error message.
 */
export async function markFailed(id: bigint, error: string): Promise<void> {
  const sql = getSql()
  try {
    await sql`
      UPDATE url_frontier
      SET status      = 'failed',
          fetched_at  = now(),
          error       = ${error}
      WHERE id = ${String(id)}
    `
  } catch (err) {
    logger.error({ err, id }, 'markFailed failed')
    throw new CrawlerError('markFailed failed', err)
  }
}

/**
 * Advance next_fetch_at for all pending URLs on a domain
 * to enforce per-domain crawl delay.
 */
export async function updateNextFetch(
  domain: string,
  nextFetchAt: Date,
): Promise<void> {
  const sql = getSql()
  try {
    await sql`
      UPDATE url_frontier
      SET next_fetch_at = ${nextFetchAt}
      WHERE domain = ${domain}
        AND status = 'pending'
    `
  } catch (err) {
    logger.error({ err, domain }, 'updateNextFetch failed')
    throw new CrawlerError('updateNextFetch failed', err)
  }
}

/**
 * Reset stalled in_progress rows (older than timeoutMinutes) back to pending.
 * Protects against dead workers that never called markDone/markFailed.
 * Returns count of requeued rows.
 */
export async function requeueStalled(timeoutMinutes: number): Promise<number> {
  const sql = getSql()
  try {
    const result = await sql<Array<{ id: bigint }>>`
      UPDATE url_frontier
      SET status = 'pending',
          error  = NULL
      WHERE status = 'in_progress'
        AND updated_at < now() - ${timeoutMinutes} * interval '1 minute'
      RETURNING id
    `
    if (result.length > 0) {
      logger.warn({ count: result.length, timeoutMinutes }, 'Requeued stalled URLs')
    }
    return result.length
  } catch (err) {
    logger.error({ err }, 'requeueStalled failed')
    throw new CrawlerError('requeueStalled failed', err)
  }
}

/**
 * Return aggregate counts and HTTP status breakdown.
 * Used for termination polling and the final summary report.
 */
export async function getFrontierStats(): Promise<FrontierStats> {
  const sql = getSql()
  try {
    const [counts] = await sql<[{
      pending: string
      in_progress: string
      done: string
      failed: string
      max_depth: string
    }]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')     AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'done')        AS done,
        COUNT(*) FILTER (WHERE status = 'failed')      AS failed,
        COALESCE(MAX(depth), 0)                        AS max_depth
      FROM url_frontier
    `

    const [httpBreakdown] = await sql<[{
      http2xx: string
      http3xx: string
      http4xx: string
      http5xx: string
      http_errors: string
    }]>`
      SELECT
        COUNT(*) FILTER (WHERE http_status >= 200 AND http_status < 300) AS http2xx,
        COUNT(*) FILTER (WHERE http_status >= 300 AND http_status < 400) AS http3xx,
        COUNT(*) FILTER (WHERE http_status >= 400 AND http_status < 500) AS http4xx,
        COUNT(*) FILTER (WHERE http_status >= 500 AND http_status < 600) AS http5xx,
        COUNT(*) FILTER (WHERE http_status IS NULL AND status = 'failed')  AS http_errors
      FROM url_frontier
      WHERE status IN ('done', 'failed')
    `

    return {
      pending:    parseInt(counts?.pending     ?? '0', 10),
      inProgress: parseInt(counts?.in_progress ?? '0', 10),
      done:       parseInt(counts?.done        ?? '0', 10),
      failed:     parseInt(counts?.failed      ?? '0', 10),
      maxDepth:   parseInt(counts?.max_depth   ?? '0', 10),
      http2xx:    parseInt(httpBreakdown?.http2xx     ?? '0', 10),
      http3xx:    parseInt(httpBreakdown?.http3xx     ?? '0', 10),
      http4xx:    parseInt(httpBreakdown?.http4xx     ?? '0', 10),
      http5xx:    parseInt(httpBreakdown?.http5xx     ?? '0', 10),
      httpErrors: parseInt(httpBreakdown?.http_errors ?? '0', 10),
    }
  } catch (err) {
    logger.error({ err }, 'getFrontierStats failed')
    throw new CrawlerError('getFrontierStats failed', err)
  }
}

/**
 * Upsert domain info (robots.txt cache).
 */
export async function saveDomainInfo(info: DomainInfo): Promise<void> {
  const sql = getSql()
  try {
    await sql`
      INSERT INTO domain_info (domain, robots_txt, crawl_delay_ms, is_allowed, fetched_at)
      VALUES (
        ${info.domain},
        ${info.robotsTxt},
        ${info.crawlDelayMs},
        ${info.isAllowed},
        ${info.fetchedAt}
      )
      ON CONFLICT (domain) DO UPDATE SET
        robots_txt     = EXCLUDED.robots_txt,
        crawl_delay_ms = EXCLUDED.crawl_delay_ms,
        is_allowed     = EXCLUDED.is_allowed,
        fetched_at     = EXCLUDED.fetched_at
    `
  } catch (err) {
    logger.error({ err, domain: info.domain }, 'saveDomainInfo failed')
    throw new CrawlerError('saveDomainInfo failed', err)
  }
}

/**
 * Load cached domain info. Returns null if domain is not in the table.
 */
export async function getDomainInfo(domain: string): Promise<DomainInfo | null> {
  const sql = getSql()
  try {
    const rows = await sql<Array<{
      domain: string
      robots_txt: string | null
      crawl_delay_ms: number
      is_allowed: boolean
      fetched_at: Date
    }>>`
      SELECT domain, robots_txt, crawl_delay_ms, is_allowed, fetched_at
      FROM domain_info
      WHERE domain = ${domain}
    `

    if (rows.length === 0) return null
    const row = rows[0]
    if (row === undefined) return null

    return {
      domain:       row.domain,
      robotsTxt:    row.robots_txt,
      crawlDelayMs: row.crawl_delay_ms,
      isAllowed:    row.is_allowed,
      fetchedAt:    row.fetched_at,
    }
  } catch (err) {
    logger.error({ err, domain }, 'getDomainInfo failed')
    throw new CrawlerError('getDomainInfo failed', err)
  }
}
