# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
A crawler at its core downloads URLs, discovers new URLs in the downloaded content, and schedules download of new discovered URLs.
Example:
	•	Fetch the content of a discovered URL
	•	Discover any new URLs by extracting them from the fetched content
	•	Crawl any new URLs
	•	Seed the crawler with https://ipfabric.io/ as the start URL (first
	•	discovered URL)
State your assumptions and limitations of your solution. Evaluate the weaknesses of this solution. Suggestions for future improvements of your crawler is a plus. How it might be scaled to run on a large grid of machines.
Please design a solution that can run on multiple nodes, ensures a complete scan (when compared to single node/thread solution). Focus on horizontal scalability.

A distributed-ready web crawler seeded at `https://ipfabric.io/`, scoped to that domain and its subdomains. It fetches pages, extracts URLs, deduplicates them via PostgreSQL, and schedules further fetches until the frontier is exhausted. Prints a terminal summary on completion.

**This project is in the specification phase.** PLAN.md contains the full implementation spec. No source code exists yet.

## Commands

Once scaffolded (Task 1 of PLAN.md):

```bash
npm run dev        # Run with tsx watch (development)
npm run build      # Compile TypeScript with tsc
npm start          # Run compiled output: node dist/index.js

docker compose up  # Start PostgreSQL + crawler (full end-to-end)
docker compose down
```

**Required env var**: `DATABASE_URL` (all others have defaults — see `src/config.ts` or PLAN.md).

## Tech Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (Node 20), strict mode, `noUncheckedIndexedAccess`, ES2022 target |
| HTTP | `undici` — no extra deps, connection pooling |
| HTML parsing | `cheerio` — lenient on malformed HTML |
| robots.txt | `robots-parser` |
| DB client | `postgres.js` — tagged-template raw SQL, no ORM |
| Database | PostgreSQL 16 — frontier + dedup in one store |
| Logger | `pino` (JSON) + `pino-pretty` in dev; no `console.log` anywhere |
| Container | Docker multi-stage build + Compose |

No ORM — the frontier uses `SELECT FOR UPDATE SKIP LOCKED` and `INSERT ... ON CONFLICT DO NOTHING` which mainstream ORMs don't support cleanly.

## Architecture

```
index.ts (orchestrator)
  ├── runMigrations() + seedUrl()
  ├── Spawn N workers (default 5, WORKER_COUNT env)
  ├── Stalled-row requeue job (every 60s)
  └── Poll frontier stats every 5s → signal workers to stop when pending+in_progress=0

worker.ts loop:
  dequeueUrl() → ensureDomainInfo() → fetchUrl() → extractUrls() → enqueueUrls() → markDone/markFailed
```

### Source Layout (to be created)

```
src/
  index.ts              # Entry point, orchestration, shutdown
  config.ts             # Typed config from env vars
  db/
    connection.ts       # postgres.js pool init/teardown
    migrate.ts          # Schema creation + seed URL
    frontier.ts         # All frontier SQL: enqueue, dequeue, mark, stats
  crawler/
    worker.ts           # Worker loop
    fetcher.ts          # HTTP fetch (undici, 10s timeout, 5MB cap, redirect chain)
    parser.ts           # cheerio: extract a[href], link[canonical], link[alternate]
    normalizer.ts       # URL normalisation + in-scope filter (ipfabric.io + subdomains)
    politeness.ts       # robots.txt fetch/cache (24h TTL), crawl-delay enforcement
  utils/
    logger.ts           # Shared pino singleton
    summary.ts          # Terminal summary report
```

### Database Schema

**`url_frontier`** — queue + dedup + crawl log in one table:
- `url TEXT UNIQUE` — dedup via constraint
- `status TEXT` — `pending | in_progress | done | failed`
- `next_fetch_at TIMESTAMPTZ` — politeness delay per domain
- Partial index on `(next_fetch_at, domain) WHERE status = 'pending'`

**`domain_info`** — robots.txt cache + per-domain crawl delay (cached 24h)

### Key Behaviours

- Workers use `SELECT FOR UPDATE SKIP LOCKED` for safe concurrent dequeuing
- URL dedup is implicit via `INSERT ... ON CONFLICT DO NOTHING`
- Scope: `http(s)://ipfabric.io` and `*.ipfabric.io` only
- Spider trap detection: path depth > 15 or repeated path segments → discard
- Stalled rows (`in_progress` for > 5 min) requeued automatically
- Graceful shutdown on SIGINT/SIGTERM: 30s drain window, then force-exit(1)

### Configuration Defaults

| Variable | Default |
|---|---|
| `SEED_URL` | `https://ipfabric.io/` |
| `WORKER_COUNT` | `5` |
| `CRAWL_DELAY_MS` | `1000` |
| `REQUEST_TIMEOUT_MS` | `10000` |
| `MAX_DEPTH` | `10` |
| `MAX_PAGES` | `10000` |
| `MAX_RESPONSE_BYTES` | `5242880` (5 MB) |
| `STALLED_TIMEOUT_MINUTES` | `5` |
| `LOG_LEVEL` | `info` |

## Logging Conventions

- `fatal` — unrecoverable (DB down, bad config) → exit immediately
- `error` — single-URL failures (fetch, parse, DB) → log and continue
- `warn` — robots.txt fetch failed, stalled rows requeued, redirect limit hit
- `info` — crawl start/stop, worker lifecycle, summary stats
- `debug` — per-URL activity (fetched, enqueued, skipped)
