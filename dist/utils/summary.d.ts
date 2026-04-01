import type { FrontierStats } from '../db/frontier.js';
export type CrawlStats = FrontierStats & {
    seedUrl: string;
    durationMs: number;
};
/**
 * Print a formatted crawl summary report to stdout.
 */
export declare function printSummary(stats: CrawlStats): void;
//# sourceMappingURL=summary.d.ts.map