import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FrontierStats } from '../db/frontier.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeBusyStats(overrides: Partial<FrontierStats> = {}): FrontierStats {
  return {
    pending: 10, pendingRetry: 0, inProgress: 2,
    done: 50, failed: 3, maxDepth: 4,
    http2xx: 45, http3xx: 2, http4xx: 3, http429: 0, http5xx: 0, httpErrors: 3,
    ...overrides,
  }
}

function makeIdleStats(): FrontierStats {
  return makeBusyStats({ pending: 0, inProgress: 0 })
}

// ── OLD pattern: setInterval + .then() ─────────────────────────────────────
// This is the exact pattern that was in index.ts before the fix.
// It wraps setInterval with an async .then() chain inside a Promise constructor.

async function oldTerminationPoll(
  getStats: () => Promise<FrontierStats>,
  pollMs: number,
  shuttingDown: { value: boolean },
): Promise<void> {
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (shuttingDown.value) {
        clearInterval(poll)
        resolve()
        return
      }

      getStats()
        .then((stats) => {
          const dbIdle = stats.pending + stats.inProgress === 0
          if (dbIdle) {
            shuttingDown.value = true
            clearInterval(poll)
            resolve()
          }
        })
        .catch(() => { /* swallow */ })
    }, pollMs)
  })
}

// ── NEW pattern: async while loop ──────────────────────────────────────────
// This is the replacement in the current index.ts.

async function newTerminationPoll(
  getStats: () => Promise<FrontierStats>,
  pollMs: number,
  shuttingDown: { value: boolean },
): Promise<void> {
  while (!shuttingDown.value) {
    await sleep(pollMs)
    if (shuttingDown.value) break

    try {
      const stats = await getStats()
      const dbIdle = stats.pending + stats.inProgress === 0
      if (dbIdle) {
        shuttingDown.value = true
      }
    } catch {
      /* swallow */
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Termination poll', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  describe('NEW async-loop pattern', () => {
    it('terminates when frontier becomes idle', async () => {
      const shuttingDown = { value: false }
      let callCount = 0

      const getStats = vi.fn((): Promise<FrontierStats> => {
        callCount++
        // First 3 calls: busy; 4th call: idle
        return Promise.resolve(callCount >= 4 ? makeIdleStats() : makeBusyStats())
      })

      const pollPromise = newTerminationPoll(getStats, 50, shuttingDown)

      // Advance time: 4 polls * 50ms = 200ms
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }

      await pollPromise
      expect(shuttingDown.value).toBe(true)
      expect(getStats).toHaveBeenCalledTimes(4)
    })

    it('terminates when frontier has retry-pending URLs that eventually clear', async () => {
      const shuttingDown = { value: false }
      let callCount = 0

      const getStats = vi.fn((): Promise<FrontierStats> => {
        callCount++
        if (callCount <= 2) {
          // Active crawl
          return Promise.resolve(makeBusyStats({ pending: 5, inProgress: 1 }))
        } else if (callCount <= 5)   {
          // Retry-pending phase: pending > 0 but nothing fetchable
          return Promise.resolve(makeBusyStats({ pending: 2, pendingRetry: 2, inProgress: 0 }))
        } else {
          // Retries exhausted, frontier truly idle
          return Promise.resolve(makeIdleStats())
        }
      })

      const pollPromise = newTerminationPoll(getStats, 50, shuttingDown)

      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }

      await pollPromise
      expect(shuttingDown.value).toBe(true)
      // Should have polled through the retry-pending phase without premature termination
      expect(getStats).toHaveBeenCalledTimes(6)
    })

    it('exits immediately when shuttingDown is set externally', async () => {
      const shuttingDown = { value: false }
      const getStats = vi.fn(() => Promise.resolve(makeBusyStats()))

      const pollPromise = newTerminationPoll(getStats, 50, shuttingDown)

      // Set shutdown during the first sleep
      await vi.advanceTimersByTimeAsync(25)
      shuttingDown.value = true
      await vi.advanceTimersByTimeAsync(30)

      await pollPromise
      // getStats should not have been called — loop broke during sleep
      expect(getStats).toHaveBeenCalledTimes(0)
    })

    it('does not overlap DB queries even if getStats is slow', async () => {
      const shuttingDown = { value: false }
      let concurrentCalls = 0
      let maxConcurrent = 0
      let callCount = 0

      const getStats = vi.fn(async (): Promise<FrontierStats> => {
        concurrentCalls++
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls)
        callCount++
        // Simulate a slow DB query (longer than poll interval)
        await sleep(120)
        concurrentCalls--
        return callCount >= 3 ? makeIdleStats() : makeBusyStats()
      })

      const pollPromise = newTerminationPoll(getStats, 50, shuttingDown)

      // Need enough time for: sleep(50) + getStats(120) per call, ~3 calls
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }

      await pollPromise
      expect(shuttingDown.value).toBe(true)
      // The async loop guarantees no overlapping calls
      expect(maxConcurrent).toBe(1)
    })
  })

  describe('OLD setInterval pattern (regression proof)', () => {
    it('overlaps DB queries when getStats is slower than poll interval', async () => {
      const shuttingDown = { value: false }
      let concurrentCalls = 0
      let maxConcurrent = 0
      let callCount = 0

      const getStats = vi.fn(async (): Promise<FrontierStats> => {
        concurrentCalls++
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls)
        callCount++
        // Simulate a slow DB query — takes 120ms, poll interval is 50ms
        await sleep(120)
        concurrentCalls--
        return callCount >= 5 ? makeIdleStats() : makeBusyStats()
      })

      const pollPromise = oldTerminationPoll(getStats, 50, shuttingDown)

      // Advance enough time for overlapping calls to manifest
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }

      await pollPromise

      // The old setInterval pattern fires every 50ms regardless of whether
      // the previous getStats() has resolved, causing overlapping DB calls.
      expect(maxConcurrent).toBeGreaterThan(1)
    })
  })
})
