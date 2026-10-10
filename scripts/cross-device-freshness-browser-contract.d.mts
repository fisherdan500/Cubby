export const FRESHNESS_BROWSER_FAILURE_CODES: readonly string[];
export function browserFailure(code: unknown): Error;
export function browserFailureCode(error: unknown): string;
export function formatBrowserFailure(error: unknown): string;
