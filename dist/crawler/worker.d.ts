export type ActiveWorkers = {
    count: number;
};
/**
 * Run a single worker loop.
 *
 * The worker continues until `shuttingDown` is set to true.
 * It increments/decrements `activeWorkers.count` around each dequeue→enqueue
 * cycle so the orchestrator can determine when it is safe to terminate.
 */
export declare function runWorker(workerId: number, shuttingDown: {
    value: boolean;
}, activeWorkers: ActiveWorkers): Promise<void>;
//# sourceMappingURL=worker.d.ts.map