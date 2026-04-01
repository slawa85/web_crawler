export type FetchResult = {
    url: string;
    status: number;
    body: string | null;
    contentHash: string;
    redirectChain: string[];
    error?: string;
};
/**
 * Fetch a URL and return a structured result.
 *
 * - Follows redirects manually to record the full chain (max 10 hops)
 * - Only reads the body when Content-Type is HTML
 * - Enforces a 5MB body size cap
 * - Uses a 10-second timeout per request hop
 * - Returns a FetchResult with error set on network/timeout errors (status: 0)
 */
export declare function fetchUrl(url: string): Promise<FetchResult>;
//# sourceMappingURL=fetcher.d.ts.map