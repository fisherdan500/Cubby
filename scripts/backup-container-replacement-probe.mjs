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

const authenticatedPage = await fetch(`${baseUrl}/app?babyId=${encodeURIComponent(handoff.babyId)}`, {
  headers: { cookie: sessionCookie }
});
const authenticatedHtml = await authenticatedPage.text();
const expectedStarted = new Intl.DateTimeFormat("en", {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Etc/UTC"
}).format(new Date(handoff.startedAt));
if (!authenticatedPage.ok || !authenticatedHtml.includes("Active timers") ||
  !authenticatedHtml.includes("Paused") || !authenticatedHtml.includes(expectedStarted)) {
  throw new Error("rehearsal_app_timer_incoherent");
}

const householdPage = await fetch(`${baseUrl}/app/settings/members`, { headers: { cookie: sessionCookie } });
if (!householdPage.ok || !(await householdPage.text()).includes(handoff.householdName)) {
  throw new Error("rehearsal_app_household_marker_missing");
}

const backupsPage = await fetch(`${baseUrl}/app/settings/backups`, { headers: { cookie: sessionCookie } });
const backupsHtml = await backupsPage.text();
if (!backupsPage.ok || !backupsHtml.includes("Healthy local versions:") || !backupsHtml.includes(handoff.checksum.slice(0, 12))) {
  throw new Error("rehearsal_app_backup_discovery_failed");
}

const download = await fetch(`${baseUrl}/api/backups/local/${encodeURIComponent(handoff.filename)}`, {
  headers: { cookie: sessionCookie }
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
