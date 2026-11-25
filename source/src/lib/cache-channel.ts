// The direct channel between Ember pages and the background cache owner (cache-service.ts listens,
// cache-client.ts asks), and the requests it may carry: read-only or repeatable ones (fetching an email's
// body or attachment list saves the same thing twice at worst), so a request that also goes the slow way
// after a timeout does no harm. (No imports: both bundles include this.)
export const CACHE_CHANNEL = "spark-cache";
export const DIRECT_COMMANDS = new Set(["snapshot", "changes", "headers", "body", "files", "attachmentIndex", "attachmentKeys", "linkIndex", "search", "headersFor", "resolve", "message", "fetch"]);
