import { getSql } from './connection.js'
import { logger } from '../utils/logger.js'

export async function runMigrations(): Promise<void> {
  const sql = getSql()
  logger.info('Running database migrations...')

  // All DDL uses IF NOT EXISTS so each statement is idempotent — a transaction wrapper
  // is not required, and avoids the TypeScript limitation where Omit<Sql, ...> does not
  // preserve tagged-template call signatures on TransactionSql.
  try {
    // url_frontier: main crawl queue + dedup + result log
    // domain is a plain column populated at insert time (application-level extraction
    // via new URL(url).hostname) — avoids the JS template-literal \1 escape issue
    // that would silently corrupt a GENERATED ALWAYS AS regexp_replace expression.
    await sql`
      CREATE TABLE IF NOT EXISTS url_frontier (
        id              BIGSERIAL PRIMARY KEY,
        url             TEXT        NOT NULL UNIQUE,
        domain          TEXT        NOT NULL,
        status          TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','in_progress','done','failed')),
        depth           INT         NOT NULL DEFAULT 0,
        parent_url      TEXT,
        discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        next_fetch_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        fetched_at      TIMESTAMPTZ,
        http_status     INT,
        content_hash    TEXT,
        error           TEXT,
        retry_count     INT         NOT NULL DEFAULT 0
      )
    `

    await sql`
      CREATE INDEX IF NOT EXISTS idx_frontier_work
        ON url_frontier (domain, next_fetch_at)
        WHERE status = 'pending'
    `

    await sql`
      CREATE INDEX IF NOT EXISTS idx_frontier_in_progress_domain
        ON url_frontier (domain)
        WHERE status = 'in_progress'
    `

    // domain_info: robots.txt cache + per-domain crawl delay
    await sql`
      CREATE TABLE IF NOT EXISTS domain_info (
        domain            TEXT        PRIMARY KEY,
        robots_txt        TEXT,
        crawl_delay_ms    INT         NOT NULL DEFAULT 1000,
        is_allowed        BOOLEAN     NOT NULL DEFAULT TRUE,
        fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `

    logger.info('Migrations complete')
  } catch (err) {
    logger.fatal({ err }, 'Migration failed — cannot continue')
    process.exit(1)
  }
}

export async function seedUrl(url: string): Promise<void> {
  const sql = getSql()
  logger.info({ url }, 'Seeding initial URL')

  // domain is a plain column — extract at application level to avoid the
  // JS \1 backreference corruption that a GENERATED ALWAYS AS expression had.
  const domain = new URL(url).hostname

  try {
    await sql`
      INSERT INTO url_frontier (url, domain, depth)
      VALUES (${url}, ${domain}, 0)
      ON CONFLICT DO NOTHING
    `
  } catch (err) {
    logger.fatal({ err }, 'Failed to seed initial URL — cannot continue')
    process.exit(1)
  }
}
