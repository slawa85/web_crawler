import { config } from './config.js';
import { logger } from './utils/logger.js';
import { runMigrations, seedUrl } from './db/migrate.js';
import { getFrontierStats, requeueStalled } from './db/frontier.js';
import { closeDb } from './db/connection.js';
import { runWorker } from './crawler/worker.js';
import { printSummary } from './utils/summary.js';
const TERMINATION_POLL_MS = 5_000;
const STALLED_REQUEUE_INTERVAL_MS = 60_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;
async function main() {
    logger.info({ config: { ...config, databaseUrl: '[REDACTED]' } }, 'Crawler starting');
    // ── Phase 1: Migrations + seed ────────────────────────────────────────────
    await runMigrations();
    await seedUrl(config.seedUrl);
    const startTime = Date.now();
    // ── Shared state ──────────────────────────────────────────────────────────
    const shuttingDown = { value: false };
    const activeWorkers = { count: 0 };
    // ── Graceful shutdown handler ─────────────────────────────────────────────
    let shutdownTimer = null;
    let shutdownInitiated = false;
    function initiateShutdown(signal) {
        if (shutdownInitiated)
            return;
        shutdownInitiated = true;
        logger.info({ signal }, 'Shutdown signal received — stopping workers gracefully');
        shuttingDown.value = true;
        shutdownTimer = setTimeout(() => {
            logger.warn('Graceful shutdown timeout exceeded — force exiting');
            process.exit(1);
        }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        // Allow the timer to not block process exit if it resolves naturally
        if (shutdownTimer.unref !== undefined) {
            shutdownTimer.unref();
        }
    }
    process.on('SIGINT', () => { initiateShutdown('SIGINT'); });
    process.on('SIGTERM', () => { initiateShutdown('SIGTERM'); });
    // ── Stalled-row requeue job ────────────────────────────────────────────────
    const stalledInterval = setInterval(() => {
        requeueStalled(config.stalledTimeoutMinutes).catch((err) => {
            logger.error({ err }, 'requeueStalled job failed');
        });
    }, STALLED_REQUEUE_INTERVAL_MS);
    stalledInterval.unref();
    // ── Start workers ─────────────────────────────────────────────────────────
    logger.info({ workerCount: config.workerCount }, 'Starting workers');
    let workerCrashed = false;
    const workerPromises = Array.from({ length: config.workerCount }, (_, i) => runWorker(i + 1, shuttingDown, activeWorkers).catch((err) => {
        logger.error({ err, workerId: i + 1 }, 'Worker crashed with unhandled exception');
        workerCrashed = true;
        shuttingDown.value = true;
    }));
    // ── Termination poll ───────────────────────────────────────────────────────
    // Poll every 5 seconds. Signal shutdown when:
    //   (1) pending + inProgress === 0 in DB, AND
    //   (2) activeWorkers.count === 0 (no worker is mid-cycle)
    await new Promise((resolve) => {
        const poll = setInterval(() => {
            if (shuttingDown.value) {
                clearInterval(poll);
                resolve();
                return;
            }
            getFrontierStats()
                .then((stats) => {
                const dbIdle = stats.pending + stats.inProgress === 0;
                const workersIdle = activeWorkers.count === 0;
                logger.debug({
                    pending: stats.pending,
                    inProgress: stats.inProgress,
                    done: stats.done,
                    failed: stats.failed,
                    activeWorkers: activeWorkers.count,
                }, 'Termination poll');
                if (dbIdle && workersIdle) {
                    logger.info('Frontier exhausted — signalling workers to stop');
                    shuttingDown.value = true;
                    clearInterval(poll);
                    resolve();
                }
            })
                .catch((err) => {
                logger.error({ err }, 'getFrontierStats failed during termination poll');
            });
        }, TERMINATION_POLL_MS);
    });
    // ── Wait for all workers to finish their current iteration ─────────────────
    await Promise.all(workerPromises);
    clearInterval(stalledInterval);
    if (shutdownTimer !== null)
        clearTimeout(shutdownTimer);
    // ── Final summary ─────────────────────────────────────────────────────────
    try {
        const finalStats = await getFrontierStats();
        printSummary({
            ...finalStats,
            seedUrl: config.seedUrl,
            durationMs: Date.now() - startTime,
        });
    }
    catch (err) {
        logger.error({ err }, 'Failed to generate summary report');
    }
    // ── Cleanup ───────────────────────────────────────────────────────────────
    await closeDb();
    if (workerCrashed) {
        logger.error('Exiting with code 1 due to worker crash');
        process.exit(1);
    }
    logger.info('Crawl complete — exiting normally');
    process.exit(0);
}
main().catch((err) => {
    process.stderr.write(`FATAL: Unhandled error in main: ${String(err)}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map