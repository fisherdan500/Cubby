# Installing And Running Cubby

The whole path from an empty server to a Cubby your family uses every day, in order: install,
first setup, backups, a practice restore, and updates. Each step links to the fuller reference
where there is one. The short checklist at the end is the same steps, for ticking off.

## 1. Before You Start

- **A server**: current Ubuntu or Debian on x86_64, with Docker Engine and the Compose plugin
  installed, and this repository cloned onto it. Cubby keeps everything on this machine.
- **An address**: the one address people will open Cubby at, such as `https://cubby.example.com`.
  Use HTTPS through a reverse proxy you run in front of Cubby: the installed app, saving photos to
  a phone and secure sign-in cookies all need it. Sign-in accepts only this exact address.
- **A mail account** Cubby can send from over SMTP. Cubby sends account-security email and will
  not start without one.
- **Your time zone**, such as `America/New_York` or `Europe/London`. It decides which day each
  entry falls on. Set it right at install: changing it later moves entries between days.

## 2. Install

From the repository on the server:

1. Put the SMTP password alone in a file only you can read:

   ```bash
   umask 077; printf '%s\n' 'your-smtp-password' > smtp-password
   ```

2. Generate the configuration, with your address, time zone and mail server:

   ```bash
   sudo sh scripts/quick-start.sh --url https://cubby.example.com \
     --timezone America/New_York \
     --smtp-host smtp.example.com --smtp-user cubby@example.com \
     --email-from 'Cubby <cubby@example.com>' --smtp-password-file smtp-password
   ```

   Add `--trusted-proxy-hops 1` when every request reaches Cubby through one reverse proxy. The
   script writes `.env` with a fresh value for every secret and creates the private `docker-data`
   directories. It never overwrites an existing `.env`. The other options are in the README's
   Docker Quick Start.

3. Delete the password file: `rm smtp-password`.

4. **Save a copy of `.env` somewhere safe of its own, such as a password manager.** It holds the
   keys the accounts and email depend on. Without it, no backup can bring those back. Save it
   again whenever you change it.

5. Start Cubby:

   ```bash
   docker compose up --build -d
   ```

## 3. First Setup

1. Find the one-time setup code: `docker compose logs app`, and look for
   `Cubby has no platform owner yet`.
2. Open your address at `/setup` and enter the code with your name, email and password. That makes
   you the platform owner.
3. **Send yourself a test email**: Settings → Platform administration (`/platform/settings`) → Send
   test email. Password resets and email changes depend on it; if it fails, it says why.
   Only one owner test-email attempt runs at a time, followed by a 60-second cooldown after
   it settles (including failures). This diagnostic limit is process-local, uses a monotonic
   clock, and resets on restart; it assumes one app process, not multiple replicas. A busy
   response asks you to wait; it never queues or automatically resends mail.
4. Create your household. Cubby starts with household creation closed, even for you: open
   `/platform/settings`, set household creation to open, create your household and add your baby,
   then set it back to closed (or invitation-only, if you will host other families).
5. Invite the rest of the family from Settings → Members and access. Sign-up is by invitation only.
   Cubby shows each new invitation link once for you to copy, and also emails it to the person
   (untick "Also email this invitation" to share it yourself). The email uses the same mail settings
   as the test email and links to your address from `--url`; no extra setting is needed. A pending
   invitation shows its email status. "Emailed" means the SMTP server accepted the message, not
   that it reached the recipient's inbox. **Re-send email** replaces the link and emails the new
   one; an old link cannot be recovered or shown again. The queue temporarily keeps an encrypted
   copy for delivery and retries, then destroys it after acceptance, permanent failure or
   cancellation. Revocation cancels queued/retryable mail; an already-dispatching message can
   still arrive, but its revoked link cannot be used. Enter one bare mailbox, not a display name
   or address list. Authentication and permanent recipient/server rejections end that delivery;
   temporary SMTP replies and connection/timeouts use bounded retries. After correcting mail
   settings, use **Re-send email** for a failed invitation. The owner's diagnostic cooldown does
   not limit invitation creation or re-send; no dedicated invitation re-send throttle is implemented.

## 4. Backups

Set these up before the family relies on Cubby. There are two kinds, and you want both:

- **Whole-system backup**, the platform owner's: one archive of every household, account and
  photo. It is how you bring everything back if the server dies. See
  [Whole-System Backup](recovery/system-backup.md).
- **Household backups**, each household owner's: one household's data and photos, for moving a
  household to another Cubby. Settings → Backups makes one on demand. A photo added to a logged
  entry stays attached to that entry through a backup and restore, so the entry and its picture
  come back as one moment rather than two separate ones.

Whole-system scripts require **Node.js 22+ on the host**, GNU tar/coreutils, and a planned
maintenance window. `--maintenance` explicitly permits downtime: the sole app and its jobs
stop until a successful backup is verified. Failures after stop leave it stopped; monitor the
host log because a stopped app cannot send alerts. Do not run another app, manual database or
photo writer, or deployment during this window. All system-backup/restore operators must use
this same checkout and shared lock. Neither script edits schedules/settings. See the recovery
guide for scratch capacity, format bounds and safe failure handling.

1. **Make the nightly whole-system backup.** Add this line with `crontab -e`, as the account that
   runs Cubby, changing the path to your checkout:

   ```cron
   15 3 * * * cd /home/you/cubby && sh scripts/system-backup.sh --maintenance >> docker-data/system-backup.log 2>&1
   ```

   Run `sh scripts/system-backup.sh --maintenance` once by hand now to check it works.

2. **Turn on automated household backups.** They are off by default. Add this line to `.env`, then
   run `docker compose up -d`:

   ```dotenv
   AUTOMATED_BACKUPS_ENABLED=true
   ```

   Settings → Backups then shows each household's daily versions. Update your saved copy of `.env`.

3. **Copy backups off the server.** A backup on the server's disk goes with the disk. Copy
   `docker-data/system-backups` to another computer, a NAS or an external drive, for example with
   `rsync` on a schedule (see [Whole-System Backup](recovery/system-backup.md#copy-it-off-the-server)).
   At the very least, download the newest archive to your own computer each week.

4. **Keep `.env` and `docker-data/` private.** They hold every secret and every household's data.

Cubby watches all of this for you. Platform administration (`/platform/settings`) shows the newest
backups and free disk space under **Backups and storage**. You get an email when:

- a backup fails or stops;
- a disk holding photos or backups is nearly full;
- photo or backup storage cannot be checked (free space is unknown, not healthy).

An unreadable measurement does not clear an existing low-space alert, including a prior
combined photos-and-backups warning. Fresh successful measurements can clear it again.

The email goes out when the problem starts, then once a day until it is fixed. It uses the same mail
settings as the test email in step 3.

Household JSON/ZIP restore and preview uploads require backup permission before Cubby reads
or stages bytes. One upload/preview/restore runs at a time per app process, reserving the
full archive allowance (2 GiB; JSON remains capped at 25 MiB), regardless of Content-Length.
A busy request is refused before staging; retry after the current request finishes. Body
ingestion has a two-minute deadline and cancels on disconnect. Filesystem operations already
in progress are awaited before cleanup and capacity release, not abandoned on timeout.
This is not a shared quota across multiple app processes, nor a quota on retained photos.
If staging-file removal fails, uploads stay blocked in that process: investigate storage,
then restart only after resolving it. Existing stale-upload cleanup handles old staging files;
any entry still in restore-staging consumes the full archive slot after restart. New ZIP
uploads refuse before body reading until it is resolved. Unknown entries are not deleted;
known old uploads retain the existing 24-hour cleanup policy. This prevents adding a new
2 GiB upload beside crash leftovers, not remediation of pre-existing excess storage.
A cleanup error after restore
does not imply that the restore transaction failed: check the household before retrying.

Manual household exports verify every listed photo before recording export preparation.
The history label "Export prepared" and the `backup.export` audit event do not confirm that
the browser received the file. Later storage or connection failures can still interrupt a
download; check that it finished saving. Older manual export records also do not prove receipt.
Automated local backup completion instead follows durable publication and read-back verification.

## 5. Practise A Restore, Early

Photo writes now reserve durable private cleanup ownership before creating files, including restored
photos. Failed writes remain owned until the retention tick retries after 24 hours; deletion errors
retain the owner and retry after 15 minutes. This relies on one Node app process per attachment store:
do not overlap app instances sharing it. A stalled in-process writer is not swept merely because it
is old. Historical unowned objects and legacy temporary files are not automatically deleted. The new
`AttachmentWriteIntent` migration must be applied by the normal update path before running this code.
New reservations now lock and recheck the live session and member permission before committing.
A serialized database check limits pending write intents plus unclaimed staging photos to
2 GiB across the store, including after restart. Transferred intents are not counted twice,
and claimed household photo history is not capped. Expired unclaimed photos still consume
capacity until cleanup actually succeeds. If staging is full, share pending photos or wait
for cleanup; do not delete private objects by hand. Historical unowned bytes are outside this
accounting and require separately reviewed reconciliation.

Photos have one pre-body upload slot per process (25 MiB input, two-minute body deadline),
held through processing and storage completion. Upload and thumbnail decoding share one
native decode slot, with a 30-second Sharp timeout and elapsed-time rejection that includes
queue time. This is not forced native cancellation: late work retains capacity until it
actually settles, and late results are refused. Concurrent thumbnail reads fall back to the
size/digest-verified original when native decoding is busy; unchecked cached pixels are not served.

Cached thumbnails are validated in one short-lived Node process per image so native warnings
cannot be consumed by another decoder. This adds process-start overhead, not an OS security
sandbox. Validation accepts at most 2 MiB and 800×800 pixels, rejects decoder warnings, bounds
output and kills the child after five seconds; capacity stays held until its streams close.
If termination fails, capacity stays unavailable until the child actually exits. Missing or
failed validation never serves unchecked cache bytes: the original must pass size/digest checks.
Upload normalization is unchanged. The fixed `runtime/thumbnail-validator.cjs` and production
Sharp dependencies must accompany the app; Next standalone tracing and the Docker source copy
include the helper. Run development/`next start` from the checkout root; standalone runs from
its packaged root. This remains a single-app-process design, not a multi-replica resource limit.
A stuck native/filesystem operation can
therefore block new work rather than permitting unbounded work behind it.

Sprout preview/import shares the JSON/ZIP backup slot through service completion. Multipart
parsing happens only after a bounded actual-byte read with the same two-minute cancellation
deadline: preview allows the existing 100 MiB file plus 1 MiB envelope, while import's
preview-ID-only form allows 1 MiB total. These are operational ingestion bounds, not new
limits on household history. No Content-Length value bypasses actual-byte accounting.

Do this once, before there is much data, so a real recovery is not the first one. On a second,
throwaway machine or VM:

1. Install Cubby as in step 2, up to `docker compose up --build -d`, but put your saved `.env` in
   place of the one the quick start wrote, and do not open `/setup`.
2. Copy over your newest system backup and run
   `sh scripts/system-restore.sh --archive <file> --confirm-empty-install --maintenance`.
3. Sign in with your usual password and check your entries, Moments posts and photos are there.

Then throw the practice machine away.

## 6. Updating A Running Cubby

Cubby has no published image to pull. The server builds its own image from this repository, so an
update means pulling the new code and rebuilding. Your data is not inside the image: the database
lives in the `cubby_postgres_data` volume, and photos and backups in `docker-data/`. Replacing the
container leaves all of it in place.

### Where To Run These

Every command below runs on the server, in the Cubby folder: the folder you cloned this repository
into at install. It is the one holding `docker-compose.yml`, `.env`, `scripts/` and `docker-data/`,
such as `/home/you/cubby`, the same path as in your backup's crontab line. Run them as the account
that runs Cubby, the one in that crontab.

If you are not sure where that folder is, Docker can tell you. The `CONFIG FILES` column shows the
full path of the Cubby folder's `docker-compose.yml`:

```bash
docker compose ls
```

Go into that folder first, and stay in it for every step:

```bash
cd /home/you/cubby
```

Check you are in the right place: this should list `docker-compose.yml`, `scripts` and
`docker-data`, among others.

```bash
ls
```

The `docker compose` commands find Cubby through the `docker-compose.yml` in the current folder, and
the `scripts/...` and `git` commands are relative to it. Run from anywhere else, they fail or act
on the wrong thing.

### The Steps

1. **Make a backup first**, and copy the archive off the server. It is written to
   `docker-data/system-backups/` inside the Cubby folder:

   ```bash
   sh scripts/system-backup.sh --maintenance
   ```

2. **Check nothing local is in the way.** `git status` should list no changed files. `.env` and
   `docker-data/` are never listed, and they stay as they are.

   ```bash
   git status
   ```

3. **Pull the new code:**

   ```bash
   git pull
   ```

4. **Build a fresh image.** `--pull` also fetches the newest Node base image, so security fixes to
   it arrive with the update. The running Cubby keeps serving while this builds.

   ```bash
   docker compose build --pull app
   ```

5. **Refresh PostgreSQL** to the newest 16.x image. This stays within PostgreSQL 16, so the
   database needs no conversion:

   ```bash
   docker compose pull postgres
   ```

6. **Swap in the new containers.** Compose replaces only the containers whose image changed. Cubby
   is unavailable for the minute or so it takes to restart. It updates its database on start and
   refuses to start if that fails.

   ```bash
   docker compose up -d
   ```

7. **Check it is healthy.** Both services should show `healthy` within about a minute. Then open
   Cubby as usual and check your newest entries and photos are there.

   ```bash
   docker compose ps
   docker compose logs --tail 100 app
   ```

8. **Optionally, reclaim disk space** from old images once the new one is healthy:

   ```bash
   docker image prune
   ```

If the new version does not become healthy, do not go back to the old code on your own once the
database has been updated: an older Cubby may not understand the newer database. Leave it stopped,
keep the backup from step 1, and follow
[Failure Handling](ALWAYS_ON_UPDATES.md#failure-handling) in Always-On Updates.

**Never run `docker compose down --volumes`**: it deletes the database. Plain `docker compose down`
and `docker compose up -d` are safe. For the full runbook, with the preflight checks, see
[Always-On Updates](ALWAYS_ON_UPDATES.md).

## 7. Phone Notifications For Moments

Optional. When it is set up, a phone gets a notification when someone posts a moment, and the
people in a conversation hear about comments and reactions on it. Leave the keys blank and Cubby
behaves exactly as it does without this: nothing is sent, and the settings page says so.

**Two things are required before any of it can work.**

First, an **https address**. Browsers refuse push notifications on a plain `http://` address, and
they refuse to register the service worker that receives them, so nothing arrives and nothing
explains why. If you reach Cubby over http today, set up the reverse proxy in step 1 first.

Second, on an **iPhone or iPad**, Cubby has to be on the Home Screen. Safari grants notifications
only to an installed web app; in an ordinary Safari tab the permission prompt never appears. Open
Cubby in Safari, tap Share, choose "Add to Home Screen", then open Cubby from that new icon.
Android has no such restriction.

### Setting it up

1. Generate a key pair. These identify your server to Apple's and Google's push services:

   ```bash
   docker compose exec app node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
   ```

2. Put them in `.env`, with an address a push service can use to contact you:

   ```bash
   WEB_PUSH_VAPID_PUBLIC_KEY=<the publicKey from step 1>
   WEB_PUSH_VAPID_PRIVATE_KEY=<the privateKey from step 1>
   WEB_PUSH_CONTACT=mailto:you@example.com
   ```

   The private key signs every notification. Treat it like a password: keep it out of screenshots
   and out of anything you share. Changing it later invalidates every device already registered,
   and each one has to turn notifications on again.

3. If Cubby sits behind a reverse proxy, so that `BETTER_AUTH_URL` is an internal address rather
   than the one people type, add the public one. A notification's link is built from this, and a
   notification that opens an internal address goes nowhere from a phone:

   ```bash
   CUBBY_PUBLIC_URL=https://cubby.example.com
   ```

4. Rebuild the app so it reads the new settings. PostgreSQL is untouched:

   ```bash
   docker compose up -d --build --no-deps app
   ```

5. On each phone, open **Settings → Notifications**, turn on **External delivery** under Preference,
   then press **Turn on notifications** under "This device". Both are needed: the preference is the
   member's choice, and the device registration is the phone itself.

### If nothing arrives

The settings page states the reason it will not offer the button - not a secure address, keys not
configured, blocked in browser settings, or an iPhone that is not yet on the Home Screen. Check
there first.

Delivery is best effort. Apple's and Google's services are outside your control and will sometimes
delay or drop a notification, so treat it as a nudge rather than a guarantee; Cubby's own record of
what happened is always the Moments page.

## 8. If The Server Dies

Set up a new server, install Cubby as in step 2 with your saved `.env` in place, do not open
`/setup`, and restore your newest system backup, exactly as in the practice restore. Everyone
signs in as before. See [Whole-System Backup](recovery/system-backup.md#restoring-onto-a-new-server).

## 9. Moving One Household To A New Cubby

A whole-system backup moves everything and is the right tool when you are replacing a server. Use a
single household backup instead when you are moving one household into a Cubby that already exists,
or when you do not have the old server's `.env` and so cannot carry accounts across.

This path is deliberately narrower than a system restore, and the restrictions are worth knowing
before you start rather than after a refusal.

**The destination household must be genuinely empty.** Restore refuses a household that holds any
baby, entry, contact, medicine, calendar event, reminder, post, comment, reaction, photo, planned
schedule, notification preference or push subscription — and also any outstanding invite, API key or
webhook. A brand-new household from `/setup` is empty; one you have been trying things in is not,
even if it looks empty on screen. If you created a placeholder baby while setting up, delete it
first. The refusal is `Restore requires a fresh household with only its current owner.`

**You must be the household's only member, and its owner.** Invite the rest of the family *after*
the restore, not before.

**Accounts do not travel.** A household backup carries who was in the household, but not their
passwords or sessions — those live in the system backup and in `.env`. After a restore, anyone whose
email is already registered on the destination is reconnected automatically; everyone else is listed
for you to invite again. Nobody is created, and nobody gains access because a file said so.

**Entry authorship does not travel either.** Restored entries are attributed to whoever ran the
restore, because an entry's author is a household membership and memberships are not carried. The
times, notes and details are exact; the name against each entry becomes yours.

Steps:

1. On the old Cubby, open Backups and download the household backup. A household with photos
   downloads as a `.zip`; keep it exactly as downloaded — do not unzip or rebuild it.
2. On the new Cubby, finish `/setup`, create the household, and delete any placeholder baby.
3. Open Backups, upload the file to preview it, check the household name and counts look right, then
   confirm the restore by typing the household's name.
4. The restore tells you who it could not reconnect. Invite those people; they sign in with their own
   new accounts.

**Keep the old server running and untouched until you have checked the new one.** The restore does
not alter the backup file, so an attempt that fails costs you the attempt and nothing else.

If a restore stops with a message about the database being busy or unreachable, nothing was saved —
wait and try again. If it stops because Cubby cannot reach its backup folder, that is
`AUTOMATED_BACKUP_DIRECTORY` on the *server*, not a problem with your file.

## Checklist

- [ ] Time zone set at install (`--timezone`)
- [ ] HTTPS address, the same one given to `--url`
- [ ] `smtp-password` file deleted
- [ ] Copy of `.env` saved somewhere safe, and updated whenever `.env` changes
- [ ] Setup finished at `/setup`; test email received
- [ ] Household created, then household creation set back to closed
- [ ] Nightly whole-system backup in the crontab, and one made by hand
- [ ] `AUTOMATED_BACKUPS_ENABLED=true` in `.env`
- [ ] Backups copied off the server on a schedule
- [ ] Practice restore done on a throwaway machine
- [ ] Optional: phone notifications set up (https address, VAPID keys in `.env`, and on an iPhone
      Cubby added to the Home Screen) - see step 7
- [ ] Before every update: `cd` into the Cubby folder and make a backup first; then `git pull`, `docker compose build --pull app`,
      `docker compose pull postgres`, `docker compose up -d`; never `docker compose down --volumes`
