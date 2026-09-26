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
4. Create your household. Cubby starts with household creation closed, even for you: open
   `/platform/settings`, set household creation to open, create your household and add your baby,
   then set it back to closed (or invitation-only, if you will host other families).
5. Invite the rest of the family from Settings → Members and access. Sign-up is by invitation only.

## 4. Backups

Set these up before the family relies on Cubby. There are two kinds, and you want both:

- **Whole-system backup**, the platform owner's: one archive of every household, account and
  photo. It is how you bring everything back if the server dies. See
  [Whole-System Backup](recovery/system-backup.md).
- **Household backups**, each household owner's: one household's data and photos, for moving a
  household to another Cubby. Settings → Backups makes one on demand.

1. **Make the nightly whole-system backup.** Add this line with `crontab -e`, as the account that
   runs Cubby, changing the path to your checkout:

   ```cron
   15 3 * * * cd /home/you/cubby && sh scripts/system-backup.sh >> docker-data/system-backup.log 2>&1
   ```

   Run `sh scripts/system-backup.sh` once by hand now to check it works.

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
- a disk holding photos or backups is nearly full.

The email goes out when the problem starts, then once a day until it is fixed. It uses the same mail
settings as the test email in step 3.

## 5. Practise A Restore, Early

Do this once, before there is much data, so a real recovery is not the first one. On a second,
throwaway machine or VM:

1. Install Cubby as in step 2, up to `docker compose up --build -d`, but put your saved `.env` in
   place of the one the quick start wrote, and do not open `/setup`.
2. Copy over your newest system backup and run
   `sh scripts/system-restore.sh --archive <file> --confirm-empty-install`.
3. Sign in with your usual password and check your entries, Moments posts and photos are there.

Then throw the practice machine away.

## 6. Updating A Running Cubby

Cubby has no published image to pull. The server builds its own image from this repository, so an
update means pulling the new code and rebuilding. Your data is not inside the image: the database
lives in the `cubby_postgres_data` volume, and photos and backups in `docker-data/`. Replacing the
container leaves all of it in place.

Run these from the checkout on the server, while Cubby is running:

1. **Make a backup first**, and copy the archive off the server:

   ```bash
   sh scripts/system-backup.sh
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

## 7. If The Server Dies

Set up a new server, install Cubby as in step 2 with your saved `.env` in place, do not open
`/setup`, and restore your newest system backup, exactly as in the practice restore. Everyone
signs in as before. See [Whole-System Backup](recovery/system-backup.md#restoring-onto-a-new-server).

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
- [ ] Before every update: a backup first; then `git pull`, `docker compose build --pull app`,
      `docker compose pull postgres`, `docker compose up -d`; never `docker compose down --volumes`
