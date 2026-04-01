/**
 * Normalise a raw URL extracted from a page.
 *
 * Steps (in order):
 * 1. Resolve relative URLs against baseUrl
 * 2. Strip fragment
 * 3. Lowercase scheme and host
 * 4. Remove default ports (:80 on http, :443 on https)
 * 5. Decode then re-encode percent-encoded characters consistently
 * 6. Sort query parameters alphabetically
 * 7. Remove known tracking params
 * 8. Remove trailing slash from paths (except root /)
 *
 * Returns null if the URL is invalid or should be discarded.
 */
export declare function normalizeUrl(raw: string, baseUrl: string): string | null;
/**
 * Returns true if the URL is in scope for crawling:
 * - http or https scheme
 * - host is exactly ipfabric.io or ends with .ipfabric.io
 * - URL length <= 2048
 * - Not a spider trap (path depth <= 15, no repeated segments)
 */
export declare function isInScope(url: string): boolean;
//# sourceMappingURL=normalizer.d.ts.map