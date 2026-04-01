# Scaling the Crawler: From Single Node to Grid

This document describes the path from the current single-PostgreSQL implementation to a crawler capable of running on hundreds or thousands of machines. It is organized by scale tier so you can stop at the right level for your requirements.

---

## Current Architecture and Its Ceiling

The current implementation uses PostgreSQL as the frontier store. Workers dequeue via `SELECT FOR UPDATE SKIP LOCKED` with `pg_try_advisory_xact_lock` for per-domain isolation. This design is correct, durable, and operationally simple — but it has a hard ceiling:

- **~20–50 workers** before lock contention on `url_frontier` degrades throughput
- **Single region** — no geo-distribution
- **Single database** — if it goes down, the entire crawl stops
- **No JS rendering** — JavaScript-heavy sites are partially crawled at best
- **No rate-limit recovery** — URLs returning HTTP 429 are marked `failed` without backoff. This is not a problem for small crawls, but production crawlers should implement exponential retry (see Tier 1 improvements below)

The sections below describe what must change at each scale tier.

---

## Tier 1: 5–50 Workers (Current Design, Tuned)

No architectural changes needed. Optimize the existing system:

### Tuning the connection pool

```
max: workerCount + 5   (already implemented)
```

Each worker holds one connection during dequeue (a transaction) and one for each of `markDone`, `updateNextFetch`. Five extra connections cover the stalled-row job, termination poll, and summary query.

### Index maintenance

The partial indexes on `url_frontier` carry the query load:

```sql
-- Dequeue: find pending rows for domains not currently in-progress
CREATE INDEX idx_frontier_work ON url_frontier (domain, next_fetch_at)
  WHERE status = 'pending';

-- Advisory lock guard: quickly find in-progress domains
CREATE INDEX idx_frontier_in_progress_domain ON url_frontier (domain)
  WHERE status = 'in_progress';
```

Run `VACUUM ANALYZE url_frontier` periodically if the crawl is long-running (the status column changes often, creating dead tuples).

### Retry logic for transient errors and rate-limiting

**Current behavior:** URLs are marked `failed` on the first error (5xx, timeout, 429). No backoff or retry.

**Enhancement:** Add retry support for transient failures:

1. **Schema change**: add columns to `url_frontier`:
   ```sql
   ALTER TABLE url_frontier
     ADD COLUMN retry_count INT DEFAULT 0,
     ADD COLUMN next_retry_at TIMESTAMPTZ;
   ```

2. **Worker logic**: in the catch block after `fetchUrl()`:
   ```ts
   if (result.error || (result.status >= 500 && result.status < 600) || result.status === 429) {
     const retryCount = url.retryCount ?? 0
     if (retryCount < 3) {
       // Exponential backoff: 10s, 100s, 1000s
       const backoffMs = Math.pow(10, retryCount + 1) * 1000
       await sql`
         UPDATE url_frontier
         SET status = 'pending',
             retry_count = ${retryCount + 1},
             next_fetch_at = now() + ${backoffMs}ms
         WHERE id = ${url.id}
       `
       continue  // Don't mark failed; retry later
     } else {
       // Max retries exceeded
       await markFailed(url.id, `${result.error} (after 3 retries)`)
     }
   }
   ```

3. **Detect rate-limiting**: in the summary report, if `http_status = 429` appears for >10% of URLs, log a warning:
   ```
   WARN: 42 URLs returned HTTP 429 (rate limited). Consider increasing CRAWL_DELAY_MS
   ```

   This gives visibility into whether the crawler is being rate-limited, so the operator can reduce parallelism or increase delays for future runs.

### `rel="nofollow"` and `<meta name="robots">` enforcement

Currently all extracted links are followed regardless of nofollow hints. Add parser support to discard links marked `rel="nofollow"` and skip parsing entirely if `<meta name="robots" content="noindex,nofollow">` is present.

---

## Tier 2: 50–500 Workers (Multi-Node, Shared PostgreSQL)

At this scale, multiple crawler processes run on different machines, all connecting to a single PostgreSQL instance. The frontier design still works — `SKIP LOCKED` and advisory locks are multi-process safe. The bottleneck shifts to database throughput.

### Replace the single-table frontier with a partitioned table

Partition `url_frontier` by domain hash. Each partition has its own index, reducing contention:

```sql
CREATE TABLE url_frontier (
  id          BIGSERIAL,
  url         TEXT NOT NULL,
  domain      TEXT NOT NULL,
  ...
) PARTITION BY HASH (domain);

CREATE TABLE url_frontier_0 PARTITION OF url_frontier
  FOR VALUES WITH (MODULUS 16, REMAINDER 0);
-- ... 15 more partitions
```

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

The frontier becomes a set of Kafka topics, partitioned by domain hash:

```
Topic: crawler.frontier
  Partition 0: domains where hash(domain) % N == 0
  Partition 1: ...
  Partition N: ...
```

Each crawler worker is a Kafka consumer assigned to one or more partitions. Dequeue is simply `consumer.poll()` — no locks, no contention.

**Why Kafka specifically:**
- Partitioned consumption gives each worker a guaranteed slice of work
- Consumer group rebalancing handles worker failures automatically
- Log compaction can be used to deduplicate recently-seen URLs within the queue
- Replay is possible: replay the topic from offset 0 to re-crawl everything

**What changes in the architecture:**

| Current | Kafka-based |
|---|---|
| `enqueueUrls()` → INSERT INTO url_frontier | `producer.send({ topic: 'crawler.frontier', partition: hash(domain) % N, value: urlJson })` |
| `dequeueUrl()` → SELECT FOR UPDATE SKIP LOCKED | `consumer.poll()` |
| Dedup via UNIQUE constraint | Separate dedup store (see below) |
| Status tracking in url_frontier | Separate results store (S3 + metadata DB) |

### Deduplication store

Removing the `UNIQUE` constraint means dedup moves to a dedicated store. Two-tier approach:

**Tier 1 — Bloom filter (in-process)**
Each worker maintains a local Bloom filter (target false-positive rate: 0.1%). Before producing to Kafka, check the Bloom filter. Most duplicates are caught here with zero network cost.

```
Expected: 10M URLs → Bloom filter ≈ 14MB RAM, ~7 hash functions
False positive rate at 10M items: ~0.1% → ~10,000 extra fetches accepted
```

**Tier 2 — Distributed exact dedup (Redis or ScyllaDB)**
URLs that pass the Bloom filter are checked against a distributed set. Use `SET url 1 NX EX 86400` in Redis (set-if-not-exists with 24h expiry). If already set, discard. If not set, produce to Kafka.

At 100M+ URLs, shard Redis by URL hash across 10+ instances. Or replace Redis with ScyllaDB (Cassandra-compatible) for persistence and horizontal scale.

**Tier 3 — Persistent canonical store**
For multi-crawl dedup (across separate crawl sessions), maintain a persistent HBase or BigTable table keyed by URL SHA-256 hash. Used for incremental re-crawl decisions.

### Storage for crawl results

At this scale, storing results in PostgreSQL is not viable. Split storage:

- **Metadata** (URL, status, http_status, depth, timestamps, content_hash): PostgreSQL or Cassandra, sharded by domain hash
- **Raw HTML content**: S3 / MinIO / GCS, keyed by `sha256(url)`. Workers stream directly to object storage.
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

## Bottleneck Analysis by Scale

### Bottleneck 1: Deduplication Store (Redis) at High QPS

**Emerges at:** 10k+ fetches/sec (millions of Redis QPS)

Every URL discovery event hits the dedup store. At 10k pages/sec with an average of 50 links per page, that is 500k dedup checks per second.

**Solutions in order of complexity:**
1. Redis Cluster (horizontal sharding) — handles ~1M QPS across 10 nodes
2. RedisBloom module — probabilistic structure, 10–100x fewer lookups than exact set
3. Multi-tier: in-process Bloom → Redis Bloom → ScyllaDB for persistent exact dedup

### Bottleneck 2: Domain Skew (Hot Partitions)

**Emerges at:** Large domains dominating the frontier (e.g., a 10M-page wiki subdomain)

When one domain has millions of URLs and thousands of subpages, it saturates its assigned Kafka partition while other partitions sit idle.

**Solutions:**
1. **Sub-domain partitioning**: partition by `hash(domain + path_prefix[:2])` instead of just `hash(domain)`. Allows parallel workers on the same domain.
2. **Dynamic partition splitting**: the coordinator monitors per-partition lag. If a partition grows above a threshold, it splits it and reassigns workers.
3. **Work stealing**: idle workers pull from the tail of overloaded partitions with a configurable backpressure mechanism.

### Bottleneck 3: DNS Resolution

**Emerges at:** Many unique domains, cache miss rate > 10%

Each new domain requires a DNS resolution before the first fetch. At 50k unique domains/day, DNS resolver round-trips add up.

**Solutions:**
1. Local DNS cache per worker (LRU, 60s TTL) — eliminates repeat lookups to the same domain
2. Shared DNS cache in Redis (domain → IP, 300s TTL)
3. Dedicated DNS resolver fleet (dnsmasq, bind9 with large cache)
4. Async DNS client library to avoid blocking worker threads during resolution

### Bottleneck 4: robots.txt Fetch Spike

**Emerges at:** Many new domains discovered in a short burst

When 10k new domains are discovered simultaneously, 10k robots.txt fetches spike the network. Politeness checks are blocked until each fetch completes.

**Solutions:**
1. **Robots.txt prefetch pool**: a dedicated worker group that proactively fetches robots.txt for domains visible in the frontier before they reach the main crawl queue.
2. **Optimistic start**: begin crawling the first URL of a new domain immediately (before robots.txt is fetched). Fetch robots.txt asynchronously. If robots.txt arrives and disallows the URL, mark it failed retrospectively. This trades a small number of unauthorized fetches for lower latency.
3. **Robots.txt cache sharding**: distribute the `domain_info` table across multiple database instances by domain hash.

### Bottleneck 5: Storage Write Throughput

**Emerges at:** 5k+ pages/sec

Writing raw HTML to object storage and metadata to the database becomes the critical path.

**Solutions:**
1. **Write buffering**: workers batch 50–100 pages in memory before flushing to S3/database in a single multi-part upload or bulk INSERT.
2. **Async writes**: acknowledge the fetch as complete to Kafka before the storage write commits. Use a write-ahead log (WAL) to ensure durability without blocking the worker.
3. **Storage sharding**: multiple S3 buckets (or MinIO instances), selected by `hash(url) % bucket_count`. Distributes IOPS across buckets and avoids S3 request rate limits per bucket.
4. **Tiered storage**: hot storage (recent crawl, fast SSD) → warm storage (S3 Standard) → cold storage (Glacier). Automate tier transitions via S3 lifecycle policies.

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

### Duplicate Content Detection

Different URLs often serve the same or near-identical content (pagination, session tokens, mirrors).

**Required additions:**
- Compute SimHash or MinHash of page content on fetch
- Distributed similarity index (LSH — Locality Sensitive Hashing) to find near-duplicates across all crawled pages
- Mark near-duplicates as `duplicate_of: url` rather than crawling their outbound links separately

### Monitoring and Control Plane

**Metrics (Prometheus export):**
- `crawler_urls_per_second` — throughput
- `crawler_frontier_depth{status}` — queue depth by status
- `crawler_worker_idle_count` — idle workers (signals frontier exhaustion or domain bottleneck)
- `crawler_domain_in_progress` — unique domains currently being crawled
- `crawler_errors_total{type}` — error rate by type (network, DNS, timeout, robots)

**Alerting thresholds:**
- All workers idle for > 60s with `pending > 0` → stall alert
- Error rate > 20% over 5 minutes → network/target issue alert
- Frontier depth growing faster than throughput → capacity alert

**Control plane API:**
- `GET /status` — current stats, worker count, frontier depth
- `POST /pause` / `POST /resume` — pause/resume all workers
- `POST /requeue?domain=x` — immediately requeue all failed URLs for a domain
- `POST /scope` — add a domain to the in-scope list at runtime

---

## Scaling Roadmap

| Scale | Workers | Key Changes | Critical Bottleneck |
|---|---|---|---|
| **Tier 1** | 1–50 | Current PostgreSQL design, tuned indexes, retry logic | DB lock contention |
| **Tier 2** | 50–500 | Partitioned `url_frontier`, read replica, coordinator process | DB write throughput |
| **Tier 3** | 500–5,000 | Kafka frontier, two-tier dedup (Bloom + Redis), S3 for content | Dedup store QPS |
| **Tier 4** | 5,000–50,000 | Geo-distributed clusters, MirrorMaker 2, coordinator HA | Cross-region coordination |
| **Tier 5** | 50,000+ | Custom distributed dedup (ScyllaDB/HBase), sub-domain partitioning, DNS fleet | Network egress, coordinator scale |

---

## Open Architecture Questions

**Consistency model: at-least-once vs exactly-once**
Exactly-once delivery (each URL fetched exactly once across all workers and crawl sessions) requires a globally consistent dedup store with strong consistency guarantees. This adds latency and complexity. At-least-once (occasional duplicates tolerated) is significantly simpler and faster. Most web crawlers choose at-least-once with bounded duplicate rate.

**Freshness vs completeness**
A faster crawl with a higher Bloom filter false-positive rate misses some URLs. A slower crawl with exact dedup misses nothing. The right trade-off depends on the crawl goal: broad discovery (freshness wins) vs. auditing/indexing (completeness wins).

**JavaScript support: when to add it**
Headless browser workers cost ~100x more CPU and RAM per page than plain HTTP workers. For a scoped crawl of a known site, inspect the site first: if the main navigation is server-rendered HTML, the current architecture covers ~90% of the content. Add headless support when the gap (discovered via `content_hash` comparison between static and rendered versions) is significant.

**Re-crawl frequency policy**
Static pages (about, docs) change rarely. Blog posts and news change frequently. A change-frequency model (estimated from `Last-Modified` headers and historical hash comparisons) schedules re-crawls proportionally. Without this, re-crawling everything uniformly wastes crawl budget on static content.
