/**
 * A stalled push provider must not hold a fire-and-forget delivery open indefinitely.
 * `web-push` applies this as a socket inactivity timeout and destroys the request when it expires.
 */
export const WEB_PUSH_REQUEST_OPTIONS = Object.freeze({ timeout: 10_000 });
