export const FRESHNESS_BROWSER_FAILURE_CODES = Object.freeze([
  "activity_create", "activity_update", "browser_diagnostics", "browser_expression_failed",
  "button_missing", "calendar_create", "calendar_outcome_incomplete", "calendar_submit_failed",
  "calendar_viewport_invalid", "cdp_closed",
  "cdp_command_failed", "cdp_command_timeout", "cdp_message_failed", "cdp_failed", "cdp_scope", "cdp_timeout",
  "chosen_photo_missing", "control_missing", "dialog_missing", "draft_preservation",
  "draft_refresh_missing", "foreground_five_seconds", "freshness_scope_invalid",
  "hidden_no_poll", "hide_failed", "isolation_surfaces_missing", "known_timer_missing",
  "moments_create", "moments_update", "navigation_failed", "observations_missing",
  "offline_retention", "online_control_enabled", "online_instant_absent",
  "online_page_absent", "online_requires_confirmation", "online_status_absent",
  "online_timer_bar_absent",
  "page_missing", "recovery_failed",
  "request_cadence", "service_worker_cache", "sign_in_failed", "tenant_isolation",
  "timer_start", "timer_stop", "worker_missing", "worker_outage_lapsed", "worker_target_missing", "unknown"
]);

const failures = new WeakMap();
export function browserFailure(code) {
  const closed = FRESHNESS_BROWSER_FAILURE_CODES.includes(code) ? code : "unknown";
  const failure = new Error(`FRESHNESS_BROWSER_${closed.toUpperCase()}`);
  failures.set(failure, closed);
  return failure;
}
export function browserFailureCode(error) {
  return failures.get(error) ?? "unknown";
}
export function formatBrowserFailure(error) {
  return `FRESHNESS_BROWSER_${browserFailureCode(error).toUpperCase()}\n`;
}
