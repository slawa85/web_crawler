/**
 * Extract all in-scope, normalised URLs from an HTML document.
 *
 * Extracts from:
 *   - <a href>              navigation links
 *   - <link rel="canonical"> canonical URL
 *   - <link rel="alternate"> alternate versions
 *
 * Does NOT extract: script[src], img[src], link[rel=stylesheet]
 *
 * Resolves <base href> first so relative URLs are resolved correctly.
 */
export declare function extractUrls(html: string, pageUrl: string): string[];
//# sourceMappingURL=parser.d.ts.map