import { readFile } from "node:fs/promises";

const baseUrl = process.env.REHEARSAL_APP_BASE_URL;
const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
if (!baseUrl || !handoffFile || !password) {
  throw new Error("rehearsal_probe_environment_not_set");
}

const handoff = JSON.parse(await readFile(handoffFile, "utf8"));
if (
  typeof handoff.email !== "string" ||
  typeof handoff.householdName !== "string" ||
  typeof handoff.memberId !== "string" ||
  typeof handoff.babyId !== "string" ||
  typeof handoff.startedAt !== "string" ||
  typeof handoff.filename !== "string" ||
  typeof handoff.checksum !== "string"
) {
  throw new Error("rehearsal_probe_handoff_invalid");
}

const health = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
if (!health.ok || JSON.stringify(await health.json()) !== JSON.stringify({ status: "ready" })) {
  throw new Error("rehearsal_app_health_invalid");
}

const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: baseUrl
  },
  body: JSON.stringify({ email: handoff.email, password, rememberMe: false })
});
if (!signIn.ok) {
  throw new Error(`rehearsal_app_sign_in_failed:${signIn.status}`);
}
const setCookie = signIn.headers.get("set-cookie") ?? "";
const sessionCookie = setCookie.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
if (!sessionCookie) throw new Error("rehearsal_app_session_cookie_missing");
const authenticatedCookie = `${sessionCookie}; cubby_household_member=${encodeURIComponent(handoff.memberId)}`;

const authenticatedPage = await fetch(`${baseUrl}/app?babyId=${encodeURIComponent(handoff.babyId)}`, {
  headers: { cookie: authenticatedCookie }
});
const authenticatedHtml = await authenticatedPage.text();
// The date and the time are matched separately, in the app's own locale and configured zone
// (APP_TIMEZONE is Etc/UTC for the rehearsal). Asserting one rendered string instead would pin the
// exact punctuation and weekday the detail page happens to use today; what has to survive the
// restore and the container swap is the instant, so the instant is what this reads.
const startedFormat = (options) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "Etc/UTC", ...options }).format(new Date(handoff.startedAt));
const expectedStartedDate = startedFormat({ month: "short", day: "numeric", year: "numeric" });
const expectedStartedTime = startedFormat({ hour: "numeric", minute: "2-digit" });
// A running or paused timer takes over its own dashboard tile or row. Those are now indicators: a
// dot, the activity, and how long it has been going, with the state in the text a screen reader is
// given. The start instant itself has moved to the activity's own page, which the indicator links to.
// The point of the assertion is unchanged: both restored timers must be visible, in their own states,
// with the preserved start time.
// The id class has to admit every id the app actually mints or restores, not just the cuid shape:
// this fixture's ids carry underscores, and a narrower class silently matched a prefix and found
// nothing, reporting a missing indicator when the page had rendered both of them.
const timerActivityIds = [...authenticatedHtml.matchAll(/\/app\/activities\/([A-Za-z0-9_-]+)\?returnTo=/g)]
  .map(([, id]) => id);
const timerProbe = {
  pageOk: authenticatedPage.ok,
  runningRow: authenticatedHtml.includes("Running for"),
  pausedRow: authenticatedHtml.includes("Paused at"),
  linkedActivities: timerActivityIds.length,
  // Named on failure so a mismatch says what the page held, rather than costing a whole rerun to see.
  activityHrefsSeen: [...authenticatedHtml.matchAll(/href="([^"]*\/app\/activities\/[^"]*)"/g)]
    .map(([, href]) => href)
    .slice(0, 8),
  databaseTimerStates: Array.isArray(handoff.timerProbeState) ? handoff.timerProbeState : null
};
if (!timerProbe.pageOk || !timerProbe.runningRow || !timerProbe.pausedRow || timerProbe.linkedActivities < 2) {
  throw new Error(`rehearsal_app_timer_incoherent:${JSON.stringify(timerProbe)}`);
}

// The preserved start instant, on the page that still states it outright.
const timerDetailPages = await Promise.all(
  [...new Set(timerActivityIds)].map(async (id) => {
    const page = await fetch(`${baseUrl}/app/activities/${id}`, { headers: { cookie: authenticatedCookie } });
    return page.ok ? await page.text() : "";
  })
);
if (!timerDetailPages.some((html) => html.includes(expectedStartedDate) && html.includes(expectedStartedTime))) {
  throw new Error(`rehearsal_app_timer_started_at_missing:${JSON.stringify({
    expectedStartedDate,
    expectedStartedTime,
    pages: timerDetailPages.length
  })}`);
}

const householdPage = await fetch(`${baseUrl}/app/settings/members`, { headers: { cookie: authenticatedCookie } });
if (!householdPage.ok || !(await householdPage.text()).includes(handoff.householdName)) {
  throw new Error("rehearsal_app_household_marker_missing");
}

const backupsPage = await fetch(`${baseUrl}/app/settings/backups`, { headers: { cookie: authenticatedCookie } });
const backupsHtml = await backupsPage.text();
if (!backupsPage.ok || !backupsHtml.includes("Healthy local versions:") || !backupsHtml.includes(handoff.checksum.slice(0, 12))) {
  throw new Error("rehearsal_app_backup_discovery_failed");
}

const download = await fetch(`${baseUrl}/api/backups/local/${encodeURIComponent(handoff.filename)}`, {
  headers: { cookie: authenticatedCookie }
});
if (!download.ok) {
  throw new Error(`rehearsal_app_backup_download_failed:${download.status}`);
}
if (!download.headers.get("content-disposition")?.includes(handoff.filename)) {
  throw new Error("rehearsal_app_backup_disposition_invalid");
}
const document = JSON.parse(await download.text());
if (document?.checksum !== handoff.checksum) {
  throw new Error("rehearsal_app_backup_checksum_mismatch");
}

console.log("APP CONTAINER BACKUP DOWNLOAD PASSED");
