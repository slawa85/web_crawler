import { config } from './config.js'
import { logger } from './utils/logger.js'
import { runMigrations, seedUrl } from './db/migrate.js'
import { getFrontierStats, requeueStalled } from './db/frontier.js'
import { closeDb } from './db/connection.js'
import { runWorker, type ActiveWorkers } from './crawler/worker.js'
import { printSummary } from './utils/summary.js'

const TERMINATION_POLL_MS = 5_000
const STALLED_REQUEUE_INTERVAL_MS = 120_000
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000
const WORKER_DRAIN_TIMEOUT_MS = 30_000
// Log crawl progress at info level every N polls (N * TERMINATION_POLL_MS = 30s)
const PROGRESS_LOG_INTERVAL_POLLS = 6

async function main(): Promise<void> {
  logger.info({ config: { ...config, databaseUrl: '[REDACTED]' } }, 'Crawler starting')

  // ── Phase 1: Migrations + seed ────────────────────────────────────────────
  await runMigrations()
  await seedUrl(config.seedUrl)

  const startTime = Date.now()

  // ── Shared state ──────────────────────────────────────────────────────────
  const shuttingDown = { value: false }
  const activeWorkers: ActiveWorkers = { count: 0 }

  // ── Graceful shutdown handler ─────────────────────────────────────────────
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null
  let shutdownInitiated = false

  function initiateShutdown(signal: string): void {
    if (shutdownInitiated) return
    shutdownInitiated = true

    logger.info({ signal }, 'Shutdown signal received — stopping workers gracefully')
    shuttingDown.value = true

    shutdownTimer = setTimeout(() => {
      logger.warn('Graceful shutdown timeout exceeded — force exiting')
      process.exit(1)
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)

    // Allow the timer to not block process exit if it resolves naturally
    if (shutdownTimer.unref !== undefined) {
      shutdownTimer.unref()
    }
  }

  process.on('SIGINT', () => { initiateShutdown('SIGINT') })
  process.on('SIGTERM', () => { initiateShutdown('SIGTERM') })

  // ── Stalled-row requeue job ────────────────────────────────────────────────
  const stalledInterval = setInterval(() => {
    requeueStalled(config.stalledTimeoutMinutes).catch((err: unknown) => {
      logger.error({ err }, 'requeueStalled job failed')
    })
  }, STALLED_REQUEUE_INTERVAL_MS)
  stalledInterval.unref()

  // ── Start workers ─────────────────────────────────────────────────────────
  logger.info({ workerCount: config.workerCount }, 'Starting workers')

  let workerCrashed = false

  const workerPromises = Array.from({ length: config.workerCount }, (_, i) =>
    runWorker(i + 1, shuttingDown, activeWorkers).catch((err: unknown) => {
      logger.error({ err, workerId: i + 1 }, 'Worker crashed with unhandled exception')
      workerCrashed = true
      shuttingDown.value = true
    }),
  )

  // ── Termination poll ───────────────────────────────────────────────────────
  // Poll every 5 seconds. Signal shutdown when pending + inProgress === 0 in DB.
  // inProgress covers workers that are mid-cycle (URL held as in_progress until
  // markDone/markFailed), so no separate in-process counter is needed.
  let pollCount = 0
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (shuttingDown.value) {
        clearInterval(poll)
        resolve()
        return
      }

      getFrontierStats()
        .then((stats) => {
          const dbIdle = stats.pending + stats.inProgress === 0
          pollCount++

          // Emit a progress line at info level every 30 seconds so the crawl
          // is visible in logs without flooding them with per-poll entries.
          if (pollCount % PROGRESS_LOG_INTERVAL_POLLS === 0) {
            logger.info({
              pending: stats.pending,
              inProgress: stats.inProgress,
              done: stats.done,
              failed: stats.failed,
            }, 'Crawl progress')
          } else {
            logger.debug({
              pending: stats.pending,
              inProgress: stats.inProgress,
              done: stats.done,
              failed: stats.failed,
            }, 'Termination poll')
          }

          if (dbIdle) {
            logger.info('Frontier exhausted — signalling workers to stop')
            shuttingDown.value = true
            clearInterval(poll)
            resolve()
          }
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'getFrontierStats failed during termination poll')
        })
    }, TERMINATION_POLL_MS)
  })

  // ── Wait for workers to finish in-flight URLs, with a hard timeout ─────────
  // Workers completing their current URL take up to ~10s (fetch timeout).
  // If any worker is stuck (hung SQL or fetch that bypassed the timeout),
  // the drain timeout ensures we still print the summary and exit cleanly.
  await Promise.race([
    Promise.all(workerPromises),
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        logger.warn('Worker drain timeout reached — proceeding to summary')
        resolve()
      }, WORKER_DRAIN_TIMEOUT_MS)
      if (t.unref !== undefined) t.unref()
    }),
  ])

  clearInterval(stalledInterval)
  if (shutdownTimer !== null) clearTimeout(shutdownTimer)

  // ── Final summary ─────────────────────────────────────────────────────────
  try {
    const finalStats = await getFrontierStats()
    printSummary({
      ...finalStats,
      seedUrl: config.seedUrl,
      durationMs: Date.now() - startTime,
    })
  } catch (err) {
    logger.error({ err }, 'Failed to generate summary report')
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await closeDb()

  if (workerCrashed) {
    logger.error('Exiting with code 1 due to worker crash')
    process.exit(1)
  }

  logger.info('Crawl complete — exiting normally')
  process.exit(0)
}

main().catch((err: unknown) => {
  process.stderr.write(`FATAL: Unhandled error in main: ${String(err)}\n`)
  process.exit(1)
})
