export type Config = {
  seedUrl: string
  workerCount: number
  crawlDelayMs: number
  requestTimeoutMs: number
  maxDepth: number
  maxPages: number
  maxResponseBytes: number
  stalledTimeoutMinutes: number
  databaseUrl: string
  logLevel: string
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    // Use process.stderr directly — logger is not yet initialised at config load time
    process.stderr.write(`FATAL: Required environment variable ${name} is not set\n`)
    process.exit(1)
  }
  return value
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed)) {
    process.stderr.write(`FATAL: Environment variable ${name} must be an integer, got: ${raw}\n`)
    process.exit(1)
  }
  return parsed
}

function envStr(name: string, defaultValue: string): string {
  const raw = process.env[name]
  return raw !== undefined && raw !== '' ? raw : defaultValue
}

function assertRange(name: string, value: number, min: number): void {
  if (value < min) {
    process.stderr.write(`FATAL: Environment variable ${name} must be >= ${min}, got: ${value}\n`)
    process.exit(1)
  }
}

export const config: Config = {
  databaseUrl: requireEnv('DATABASE_URL'),
  seedUrl: envStr('SEED_URL', 'https://ipfabric.io/'),
  workerCount: envInt('WORKER_COUNT', 5),
  crawlDelayMs: envInt('CRAWL_DELAY_MS', 1000),
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 10_000),
  maxDepth: envInt('MAX_DEPTH', 10),
  maxPages: envInt('MAX_PAGES', 10_000),
  maxResponseBytes: envInt('MAX_RESPONSE_BYTES', 5_242_880),
  stalledTimeoutMinutes: envInt('STALLED_TIMEOUT_MINUTES', 5),
  logLevel: envStr('LOG_LEVEL', 'info'),
}

assertRange('WORKER_COUNT', config.workerCount, 1)
assertRange('MAX_DEPTH', config.maxDepth, 1)
assertRange('CRAWL_DELAY_MS', config.crawlDelayMs, 0)
assertRange('REQUEST_TIMEOUT_MS', config.requestTimeoutMs, 1000)
assertRange('MAX_PAGES', config.maxPages, 1)
