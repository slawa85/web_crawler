# Scaling the Crawler: From Single Node to Grid

This document describes the path from the current single-PostgreSQL implementation to a crawler capable of running on hundreds or thousands of machines. It is organized by scale tier so you can stop at the right level for your requirements.

---

## Current Architecture and Its Ceiling

The current implementation uses PostgreSQL as the frontier store. Workers dequeue via `SELECT FOR UPDATE SKIP LOCKED` with `pg_try_advisory_xact_lock` for per-domain isolation. This design is operationally simple — but it has a hard ceiling:

- **~20–50 workers** before lock contention on `url_frontier` degrades throughput
- **Single region** — no geo-distribution
- **Single database** — if it goes down, the entire crawl stops
- **No JS rendering** — JavaScript-heavy sites are partially crawled at best

The sections below describe what must change at each scale tier.

---

## Tier 1: 5–50 Workers (Current Design, Tuned)

No architectural changes needed. Optimize the existing system:

### Tuning the connection pool

```
max: workerCount + 5   (already implemented)
```

Each worker holds one connection during dequeue (a transaction) and one for each of `markDone`, `updateNextFetch`. Five extra connections cover the stalled-row job, termination poll, and summary query.

### Retry logic for transient errors and rate-limiting (implemented)

Transient failures (HTTP 429, 5xx, network errors) are retried with exponential backoff. The `retry_count` column in `url_frontier` tracks attempts per URL, and `next_fetch_at` is pushed into the future by 5s, 15s, 45s (capped at 60s) on successive retries. After `MAX_RETRIES` (default 3) exhausted attempts, the URL is marked `failed` with the HTTP status preserved. The summary report warns if >10% of processed URLs returned HTTP 429.

### `rel="nofollow"` and `<meta name="robots">` enforcement

Currently all extracted links are followed regardless of nofollow hints. Add parser support to discard links marked `rel="nofollow"` and skip parsing entirely if `<meta name="robots" content="noindex,nofollow">` is present.

---

## Tier 2: 50–500 Workers (Multi-Node, Shared PostgreSQL)

At this scale, multiple crawler processes run on different machines, all connecting to a single PostgreSQL instance. The frontier design still works — `SKIP LOCKED` and advisory locks are multi-process safe. The bottleneck shifts to database throughput.

### Replace the single-table frontier with a partitioned table

Partition `url_frontier` by domain hash. Each partition has its own index, reducing contention.
Workers are assigned to partition ranges by the coordinator (see below), so each worker's dequeue query scans only its assigned partitions. Lock contention drops by the partition count.

### Read replica for stats and monitoring

The termination poll (`getFrontierStats`) and summary report only need to read. Route these to a read replica. This keeps the primary's IOPS free for dequeue/enqueue writes.

```
postgres primary  ← dequeue / enqueue / mark
postgres replica  ← getFrontierStats / monitoring queries
```

### Dedicated coordinator process

A single coordinator process (not a worker) is responsible for:

- Monitoring frontier depth and queue lengths per partition
- Assigning partitions to worker groups
- Detecting dead workers (no heartbeat in 30s) and triggering stalled-row requeue immediately (rather than waiting for the 2-minute interval)
- Exposing a simple HTTP API for progress queries and manual controls (pause, requeue)

The coordinator holds no crawl state itself — all state is in PostgreSQL. It can be restarted at any time without losing progress.

### Worker discovery and assignment

Workers register with the coordinator on startup (via a simple `worker_nodes` table or a lightweight service registry like Consul). The coordinator assigns each worker a set of domain-hash ranges. Workers only dequeue URLs from their assigned range, eliminating cross-worker lock contention entirely.

---

## Tier 3: 500–5000 Workers (Message Queue Frontier)

At this scale, a relational database can no longer serve as the frontier. The write throughput of `enqueueUrls` (many workers inserting hundreds of URLs per second) and the dequeue contention exceed what PostgreSQL can handle cost-effectively.

### Replace PostgreSQL frontier with Apache Kafka

The frontier becomes a set of Kafka topics, partitioned by domain hash. Each crawler worker is a Kafka consumer assigned to one or more partitions. Dequeue is simply, no locks, no contention.

**Why Kafka specifically:**
- Partitioned consumption gives each worker a guaranteed slice of work
- Consumer group rebalancing handles worker failures automatically
- Log compaction can be used to deduplicate recently-seen URLs within the queue
- Replay is possible: replay the topic from offset 0 to re-crawl everything

### Deduplication store

Removing the `UNIQUE` constraint means dedup moves to a dedicated store. Two-tier approach:

**Tier 1 — Bloom filter (in-process)**
Each worker maintains a local Bloom filter (target false-positive rate: 0.1%). Before producing to Kafka, check the Bloom filter. Most duplicates are caught here with zero network cost.

```
Expected: 10M URLs → Bloom filter ≈ 14MB RAM, ~7 hash functions
False positive rate at 10M items: ~0.1% → ~10,000 extra fetches accepted
```

**Tier 2 — Distributed exact dedup Redis**
URLs that pass the Bloom filter are checked against a distributed set. Use `SET url 1 NX EX 86400` in Redis (set-if-not-exists with 24h expiry). If already set, discard. If not set, produce to Kafka.

At 100M+ URLs, shard Redis by URL hash across 10+ instances.

### Storage for crawl results

At this scale, storing results in PostgreSQL is not viable. Split storage:

- **Metadata** (URL, status, http_status, depth, timestamps, content_hash): PostgreSQL or Cassandra, sharded by domain hash
- **Extracted links**: produced back to Kafka for further crawling

---

## Tier 4: 5000+ Workers (Geo-Distributed Grid)

At this tier, a single region cannot provide sufficient network throughput or avoid detection/rate-limiting. The crawler becomes a geographically distributed system.

### Regional crawler clusters

Deploy crawler clusters in multiple regions (us-east, eu-west, ap-southeast). Each region has:

- Its own Kafka cluster (frontier topics)
- Its own worker fleet
- Its own Redis dedup shard
- Its own S3/GCS bucket for raw content

Domains are assigned to regions based on the geographic location of their servers (use IP geolocation of the resolved DNS). This reduces latency and respects per-IP rate limits more gracefully.

### Cross-region dedup synchronization

The per-region Bloom filters and Redis shards must be synchronized to prevent the same URL being fetched twice across regions. Two approaches:

**Eventual consistency (recommended)**
Allow a short window (minutes to hours) of cross-region duplicates. The overhead is bounded: a URL can be fetched at most once per region before dedup catches it locally. For a crawl of 1B URLs across 5 regions, this means at most ~5B fetches in the worst case — acceptable if duplicate work is bounded.

**Strict consistency**
Use a single global dedup store (e.g., a globally replicated ScyllaDB cluster). Adds ~50ms latency to every dedup check but guarantees exact-once. Only justified if fetching duplicates is truly unacceptable (billing, legal, ethical reasons).

### Kafka MirrorMaker 2 for cross-region frontier sync

Discovered URLs from one region that belong to another region's assigned domain set are forwarded via Kafka MirrorMaker 2:

```
us-east cluster  --MirrorMaker2-->  eu-west cluster (for EU-hosted domains)
eu-west cluster  --MirrorMaker2-->  ap-southeast cluster (for APAC domains)
```

### Crawl coordinator cluster

At this scale the coordinator itself must be highly available. Replace the single coordinator process with a replicated state machine:

- **etcd or ZooKeeper** for distributed lock and leader election
- **Leader** handles partition assignment, failure detection, rebalancing
- **Followers** take over immediately if the leader fails
- REST API (read from any replica, writes go to leader)

---

## Features Required for a Production-Grade Crawler

### JavaScript / SPA Support

Static HTML crawling misses content rendered by React, Vue, Angular, and similar frameworks. A headless browser tier is required for these sites.

**Architecture:**
- Router logic identifies SPA candidates: no `<a href>` links in HTML source despite a non-trivial page, or site is known to use client-side routing.
- SPA URLs are forwarded to a separate **headless browser pool** (Puppeteer / Playwright / Chrome CDP).
- Headless workers are resource-intensive (~100–200MB RAM per instance, 2–5s per page vs 50–200ms for plain HTTP). Size the pool to ~10% of total worker count for typical crawls.
- After JavaScript execution, the rendered DOM is passed to the same `extractUrls` parser.

### Incremental Re-crawl

The current crawler is one-shot. A production crawler re-visits pages to detect changes.

**Required additions:**
- `last_crawl_at TIMESTAMPTZ` and `change_frequency TEXT` per URL
- HTTP `If-Modified-Since` and `ETag` conditional request headers — skip re-processing unchanged content
- Change detection: compare `content_hash` across crawls; if unchanged, skip re-parsing links
- Re-crawl scheduling: priority queue ordered by `last_crawl_at + estimated_change_interval`
- Versioned storage: keep N historical snapshots per URL (or store diffs)

### IP Rotation and Proxy Pool

Without IP rotation, an aggressive crawl from a single IP will be rate-limited or blocked by most CDNs and WAFs.

**Required additions:**
- Proxy pool manager: list of rotating proxies (residential, datacenter), health-checked, retired on repeated failures
- Per-domain sticky assignment: same domain always routes through the same proxy to respect per-IP rate limits
- Exponential backoff on `429 Too Many Requests` and `503 Service Unavailable` — back off the domain, not just the URL
- User-Agent rotation (pool of realistic browser user agents, rotated per domain)

### Sitemap Parsing

`/sitemap.xml` and `/sitemap_index.xml` provide direct URL inventories for many sites. Parsing sitemaps at crawl start can reduce time-to-complete by seeding the frontier with known URLs directly.

**Required additions:**
- On first visit to a domain, attempt to fetch `/robots.txt` → extract `Sitemap:` directives → fetch and parse sitemaps
- Support `<sitemap>` index files (recursive sitemap trees)
- Insert sitemap URLs into the frontier with `depth: 0` (they are authoritative, not link-depth discoveries)

## Scaling Roadmap

| Scale | Workers | Key Changes | Critical Bottleneck |
|---|---|---|---|
| **Tier 1** | 1–50 | Current PostgreSQL design, tuned indexes, retry logic | DB lock contention |
| **Tier 2** | 50–500 | Partitioned `url_frontier`, read replica, coordinator process | DB write throughput |
| **Tier 3** | 500–5,000 | Kafka frontier, two-tier dedup (Bloom + Redis), S3 for content | Dedup store QPS |
| **Tier 4** | 5,000–50,000 | Geo-distributed clusters, MirrorMaker 2, coordinator HA |
