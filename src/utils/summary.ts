import type { FrontierStats } from '../db/frontier.js'

export type CrawlStats = FrontierStats & {
  seedUrl: string
  durationMs: number
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - text.length))
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const BOX_WIDTH = 44  // inner width between ║ chars

function row(label: string, value: string | number): string {
  const content = `  ${label.padEnd(18)}: ${String(value).padStart(5)}`
  return `║${pad(content, BOX_WIDTH)}║`
}

function divider(): string {
  return `╠${'═'.repeat(BOX_WIDTH)}╣`
}

function top(): string {
  return `╔${'═'.repeat(BOX_WIDTH)}╗`
}

function bottom(): string {
  return `╚${'═'.repeat(BOX_WIDTH)}╝`
}

function header(text: string): string {
  const padded = `  ${text}`
  return `║${pad(padded, BOX_WIDTH)}║`
}

/**
 * Print a formatted crawl summary report to stdout.
 */
export function printSummary(stats: CrawlStats): void {
  const totalDiscovered = stats.done + stats.failed + stats.pending + stats.inProgress
  const lines = [
    top(),
    header('CRAWL COMPLETE'),
    divider(),
    row('Seed URL', stats.seedUrl),
    row('Duration', formatDuration(stats.durationMs)),
    divider(),
    row('Pages fetched', stats.done),
    row('URLs discovered', totalDiscovered),
    row('Depth reached', stats.maxDepth),
    divider(),
    row('HTTP 2xx', stats.http2xx),
    row('HTTP 3xx', stats.http3xx),
    row('HTTP 4xx', stats.http4xx),
    row('HTTP 429', stats.http429),
    row('HTTP 5xx', stats.http5xx),
    row('Errors', stats.failed),
    bottom(),
  ]

  for (const line of lines) {
    process.stdout.write(line + '\n')
  }

  const totalProcessed = stats.done + stats.failed
  if (totalProcessed > 0 && stats.http429 > 0 && stats.http429 / totalProcessed > 0.1) {
    process.stdout.write(
      `\nWARN: ${stats.http429} URLs returned HTTP 429 (rate limited). Consider increasing CRAWL_DELAY_MS or reducing WORKER_COUNT.\n`,
    )
  }
}
