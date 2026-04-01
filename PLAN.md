# Web Crawler — Implementation Plan

## Requirments
Write a program that crawls webpages.
A crawler at its core downloads URLs, discovers new URLs in the downloaded content, and schedules download of new discovered URLs.
Example:
	•	Fetch the content of a discovered URL
	•	Discover any new URLs by extracting them from the fetched content
	•	Crawl any new URLs
	•	Seed the crawler with https://ipfabric.io/ as the start URL (first
	•	discovered URL)
State your assumptions and limitations of your solution. Evaluate the weaknesses of this solution. Suggestions for future improvements of your crawler is a plus. How it might be scaled to run on a large grid of machines.
Please design a solution that can run on multiple nodes, ensures a complete scan (when compared to single node/thread solution). Focus on horizontal scalability.

## Overview

A distributed-ready web crawler seeded at `https://ipfabric.io/`, scoped to that
domain and its subdomains. It fetches pages, extracts URLs from HTML, deduplicates
them, and schedules further fetches until the frontier is exhausted. On completion
it prints a summary report to the terminal.

---

## Final Tech Stack

| Concern              | Tool                  | Rationale                                                                                     |
|---------------------|-----------------------|-----------------------------------------------------------------------------------------------|
| Language             | TypeScript (Node 20)  | Type safety, broad ecosystem                                                                  |
| HTTP client          | `undici`              | Node-native, connection pooling, no extra deps                                                |
| HTML parsing         | `cheerio`             | jQuery-like selectors, lenient on malformed HTML, lightweight                                 |
| robots.txt parsing   | `robots-parser`       | Spec-compliant, small, well-maintained                                                        |
| Database client      | `postgres.js`         | Tagged-template raw SQL, TypeScript-native, handles `SKIP LOCKED` cleanly                     |
| Database             | PostgreSQL 16         | Frontier + dedup in one store; `SELECT FOR UPDATE SKIP LOCKED` for concurrent workers         |
| Logger               | `pino`                | Structured JSON logs, low overhead, pretty-print in dev via `pino-pretty`                     |
| Containerisation     | Docker + Compose      | Self-contained, one-command startup                                                           |
| No ORM               | —                     | Custom queue SQL (`SKIP LOCKED`, `ON CONFLICT DO NOTHING`) is not supported by any mainstream ORM |
| No web framework     | —                     | Crawler is a background process; no inbound HTTP                                              |

---

## Project Structure

```
.
├── docker-compose.yml          # PostgreSQL + crawler services
├── Dockerfile                  # Multi-stage build for the crawler
├── .env.example                # Environment variable template
├── package.json
├── tsconfig.json
├── PLAN.md                     # This file
├── SCALING.md                  # Scaling strategy and future improvements
└── src/
    ├── index.ts                # Entry point — wires everything together, starts the crawl
    ├── config.ts               # Typed configuration loaded from environment variables
    ├── db/
    │   ├── connection.ts       # postgres.js pool initialisation and teardown
    │   ├── migrate.ts          # Schema creation and seed URL insertion on startup
    │   └── frontier.ts         # All frontier SQL operations (enqueue, dequeue, mark, stats)
    ├── crawler/
    │   ├── worker.ts           # Single worker loop: dequeue → fetch → parse → enqueue
    │   ├── fetcher.ts          # HTTP fetch with redirect chain, timeout, size limit
    │   ├── parser.ts           # HTML → raw URL list via cheerio
    │   ├── normalizer.ts       # URL normalisation + in-scope filter
    │   └── politeness.ts       # robots.txt fetch/cache, crawl-delay enforcement
    └── utils/
        ├── logger.ts           # Pino logger instance (shared across modules)
        └── summary.ts          # Terminal summary report on crawl completion
```

---

## Database Schema

### `url_frontier`
Primary table: combines the URL queue, deduplication store, and crawl result log.

```sql
CREATE TABLE url_frontier (
  id              BIGSERIAL PRIMARY KEY,
  url             TEXT        NOT NULL UNIQUE,          -- dedup is a UNIQUE constraint
  domain          TEXT        NOT NULL
                  GENERATED ALWAYS AS (
                    regexp_replace(url, '^https?://([^/?#]+).*$', '\1')
                  ) STORED,                             -- derived from url — prevents domain/url drift
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','done','failed')),
  depth           INT         NOT NULL DEFAULT 0,
  parent_url      TEXT,                                 -- which page discovered this URL
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_fetch_at   TIMESTAMPTZ NOT NULL DEFAULT now(),   -- politeness: don't fetch before this
  fetched_at      TIMESTAMPTZ,
  http_status     INT,
  content_hash    TEXT,                                 -- SHA-256 of response body
  error           TEXT                                  -- error message if status = 'failed'
);

-- Supports domain-aware dequeue: pending rows ready to fetch, ordered by time
CREATE INDEX idx_frontier_work
  ON url_frontier (domain, next_fetch_at)
  WHERE status = 'pending';

-- Supports in-flight check per domain (used by domain-aware dequeue)
CREATE INDEX idx_frontier_in_progress_domain
  ON url_frontier (domain)
  WHERE status = 'in_progress';
```

### `domain_info`
Robots.txt cache and per-domain crawl delay.

```sql
CREATE TABLE domain_info (
  domain            TEXT        PRIMARY KEY,
  robots_txt        TEXT,                               -- raw robots.txt content
  crawl_delay_ms    INT         NOT NULL DEFAULT 1000,  -- milliseconds between fetches
  is_allowed        BOOLEAN     NOT NULL DEFAULT TRUE,  -- false if robots.txt disallows us
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Tasks

### Phase 1 — Scaffolding

#### Task 1 — Project initialisation
- `npm init`, install all dependencies
- `tsconfig.json` with strict mode, `noUncheckedIndexedAccess`, `ES2022` target
- ESLint with TypeScript rules
- `package.json` scripts: `dev` (tsx watch), `build` (tsc), `start` (node dist/index.js)
- `.env.example` with all required variables
- Folder structure created
- Commit `package-lock.json` — use `npm ci` (not `npm install`) in Dockerfile for reproducible builds

**Dependencies:**
```
undici cheerio robots-parser postgres pino pino-pretty
```
**Dev dependencies:**
```
typescript tsx @types/node eslint @typescript-eslint/eslint-plugin
```

#### Task 2 — Docker setup
- `Dockerfile`: multi-stage — build stage (tsc compile), runtime stage (node:20-alpine, copy dist)
- `docker-compose.yml`:
  - `postgres` service: image `postgres:16-alpine`, volume for data persistence, healthcheck
  - `crawler` service: depends on postgres being healthy, env vars from `.env`
- Startup order: Postgres healthy → migrations run → seed URL inserted → crawl starts

---

### Phase 2 — Database Layer

#### Task 3 — Connection and migrations (`src/db/connection.ts`, `src/db/migrate.ts`)
- `connection.ts`: initialise `postgres.js` pool, export typed `sql` tag, export `closeDb()`
- `migrate.ts`:
  - `runMigrations()`: creates `url_frontier` and `domain_info` tables if they don't exist
  - `seedUrl(url)`: inserts seed URL with `ON CONFLICT DO NOTHING`
  - Both called from `index.ts` before workers start

**Error handling:**
- Connection failure → log fatal + exit(1)
- Migration failure → log fatal + exit(1) (non-recoverable)

#### Task 4 — Frontier query layer (`src/db/frontier.ts`)

All public functions are fully typed. No raw strings leaking outside this module.

```ts
enqueueUrls(urls: UrlRecord[], maxDepth: number, maxPages: number): Promise<number>
  // Bulk INSERT with ON CONFLICT DO NOTHING
  // Filters out urls where depth > maxDepth before inserting
  // Checks total done+pending+in_progress count; skips insert if >= maxPages
  // Returns count of actually-inserted rows

dequeueUrl(): Promise<QueuedUrl | null>
  // Domain-aware dequeue — only picks a URL from a domain that has no in_progress rows,
  // preventing concurrent workers from violating per-domain crawl delay.
  // Full query:
  //   SELECT id, url, domain, depth, parent_url
  //   FROM url_frontier
  //   WHERE status = 'pending'
  //     AND next_fetch_at <= now()
  //     AND domain NOT IN (
  //       SELECT DISTINCT domain FROM url_frontier WHERE status = 'in_progress'
  //     )
  //   ORDER BY next_fetch_at
  //   LIMIT 1
  //   FOR UPDATE SKIP LOCKED
  // Returns null if no eligible URL exists (frontier empty or all domains busy)

markDone(id: bigint, httpStatus: number, contentHash: string): Promise<void>
markFailed(id: bigint, error: string): Promise<void>
updateNextFetch(domain: string, nextFetchAt: Date): Promise<void>
requeueStalled(timeoutMinutes: number): Promise<number>
  // Resets in_progress rows older than timeout back to pending
  // Returns count of requeued rows

getFrontierStats(): Promise<FrontierStats>
  // Returns:
  //   counts by crawler status (pending / in_progress / done / failed)
  //   max depth reached
  //   HTTP status code breakdown (count of done rows grouped by http_status / 100)
  // Used for both the termination poll and the final summary report.
  // FrontierStats type:
  //   { pending, inProgress, done, failed, maxDepth,
  //     http2xx, http3xx, http4xx, http5xx, httpErrors }

saveDomainInfo(info: DomainInfo): Promise<void>
getDomainInfo(domain: string): Promise<DomainInfo | null>
```

**Error handling:**
- All DB errors caught, logged with `logger.error`, re-thrown as typed `CrawlerError`
- Unique constraint violations on `enqueueUrls` silently swallowed (expected behaviour)

---

### Phase 3 — Core Crawler Logic

#### Task 5 — URL normaliser and scope filter (`src/crawler/normalizer.ts`)

`normalizeUrl(raw: string, baseUrl: string): string | null`
- Returns `null` if URL should be discarded
- Normalisation steps (in order):
  1. Resolve relative URLs against `baseUrl` (handles `./`, `../`, protocol-relative `//`)
  2. Respect `<base href>` — caller passes resolved base
  3. Strip fragment (`#section`)
  4. Lowercase scheme and host
  5. Remove default ports (`:80` on http, `:443` on https)
  6. Decode then re-encode percent-encoded characters consistently
  7. Sort query parameters alphabetically
  8. Remove known tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, `sessionid`, `phpsessid`)
  9. Remove trailing slash from paths (except root `/`)

`isInScope(url: string, allowedDomains: string[]): boolean`
- Accepts only `http:` and `https:` schemes
- Accepts only URLs whose host is `ipfabric.io` or ends with `.ipfabric.io`
- Rejects URLs exceeding 2048 characters
- Rejects obvious spider trap patterns (path depth > 15, repeated path segments)

**Error handling:**
- `new URL()` throws on invalid input — catch and return `null`, log at debug level

#### Task 6 — Fetcher (`src/crawler/fetcher.ts`)

`fetchUrl(url: string): Promise<FetchResult>`

```ts
type FetchResult = {
  url: string           // final URL after redirects
  status: number
  body: string | null   // null if non-HTML content type
  contentHash: string
  redirectChain: string[]
  error?: string
}
```

- Uses `undici.fetch` with `AbortSignal.timeout(10_000)` (10 second timeout)
- Follows redirects manually (max 10 hops) to record the full chain and detect loops
- Checks `Content-Type` before reading body: only read if `text/html` or `application/xhtml+xml`
- Streams response with size cap: abort if `Content-Length` > 5MB or if streamed body exceeds 5MB
- Sets `User-Agent: IPFabricCrawler/1.0 (+https://ipfabric.io)`
- Computes SHA-256 content hash on the raw HTML string

**Error handling:**
- Network errors (ECONNREFUSED, ETIMEDOUT, DNS failure): return `FetchResult` with `error` set, `status: 0`
- Non-2xx responses: still return result with the status code — caller decides whether to re-queue
- Redirect loops: abort after 10 hops, return error

#### Task 7 — HTML parser and URL extractor (`src/crawler/parser.ts`)

`extractUrls(html: string, pageUrl: string): string[]`

Uses `cheerio.load(html)` and selects:
- `a[href]` — navigation links
- `link[rel="canonical"][href]` — canonical URL (add to queue to normalise)
- `link[rel="alternate"][href]` — alternate versions

Resolves `<base href>` tag first — if present, all relative URLs resolve against it,
not `pageUrl`.

Does **not** extract:
- `script[src]` — JavaScript files, not HTML pages
- `img[src]` — binary content
- `link[rel="stylesheet"]` — CSS files

Each extracted raw URL is passed through `normalizeUrl()`. `null` results are
discarded. Returns only in-scope, normalised URLs.

**Error handling:**
- `cheerio.load` does not throw on malformed HTML (lenient parser)
- Per-URL normalisation errors caught internally, logged at debug level, URL skipped

#### Task 8 — Politeness layer (`src/crawler/politeness.ts`)

`ensureDomainInfo(domain: string): Promise<DomainInfo>`
- Check `domain_info` table (cache TTL: 24 hours)
- If missing or stale: fetch `https://{domain}/robots.txt` (10s timeout, ignore errors)
- Parse with `robots-parser`, extract `Crawl-delay` for our user-agent
- Store result in `domain_info` table
- If robots.txt fetch fails: assume allowed, use default crawl delay

`isUrlAllowed(url: string, domainInfo: DomainInfo): boolean`
- Checks the parsed robots.txt rules for our user-agent

`getNextFetchAt(domain: string, crawlDelayMs: number): Date`
- Returns `now() + crawlDelayMs`
- Called after each fetch to set `next_fetch_at` for that domain's next URL

**Error handling:**
- robots.txt fetch failure: log warning, default to allowed + 1000ms delay (fail open)
- Malformed robots.txt: `robots-parser` handles gracefully, returns permissive rules

---

### Phase 4 — Orchestration

#### Task 9 — Worker and main loop (`src/crawler/worker.ts`, `src/index.ts`)

**`worker.ts` — single worker loop:**
```
while (not shutting down):
  activeWorkers.increment()       ← in-process counter: worker is mid-loop
  url = dequeueUrl()
  if url is null:
    activeWorkers.decrement()
    wait 500ms, continue          ← brief back-off when frontier is empty or all domains busy

  domainInfo = ensureDomainInfo(url.domain)
  if not isUrlAllowed(url, domainInfo):
    markFailed(url.id, 'disallowed by robots.txt')
    activeWorkers.decrement()
    continue

  result = fetchUrl(url.url)

  if result.error:
    markFailed(url.id, result.error)
    activeWorkers.decrement()
    continue

  if result.body:
    rawUrls = extractUrls(result.body, result.url)
    newUrls = rawUrls
      .filter(isInScope)
      .filter(u => url.depth + 1 <= config.maxDepth)   ← MAX_DEPTH guard
      .map(u => ({ url: u, depth: url.depth + 1, parent_url: url.url }))
    enqueueUrls(newUrls, config.maxDepth, config.maxPages)  ← MAX_PAGES checked inside

  markDone(url.id, result.status, result.contentHash)
  updateNextFetch(url.domain, getNextFetchAt(url.domain, domainInfo.crawlDelayMs))
  activeWorkers.decrement()
```

**`index.ts` — orchestration:**
- Load config
- Run migrations + seed URL
- Start N workers concurrently (default 5, configurable)
- Start stalled-row requeue job (every 60 seconds)
- Wait for all workers to exit
- Print summary report
- Close DB connection + exit(0)

**Termination condition:**
Poll `getFrontierStats()` every 5 seconds. Signal all workers to stop when **both**:
1. `pending + in_progress = 0` in the DB, **and**
2. `activeWorkers = 0` in-process (no worker is between dequeue and its enqueue call)

Using only the DB count risks a race where a worker has dequeued a URL (status flips to
`in_progress`) but has not yet enqueued its children — making the count briefly appear
zero before new `pending` rows are inserted.

**Error handling:**
- Unhandled worker exception: log error, worker exits, orchestrator detects it and exits with code 1
- `enqueueUrls` failure: log error + mark current URL failed (don't crash the worker)

#### Task 10 — Graceful shutdown (`src/index.ts`)

- Listen for `SIGINT` and `SIGTERM`
- Set a shared `shuttingDown` flag that each worker checks between iterations
- Wait up to 30 seconds for in-flight fetches to complete
- Force-exit after timeout with `exit(1)` and a log warning

---

### Phase 5 — Output and Polish

#### Task 11 — Terminal summary report (`src/utils/summary.ts`)

`printSummary(stats: CrawlStats): void`

Queries `url_frontier` for final stats and prints:

```
╔══════════════════════════════════════════╗
║          CRAWL COMPLETE                  ║
╠══════════════════════════════════════════╣
║  Seed URL     : https://ipfabric.io/     ║
║  Duration     : 2m 14s                   ║
╠══════════════════════════════════════════╣
║  Pages fetched    :  312                 ║
║  URLs discovered  :  489                 ║
║  Depth reached    :  4                   ║
╠══════════════════════════════════════════╣
║  HTTP 2xx     :  304                     ║
║  HTTP 3xx     :  5                       ║
║  HTTP 4xx     :  7                       ║
║  HTTP 5xx     :  1                       ║
║  Errors       :  0                       ║
╚══════════════════════════════════════════╝
```

#### Task 12 — Configuration (`src/config.ts`)

Typed config object loaded from environment variables with defaults:

```ts
type Config = {
  seedUrl: string           // SEED_URL, default: 'https://ipfabric.io/'
  workerCount: number       // WORKER_COUNT, default: 5
  crawlDelayMs: number      // CRAWL_DELAY_MS, default: 1000
  requestTimeoutMs: number  // REQUEST_TIMEOUT_MS, default: 10_000
  maxDepth: number          // MAX_DEPTH, default: 10
  maxPages: number          // MAX_PAGES, default: 10_000
  maxResponseBytes: number  // MAX_RESPONSE_BYTES, default: 5_242_880 (5MB)
  stalledTimeoutMinutes: number  // STALLED_TIMEOUT_MINUTES, default: 5
  databaseUrl: string       // DATABASE_URL, required
  logLevel: string          // LOG_LEVEL, default: 'info'
}
```

Validates on startup — missing required vars log fatal + exit(1).

#### Task 13 — Logger (`src/utils/logger.ts`)

```ts
import pino from 'pino'
import { config } from '../config.js'

export const logger = pino({
  level: config.logLevel,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
})
```

All modules import this singleton. No `console.log` anywhere in the codebase.

Log levels used consistently:
- `fatal` — unrecoverable errors (DB down, bad config) → exit immediately
- `error` — fetch failed, parse failed, DB error on a single URL → log and continue
- `warn`  — robots.txt fetch failed, stalled rows requeued, redirect limit hit
- `info`  — crawl started/stopped, worker started/stopped, summary stats
- `debug` — per-URL activity (fetched, enqueued, skipped)

---

### Phase 6 — Validation

#### Task 14 — End-to-end smoke test

Run `docker compose up`, verify:
- Crawler starts, logs show workers beginning to fetch
- No crash loops or unhandled rejections in logs
- `url_frontier` table populated with discovered URLs, status transitions correctly
- No duplicate URLs in the table
- Summary report prints on completion
- `docker compose down` cleans up without errors

---

## Configuration Defaults

| Variable               | Default                  | Notes                                    |
|------------------------|--------------------------|------------------------------------------|
| `SEED_URL`             | `https://ipfabric.io/`   | Assignment requirement                   |
| `WORKER_COUNT`         | `5`                      | Polite for a single domain               |
| `CRAWL_DELAY_MS`       | `1000`                   | 1 second between fetches per domain      |
| `REQUEST_TIMEOUT_MS`   | `10000`                  | Abort slow responses                     |
| `MAX_DEPTH`            | `10`                     | Prevent runaway crawls                   |
| `MAX_PAGES`            | `10000`                  | Safety ceiling                           |
| `MAX_RESPONSE_BYTES`   | `5242880`                | 5 MB — skip huge pages                   |
| `STALLED_TIMEOUT_MIN`  | `5`                      | Requeue in-progress rows after 5 minutes |
| `LOG_LEVEL`            | `info`                   | `debug` for verbose per-URL logs         |

---

## Assumptions

1. Crawl is **scoped** to `ipfabric.io` and subdomains — external links are discovered but not followed
2. Crawl is **one-shot** — runs until the frontier is empty, then exits
3. **Static HTML only** — JavaScript-rendered content is not handled (no headless browser)
4. **Public content only** — no authentication, no login-gated pages
5. `robots.txt` is **respected** — if disallowed, URL is marked failed and skipped
6. Binary content (PDFs, images, JS, CSS) is fetched for status code recording but **not parsed** for URLs
7. **Content is not stored** beyond metadata — raw HTML is not persisted, only the URL record and content hash

## Known Limitations

- JavaScript-rendered navigation links are invisible to cheerio
- Crawl delay is applied per domain globally, not per IP or per worker
- robots.txt is cached for 24 hours; mid-crawl changes are not reflected immediately
- No retry logic for transient network errors (5xx, timeouts) — URLs are marked failed on first error
- No proxy or IP rotation — aggressive crawls may be rate-limited
- Re-crawl / incremental crawl not supported (see SCALING.md)
- `<meta name="robots" content="nofollow">` and `rel="nofollow"` link attributes are not respected — all links extracted regardless
- `content_hash` is stored for future dedup use but is not used to skip re-processing in this version
- Redirect target URL is not recorded separately — only the original (pre-redirect) URL appears in `url_frontier`; the redirect mapping is lost
