export type Config = {
    seedUrl: string;
    workerCount: number;
    crawlDelayMs: number;
    requestTimeoutMs: number;
    maxDepth: number;
    maxPages: number;
    maxResponseBytes: number;
    stalledTimeoutMinutes: number;
    databaseUrl: string;
    logLevel: string;
};
export declare const config: Config;
//# sourceMappingURL=config.d.ts.map