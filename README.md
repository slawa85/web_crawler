# Web Crawler

A distributed-ready web crawler seeded at `https://example.com/`, scoped to that domain and its subdomains. It fetches pages, extracts URLs, deduplicates them via PostgreSQL, and schedules further fetches until the frontier is exhausted. Prints a terminal summary on completion.

---

## Usage

### Option A — Docker (recommended, no local dependencies needed)

**1. Clone the repo and copy the env file**

```bash
git clone <repo-url>
cd web_crawler
cp .env.example .env
```

The defaults in `.env.example` work out of the box with Docker — no edits needed for a standard run.

**2. Start PostgreSQL and the crawler**

```bash
docker compose up
```

Docker will:
1. Pull `postgres:16-alpine` and start it with a health check
2. Build the crawler image (multi-stage TypeScript compile)
3. Wait for PostgreSQL to be healthy
4. Run schema migrations and insert the seed URL
5. Start crawling `https://example.com/`

You will see structured JSON logs in the terminal (one line per event). When the frontier is exhausted the crawler prints a summary box and exits.

**3. Stop and clean up**

```bash
docker compose down          # stop containers, keep the database volume
docker compose down -v       # stop containers AND delete all crawl data
```

**Customise the crawl without editing files:**

```bash
# Fewer workers, more verbose logs
WORKER_COUNT=2 LOG_LEVEL=debug docker compose up

# Raise the page ceiling
MAX_PAGES=50000 docker compose up

# Re-run a crawl from scratch (wipe previous data first)
docker compose down -v && docker compose up
```

---

### Option B — Local Node.js (requires Node 20+ and a running PostgreSQL)

**1. Install dependencies**

```bash
npm ci
```

**2. Set up the database**

If you do not have PostgreSQL running locally, the quickest way is to start just the database container:

```bash
docker compose up postgres
```

This starts PostgreSQL on `localhost:5432` with:
- User: `crawler`
- Password: `crawlerpass`
- Database: `crawlerdb`

**3. Configure environment**

```bash
cp .env.example .env
# .env is pre-filled with the correct DATABASE_URL for the Docker PostgreSQL above
# Edit any other values you want to change
```

**4. Run the crawler**

```bash
# Development — live reload, pretty-printed logs
npm run dev

# Production — compile then run
npm run build
npm start
```

**Available scripts:**

| Command | Description |
|---|---|
| `npm run dev` | Run with `tsx --watch` — auto-restarts on file changes, pretty logs |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled output (`node dist/index.js`) |

---

### Inspecting the Database

PostgreSQL is exposed on **`localhost:5432`** in both Docker and local setups. You can connect with any PostgreSQL client.

#### pgAdmin (GUI)

1. Download and install [pgAdmin 4](https://www.pgadmin.org/download/)
2. Open pgAdmin → right-click **Servers** → **Register > Server**
3. Fill in the connection details:

   | Field | Value |
   |---|---|
   | Name | `Crawler (local)` |
   | Host | `localhost` |
   | Port | `5432` |
   | Database | `crawlerdb` |
   | Username | `crawler` |
   | Password | `crawlerpass` |

4. Click **Save**. Expand the server tree: **Databases → crawlerdb → Schemas → public → Tables**

You will find two tables: `url_frontier` and `domain_info`.

## Configuration

All configuration is via environment variables. Every variable has a safe default — only `DATABASE_URL` is required.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `SEED_URL` | `https://example.com/` | Starting URL |
| `WORKER_COUNT` | `5` | Concurrent fetch workers |
| `CRAWL_DELAY_MS` | `1000` | Minimum milliseconds between fetches per domain |
| `REQUEST_TIMEOUT_MS` | `10000` | HTTP fetch timeout |
| `MAX_DEPTH` | `10` | Maximum link depth from seed |
| `MAX_PAGES` | `10000` | Hard ceiling on total URLs crawled |
| `MAX_RETRIES` | `3` | Retry attempts for transient errors (429, 5xx, network) |
| `MAX_RESPONSE_BYTES` | `5242880` | 5 MB response size cap |
| `STALLED_TIMEOUT_MINUTES` | `5` | Requeue `in_progress` rows older than this |
| `LOG_LEVEL` | `info` | `debug` for per-URL activity |

---

## Architecture

```
index.ts (orchestrator)
  ├── runMigrations() + seedUrl()
  ├── Spawn N workers (WORKER_COUNT, default 5)
  ├── Stalled-row requeue job (every 120s)
  └── Poll frontier stats every 5s → signal workers to stop when pending+in_progress=0

worker.ts loop (per worker):
  dequeueUrl() → ensureDomainInfo() → fetchUrl() → extractUrls() → enqueueUrls() → markDone/markFailed
```

### Source Layout

```
src/
  index.ts              # Entry point, orchestration, shutdown
  config.ts             # Typed config from env vars with range validation
  db/
    connection.ts       # postgres.js pool init/teardown
    migrate.ts          # Schema creation + seed URL insertion
    frontier.ts         # All frontier SQL: enqueue, dequeue, mark, stats
  crawler/
    worker.ts           # Worker loop
    fetcher.ts          # HTTP fetch (undici, timeout, size cap, redirect chain)
    parser.ts           # cheerio: extract a[href], link[canonical], link[alternate]
    normalizer.ts       # URL normalisation + in-scope filter
    politeness.ts       # robots.txt fetch/cache (24h TTL), crawl-delay enforcement
  utils/
    logger.ts           # Shared pino singleton
    summary.ts          # Terminal summary report
```

### Database Schema

Two tables — frontier and domain cache:

```sql
-- Queue + dedup + crawl log in one table
url_frontier (
  id            BIGSERIAL PRIMARY KEY,
  url           TEXT UNIQUE,         -- dedup via constraint
  domain        TEXT NOT NULL,       -- extracted at insert time (new URL().hostname)
  status        TEXT,                -- pending | in_progress | done | failed
  depth         INT,
  parent_url    TEXT,
  discovered_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,         -- stamped when dequeued; used for stall detection
  next_fetch_at TIMESTAMPTZ,         -- politeness: earliest next fetch time for this domain
  fetched_at    TIMESTAMPTZ,
  http_status   INT,
  content_hash  TEXT,                -- SHA-256 for future dedup
  error         TEXT,
  retry_count   INT                  -- transient failure retry counter (exponential backoff)
)

-- Partial index: only pending rows, supports domain-aware dequeue
CREATE INDEX idx_frontier_work ON url_frontier (domain, next_fetch_at)
  WHERE status = 'pending';

-- robots.txt cache per domain (24h TTL)
domain_info (domain, robots_txt, crawl_delay_ms, is_allowed, fetched_at)
```

---

## Design Decisions and Rationale

### Why PostgreSQL as the frontier store (not Redis or Kafka)?

The core requirement was a system that is **correct under concurrent workers** and **easy to run with a single `docker compose up`**. PostgreSQL satisfies both.

The key primitive is `SELECT FOR UPDATE SKIP LOCKED` (enhanced in this implementation with `pg_try_advisory_xact_lock`). This gives the crawler:

- **Atomic dequeue**: a single `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...` statement atomically claims a URL. No race condition, no two workers ever fetching the same URL.
- **Built-in deduplication**: the `UNIQUE` constraint on `url` makes `INSERT ... ON CONFLICT DO NOTHING` the entire dedup mechanism — no separate cache needed.
- **Durability**: if a worker crashes mid-fetch, the URL stays `in_progress`. The stalled-row requeue job detects rows older than 5 minutes and resets them to `pending`, guaranteeing eventual completeness.
- **Observability**: standard SQL queries give instant visibility into frontier depth, per-status counts, HTTP breakdowns.

A Redis-based frontier would be faster but loses durability (data is in-memory) and requires a separate dedup store. A Kafka-based frontier provides better throughput at scale but is operationally heavier and does not support `SKIP LOCKED`-style atomic dequeue natively.

**Trade-off accepted**: PostgreSQL becomes a bottleneck at very high worker counts (hundreds of nodes). This is documented in SCALING.md.

### Why `pg_try_advisory_xact_lock` for per-domain concurrency?

The naive domain guard (`AND domain NOT IN (SELECT domain ... WHERE status = 'in_progress')`) has a TOCTOU race: two workers can both evaluate the subquery before either commits, and both pick a URL from the same domain.

`pg_try_advisory_xact_lock(hashtext(domain))` is evaluated inside the `FOR UPDATE SKIP LOCKED` subquery. If another transaction already holds the advisory lock for that domain's hash, `pg_try_advisory_xact_lock` returns `false` and the row is skipped — atomically, with no gap between check and claim. The lock is transaction-scoped and released automatically when the `UPDATE` commits.

This enforces the invariant: **at most one worker is fetching from a given domain at any moment**, which is the foundation of polite crawling.

### Why raw SQL with postgres.js (no ORM)?

The frontier's key operations are not expressible in mainstream ORMs:

- `SELECT FOR UPDATE SKIP LOCKED` — Sequelize, Prisma, TypeORM all lack direct support
- `INSERT ... ON CONFLICT DO NOTHING RETURNING id` — partial support in some ORMs but unreliable
- `pg_try_advisory_xact_lock` inside a subquery — no ORM supports this

postgres.js tagged-template literals give full SQL expressiveness with TypeScript type safety and parameterized queries (no SQL injection risk). The schema is simple enough that an ORM's migration system adds no value.

### Why undici for HTTP?

undici is the HTTP client underlying Node.js's `fetch` built-in. Using it directly gives:

- Connection pooling per origin (no per-request TCP handshake overhead)
- `AbortSignal.timeout()` for clean request timeouts
- Streaming response body (avoids buffering huge responses before the size check)
- No extra dependency weight (it ships with Node 20)

### Why cheerio for HTML parsing?

cheerio loads malformed HTML without throwing, which matters for crawling the real web. Its jQuery-like selector API (`$('a[href]')`) is concise. It does not execute JavaScript, which is intentional — this crawler targets static HTML only.

### Why PostgreSQL advisory locks over application-level locks?

Application-level locks (a `Set<string>` of in-progress domains in the orchestrator) only work in a single-process deployment. PostgreSQL advisory locks work across multiple independent processes on different machines connecting to the same database — which is exactly the multi-node deployment target.

### Termination design

The termination condition is: `pending + inProgress === 0` in the database, polled every 5 seconds.

The DB's `inProgress` count is the authoritative signal that a worker is mid-cycle. A URL transitions to `in_progress` at dequeue and to `done`/`failed` only after all child URLs have been enqueued. So when `inProgress === 0`, no worker is about to add new `pending` rows. The `pending === 0` check then confirms the frontier is truly exhausted.

An earlier implementation also required an in-process `activeWorkers.count === 0` check, but this caused a livelock: workers keep the counter elevated during idle sleep, so the condition never fired when the frontier was empty. The fix was to rely solely on the DB count, which is authoritative.

---

## Assumptions

1. **Scoped crawl** — only `https://example.com/` and `*.example.com` are followed; external links are discovered but discarded.
2. **One-shot** — runs until the frontier is exhausted, then exits. No incremental re-crawl.
3. **Static HTML only** — JavaScript-rendered content is invisible to cheerio; no headless browser.
4. **Public content only** — no authentication, cookies, or login-gated pages.
5. **robots.txt respected** — disallowed URLs are marked `failed` and skipped.
6. **Content not stored** — raw HTML is not persisted; only URL metadata and a SHA-256 content hash.
7. **Single database** — all workers share one PostgreSQL instance; no distributed coordination layer.

---

## Known Limitations and Weaknesses

### Structural limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| JavaScript-rendered content invisible | Pages built with React/Vue/Angular may have no links in their HTML source | Headless browser pool (see SCALING.md) |
| `maxPages` is a soft limit | Concurrent workers can all pass the count check before any inserts, slightly overshooting the ceiling | Acceptable for a soft safety guard; use advisory lock or serializable isolation for strict enforcement |
| `robots.txt` cached 24h | Mid-crawl policy changes are not reflected | Configurable TTL; default is reasonable for a one-shot crawl |
| No `rel="nofollow"` respect | Links marked nofollow are still followed | Filter in parser |
| Redirect target not deduplicated | `https://example.com/` and `https://example.com/` (after redirect) can both appear as separate entries | Normalize canonical URL after redirect chain resolves |
| No proxy / IP rotation | Aggressive crawl may be rate-limited | Proxy pool (see SCALING.md) |
| Per-domain politeness is domain-wide | All workers collectively respect the delay, but a single worker could still issue requests faster than `crawlDelayMs` if `next_fetch_at` is not updated atomically before the next dequeue | `updateNextFetch` advances `next_fetch_at` immediately after each fetch |

### Scalability ceiling

The PostgreSQL frontier becomes a bottleneck above ~50 concurrent workers due to lock contention on `url_frontier`. At that scale, the architecture needs to evolve toward a message queue frontier (see SCALING.md).

---

## Strengths

- **Correctness under concurrency**: the `pg_try_advisory_xact_lock` dequeue is race-free; deduplication is implicit and atomic.
- **Durability**: stalled-row recovery guarantees completeness even if workers crash.
- **Operational simplicity**: one `docker compose up` command, one dependency (PostgreSQL).
- **Observability**: full crawl history is queryable SQL; HTTP breakdowns, depth stats, error messages all in one table.
- **Polite by design**: per-domain crawl delay enforced in the dequeue query itself, not just the application layer.
- **Resilient**: transient failures (429, 5xx, network errors) are retried with exponential backoff; only permanently failing URLs are marked `failed`.
- **Graceful shutdown**: SIGINT/SIGTERM drains in-flight fetches before exiting.

---

## Output

On completion, the crawler prints a summary to the terminal:

```
╔══════════════════════════════════════════╗
║             CRAWL COMPLETE               ║
╠══════════════════════════════════════════╣
║  Seed URL     : https://example.com/     ║
║  Duration     : 2m 14s                   ║
╠══════════════════════════════════════════╣
║  Pages fetched    :  312                 ║
║  URLs discovered  :  489                 ║
║  Depth reached    :  4                   ║
╠══════════════════════════════════════════╣
║  HTTP 2xx     :  304                     ║
║  HTTP 3xx     :  5                       ║
║  HTTP 4xx     :  7                       ║
║  HTTP 429     :  0                       ║
║  HTTP 5xx     :  1                       ║
║  Errors       :  0                       ║
╚══════════════════════════════════════════╝
```

Structured JSON logs are emitted throughout (pino). Set `LOG_LEVEL=debug` for per-URL activity.

---

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 20), strict mode | Type safety, `noUncheckedIndexedAccess`, ES2022 |
| HTTP | `undici` | Node-native, connection pooling, streaming |
| HTML parsing | `cheerio` | Lenient on malformed HTML, no JS execution |
| robots.txt | `robots-parser` | Spec-compliant, lightweight |
| DB client | `postgres.js` | Tagged-template raw SQL, native BigInt, no ORM |
| Database | PostgreSQL 16 | `SKIP LOCKED`, advisory locks, ACID dedup |
| Logger | `pino` (JSON) + `pino-pretty` dev | Structured, low overhead |
| Container | Docker multi-stage + Compose | One-command reproducible environment |
