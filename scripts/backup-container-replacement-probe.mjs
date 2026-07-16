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
  typeof handoff.filename !== "string" ||
  typeof handoff.checksum !== "string"
) {
  throw new Error("rehearsal_probe_handoff_invalid");
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
