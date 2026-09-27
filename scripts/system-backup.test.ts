import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The two scripts against a stand-in `docker` that records each call and plays the database and the
// photo store, so every step and every refusal can be checked without a server. The real round trip,
// against real containers, is the verify:system-backup rehearsal.

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const migration = "20260101000000_rehearsal";

const fakeDocker = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
[ "$1" = compose ] || exit 90
shift
for last; do :; done
live() { [ "\${FAKE_MODE:-}" = backup ] || [ -f "$FAKE_STATE/restored" ]; }
# Windows tar misreads a C:\\ path; Git Bash's cygpath gives it the form it expects.
local_path() { cygpath -u "$1" 2>/dev/null || printf '%s' "$1"; }
case "$*" in
  "ps --status running --services") [ "\${FAKE_APP_RUNNING:-1}" = 1 ] && [ ! -f "$FAKE_STATE/stopped" ] && echo app; exit 0 ;;
  "exec -T postgres pg_dump "*) [ -f "$FAKE_STATE/stopped" ] || exit 92; [ "\${FAKE_DUMP_FAIL:-0}" = 1 ] && exit 3; printf 'PGDMP rehearsal dump\\n'; exit 0 ;;
  "exec -T postgres pg_restore --list") cat > /dev/null; exit 0 ;;
  "exec -T postgres pg_restore "*) [ "\${FAKE_RESTORE_FAIL:-0}" = 1 ] && exit 8; cat > "$FAKE_STATE/restored-dump"; : > "$FAKE_STATE/restored"; exit 0 ;;
  "exec -T postgres createdb "*) exit 0 ;;
  "exec -T app tar -cf "*|"run --rm --no-deps -T --entrypoint tar app --hard-dereference "*) [ -f "$FAKE_STATE/stopped" ] || exit 92; tar --hard-dereference --exclude=./thumbnails --exclude=./restore-staging -cf - -C "$(local_path "$FAKE_PHOTOS")" . ; exit ;;
  "run --rm --no-deps -T --entrypoint tar app --no-same-owner --no-same-permissions -xf "*) tar -xf - -C "$(local_path "$FAKE_RESTORED_PHOTOS")"; exit ;;
  "run --rm --no-deps -T --entrypoint sh app -c "*) printf '%s' "\${FAKE_STORED:-}"; exit 0 ;;
  "stop app") [ "\${FAKE_STOP_FAIL:-0}" = 1 ] && exit 4; : > "$FAKE_STATE/stopped"; exit 0 ;;
  "up "*) rm -f "$FAKE_STATE/stopped"; exit 0 ;;
esac
case "$last" in
  *'"SystemBackupRun"'*) [ "\${FAKE_RECORD_FAIL:-0}" = 1 ] && exit 5; exit 0 ;;
  *_prisma_migrations*) echo "${migration}" ;;
  "DROP DATABASE cubby") exit 0 ;;
  *'"Household"'*) if live; then echo "\${FAKE_HOUSEHOLDS:-2}"; else echo "\${FAKE_EMPTY_HOUSEHOLDS:-0}"; fi ;;
  *'"User"'*) if [ "\${FAKE_LATE_ACCOUNT:-0}" = 1 ] && [ -f "$FAKE_STATE/stopped" ]; then echo 1; elif live; then echo "\${FAKE_ACCOUNTS:-3}"; else echo "\${FAKE_EMPTY_ACCOUNTS:-0}"; fi ;;
  *'"Attachment"'*) echo "\${FAKE_PHOTO_COUNT:-1}" ;;
  *) exit 91 ;;
esac
`;

// Small inert USTAR fixtures; never payloads copied from an installation.
function tarEntry(name: string, data: Buffer = Buffer.alloc(0), type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  for (const [at, width, value] of [[100, 8, 0o600], [108, 8, 1000], [116, 8, 1000], [124, 12, data.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(width - 1, "0") + "\0", at, width, "ascii");
  }
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function syntheticArchive(inner: Buffer, checksumOverride?: string, version = 1) {
  const dump = Buffer.from("PGDMP rehearsal dump\n");
  const manifest = Buffer.from(`format=cubby-system-backup-${version}\ncreated=20260101T000000Z\nrevision=unknown\nmigration=${migration}\nhouseholds=2\naccounts=3\nphotos=1\n`);
  const checksums = checksumOverride ?? [ ["database.dump", dump], ["attachments.tar", inner] ].map(([name, bytes]) => `${createHash("sha256").update(bytes as Buffer).digest("hex")}  ${name}\n`).join("");
  return Buffer.concat([tarEntry("manifest.txt", manifest), tarEntry("checksums.sha256", Buffer.from(checksums)), tarEntry("database.dump", dump), tarEntry("attachments.tar", inner), Buffer.alloc(1024)]);
}
const key = "ab0123456789abcdef0123456789abcd";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function server() {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-system-backup-"));
  directories.push(root);
  const checkout = path.join(root, "cubby");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  const photos = path.join(root, "photos");
  const restoredPhotos = path.join(root, "restored-photos");
  for (const directory of [checkout, state, bin, restoredPhotos, path.join(checkout, "scripts"), path.join(checkout, "prisma", "migrations", migration), path.join(photos, "objects", "ab")]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const script of ["system-backup.sh", "system-restore.sh", "system-maintenance.sh", "system-archive.mjs"]) {
    copyFileSync(path.join(repositoryRoot, "scripts", script), path.join(checkout, "scripts", script));
  }
  writeFileSync(path.join(checkout, "docker-compose.yml"), "services: {}\n");
  writeFileSync(path.join(photos, "objects", "ab", "ab0123456789abcdef0123456789abcd"), "photo bytes");
  for (const directory of ["thumbnails", "restore-staging"]) {
    mkdirSync(path.join(photos, directory));
    writeFileSync(path.join(photos, directory, "not-recovery-truth"), "synthetic transient bytes");
  }
  writeFileSync(path.join(bin, "docker"), fakeDocker);
  chmodSync(path.join(bin, "docker"), 0o755);
  // MSYS mktemp returns /c/... which native Node cannot open when path conversion is disabled.
  // Only this synthetic shim normalizes it; production scripts target Linux.
  writeFileSync(path.join(bin, "mktemp"), '#!/bin/sh\ndirectory=$(/usr/bin/mktemp -d) || exit 1\ncygpath -m "$directory" 2>/dev/null || printf "%s\\n" "$directory"\n');
  chmodSync(path.join(bin, "mktemp"), 0o755);
  const log = path.join(root, "docker.log");
  writeFileSync(log, "");

  const run = (script: string, args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync("sh", [`scripts/${script}`, ...args], {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_LOG: log,
        FAKE_STATE: state,
        FAKE_PHOTOS: photos,
        FAKE_RESTORED_PHOTOS: restoredPhotos,
        ...env
      }
    });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const clearCalls = () => writeFileSync(log, "");
  const archives = (directory = path.join(checkout, "docker-data", "system-backups")) =>
    existsSync(directory) ? readdirSync(directory).sort() : [];
  return { root, checkout, state, restoredPhotos, run, calls, clearCalls, archives };
}

function listTar(file: string, cwd: string) {
  return spawnSync("tar", ["-tf", file], { cwd, encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
}

function backUp(machine: ReturnType<typeof server>, args: string[] = []) {
  const result = machine.run("system-backup.sh", ["--maintenance", ...args], { FAKE_MODE: "backup" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const [archive] = machine.archives();
  return path.join("docker-data", "system-backups", archive!);
}

describe("system backup", () => {
  it("preserves a pre-existing partial directory when refusing a name collision", () => {
    const machine = server();
    // Fixed synthetic clock keeps the collision deterministic.
    const bin = path.join(machine.root, "bin");
    writeFileSync(path.join(bin, "date"), "#!/bin/sh\nprintf '20260101T000000Z\\n'\n");
    chmodSync(path.join(bin, "date"), 0o755);
    const partial = path.join(machine.checkout, "docker-data/system-backups/.cubby-system-20260101T000000Z.partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(path.join(partial, "keep"), "synthetic prior work");
    const result = machine.run("system-backup.sh", ["--maintenance"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(partial, "keep"))).toBe(true);
    expect(machine.calls()).toEqual([]);
  });

  it("shares a fail-closed maintenance lock between backup and restore", () => {
    const machine = server();
    mkdirSync(path.join(machine.checkout, ".cubby-system-maintenance.lock"));
    writeFileSync(path.join(machine.checkout, ".env"), "SYNTHETIC=1\n");
    writeFileSync(path.join(machine.checkout, "input.tar"), syntheticArchive(Buffer.alloc(1024)));
    for (const [script, args] of [["system-backup.sh", ["--maintenance"]], ["system-restore.sh", ["--maintenance", "--confirm-empty-install", "--archive", "input.tar"]]] as const) {
      const result = machine.run(script, [...args]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("maintenance lock is held");
    }
    expect(machine.calls()).toEqual([]);
    expect(existsSync(path.join(machine.checkout, ".cubby-system-maintenance.lock"))).toBe(true);
  });

  it("does not dump after failed stop and leaves failed backup stopped", () => {
    for (const env of [{ FAKE_STOP_FAIL: "1" }, { FAKE_DUMP_FAIL: "1" }]) {
      const machine = server();
      const result = machine.run("system-backup.sh", ["--maintenance"], env);
      expect(result.status).not.toBe(0);
      if (env.FAKE_STOP_FAIL) expect(machine.calls().some((call) => call.includes("pg_dump"))).toBe(false);
      else expect(existsSync(path.join(machine.state, "stopped"))).toBe(true);
      expect(machine.calls()).not.toContain("compose up -d --wait app");
      expect(existsSync(path.join(machine.checkout, ".cubby-system-maintenance.lock"))).toBe(false);
    }
  });

  it("requires explicit downtime consent before calling Docker", () => {
    const machine = server();
    const result = machine.run("system-backup.sh", []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--maintenance");
    expect(machine.calls()).toEqual([]);
  });

  it("excludes writers before dump and holds exclusion through counts", () => {
    const machine = server();
    const result = machine.run("system-backup.sh", ["--maintenance"], { FAKE_MODE: "backup" });
    expect(result.status).toBe(0);
    const calls = machine.calls();
    const stop = calls.indexOf("compose stop app");
    const dump = calls.findIndex((call) => call.includes("pg_dump"));
    const count = calls.findIndex((call) => call.includes('count(*) FROM "User"'));
    const resume = calls.indexOf("compose up -d --wait app");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(dump);
    expect(dump).toBeLessThan(count);
    expect(count).toBeLessThan(resume);
  });

  it("writes one archive of the database, the photos, a manifest and their checksums", () => {
    const machine = server();
    const result = machine.run("system-backup.sh", ["--maintenance"], { FAKE_MODE: "backup" });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^system_backup_created file=\.\/docker-data\/system-backups\/cubby-system-\d{8}T\d{6}Z\.tar bytes=\d+ households=2 accounts=3 photos=1$/m);
    expect(result.stdout).toContain("Copy it off this server");
    const [archive] = machine.archives();
    expect(archive).toMatch(/^cubby-system-\d{8}T\d{6}Z\.tar$/);

    const unpacked = path.join(machine.root, "unpacked");
    mkdirSync(unpacked);
    const archivePath = path.join("docker-data", "system-backups", archive!);
    expect(listTar(archivePath, machine.checkout)).toEqual(["attachments.tar", "checksums.sha256", "database.dump", "manifest.txt"]);
    spawnSync("tar", ["-xf", path.relative(unpacked, path.join(machine.checkout, archivePath)).split(path.sep).join("/")], { cwd: unpacked });
    const manifest = readFileSync(path.join(unpacked, "manifest.txt"), "utf8");
    expect(manifest).toMatch(/^format=cubby-system-backup-2\ncreated=\d{8}T\d{6}Z\nrevision=\S+\nmigration=20260101000000_rehearsal\nhouseholds=2\naccounts=3\nphotos=1\n$/);
    expect(readFileSync(path.join(unpacked, "database.dump"), "utf8")).toBe("PGDMP rehearsal dump\n");
    expect(listTar("attachments.tar", unpacked)).toContain("./objects/ab/ab0123456789abcdef0123456789abcd");
    expect(listTar("attachments.tar", unpacked).some((name) => /thumbnails|restore-staging/.test(name))).toBe(false);
    expect(spawnSync("sha256sum", ["-c", "--quiet", "checksums.sha256"], { cwd: unpacked }).status).toBe(0);
    // The keys to sign in and to read queued email stay out of the archive.
    expect(readFileSync(path.join(machine.checkout, archivePath)).includes(Buffer.from(".env"))).toBe(false);
  });

  it("dumps the database as its superuser inside its container, then reads the photos inside the app's", () => {
    const machine = server();
    backUp(machine);
    const calls = machine.calls();

    expect(calls.indexOf("compose exec -T postgres pg_dump -U cubby_migrator -d cubby --format=custom"))
      .toBeLessThan(calls.indexOf("compose run --rm --no-deps -T --entrypoint tar app --hard-dereference --exclude=./thumbnails --exclude=./restore-staging -cf - -C /var/lib/cubby/attachments ."));
    expect(calls).toContain("compose exec -T postgres pg_restore --list");
  });

  it("reads the photos through a one-off container when Cubby is not running", () => {
    const machine = server();
    machine.run("system-backup.sh", ["--maintenance"], { FAKE_MODE: "backup", FAKE_APP_RUNNING: "0" });
    expect(machine.calls()).toContain("compose run --rm --no-deps -T --entrypoint tar app --hard-dereference --exclude=./thumbnails --exclude=./restore-staging -cf - -C /var/lib/cubby/attachments .");
    expect(machine.archives()).toHaveLength(1);
    expect(machine.calls()).not.toContain("compose up -d --wait app");
  });

  it("leaves nothing behind, not even a partial archive, when the database cannot be dumped", () => {
    const machine = server();
    const result = machine.run("system-backup.sh", ["--maintenance"], { FAKE_MODE: "backup", FAKE_DUMP_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("system_backup_failed: the database could not be dumped");
    expect(machine.archives()).toEqual([]);
  });

  it("records each run for the platform page: what a success made, and why a failure stopped", () => {
    const machine = server();
    backUp(machine);
    const success = machine.calls().find((call) => call.includes('"SystemBackupRun"'));
    expect(success).toMatch(/INSERT INTO "SystemBackupRun" \(status, "archiveName", "byteSize", households, accounts, photos\) VALUES \('succeeded', 'cubby-system-\d{8}T\d{6}Z\.tar', \d+, 2, 3, 1\)/);
    expect(success).toContain(`DELETE FROM "SystemBackupRun" WHERE "recordedAt" < now() - interval '90 days'`);

    const failing = server();
    failing.run("system-backup.sh", ["--maintenance"], { FAKE_MODE: "backup", FAKE_DUMP_FAIL: "1" });
    expect(failing.calls().filter((call) => call.includes('"SystemBackupRun"'))).toEqual([
      `compose exec -T postgres psql -U cubby_migrator -d cubby -XAt -v ON_ERROR_STOP=1 -c INSERT INTO "SystemBackupRun" (status, failure) VALUES ('failed', 'the database could not be dumped; is the postgres service running?')`
    ]);
  });

  it("keeps a good backup when it cannot be recorded, and says so", () => {
    const machine = server();
    const result = machine.run("system-backup.sh", ["--maintenance"], { FAKE_MODE: "backup", FAKE_RECORD_FAIL: "1" });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("system_backup_unrecorded");
    expect(machine.archives()).toHaveLength(1);
  });

  it("keeps the newest archives it made, and never touches any other file", () => {
    const machine = server();
    const directory = path.join(machine.checkout, "docker-data", "system-backups");
    mkdirSync(directory, { recursive: true });
    for (const name of ["cubby-system-20250101T000000Z.tar", "cubby-system-20250102T000000Z.tar", "cubby-system-20250103T000000Z.tar", "notes.txt"]) {
      writeFileSync(path.join(directory, name), "older");
    }
    backUp(machine, ["--keep", "2"]);

    const kept = machine.archives();
    expect(kept).toHaveLength(3);
    expect(kept).toContain("cubby-system-20250103T000000Z.tar");
    expect(kept).toContain("notes.txt");
    expect(kept).not.toContain("cubby-system-20250101T000000Z.tar");
  });

  it("refuses a bad --keep, and to run outside the checkout", () => {
    const machine = server();
    for (const keep of ["0", "two", ""]) {
      const result = machine.run("system-backup.sh", ["--keep", keep], { FAKE_MODE: "backup" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--keep must be a whole number");
    }
    rmSync(path.join(machine.checkout, "docker-compose.yml"));
    expect(machine.run("system-backup.sh", ["--maintenance"], { FAKE_MODE: "backup" }).stderr).toContain("run this from the Cubby checkout");
    expect(machine.calls()).toEqual([]);
  });
});

describe("system restore", () => {
  function prepared() {
    const machine = server();
    const archive = backUp(machine);
    machine.clearCalls();
    writeFileSync(path.join(machine.checkout, ".env"), "SYNTHETIC=1\n");
    return { machine, archive };
  }

  it("checks emptiness only after stopping writers, including a late setup account", () => {
    const { machine, archive } = prepared();
    const result = machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install", "--maintenance"], { FAKE_LATE_ACCOUNT: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("already has accounts or households");
    expect(machine.calls()).toContain("compose stop app");
    expect(machine.calls().some((call) => call.includes("DROP DATABASE"))).toBe(false);
  });

  it("rejects duplicate nested originals before Docker", () => {
    const { machine } = prepared();
    const photo = tarEntry(`./objects/ab/${key}`, Buffer.from("synthetic photo"));
    writeFileSync(path.join(machine.checkout, "duplicate.tar"), syntheticArchive(Buffer.concat([photo, photo, Buffer.alloc(1024)])));
    const result = machine.run("system-restore.sh", ["--archive", "duplicate.tar", "--confirm-empty-install", "--maintenance"]);
    expect(result.status).not.toBe(0);
    expect(machine.calls()).toEqual([]);
  });

  it("rejects incomplete checksum coverage before Docker", () => {
    const { machine } = prepared();
    const inner = Buffer.alloc(1024);
    const sum = createHash("sha256").update("PGDMP rehearsal dump\n").digest("hex");
    writeFileSync(path.join(machine.checkout, "incomplete.tar"), syntheticArchive(inner, `${sum}  database.dump\n`));
    const result = machine.run("system-restore.sh", ["--archive", "incomplete.tar", "--confirm-empty-install", "--maintenance"]);
    expect(result.status).not.toBe(0);
    expect(machine.calls()).toEqual([]);
  });

  it("replaces the new install's empty database with the archived one, puts the photos back, and checks the counts", () => {
    const { machine, archive } = prepared();
    const result = machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install", "--maintenance"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/system_restore_complete households=2 accounts=3 photos=1 from=\d{8}T\d{6}Z/);
    expect(readFileSync(path.join(machine.state, "restored-dump"), "utf8")).toBe("PGDMP rehearsal dump\n");
    expect(readFileSync(path.join(machine.restoredPhotos, "objects", "ab", "ab0123456789abcdef0123456789abcd"), "utf8")).toBe("photo bytes");

    const calls = machine.calls();
    // Files only: a fresh install makes its empty photo folders on start, and those are not photos.
    expect(calls).toContain("compose run --rm --no-deps -T --entrypoint sh app -c find /var/lib/cubby/attachments ! -type d -print -quit");
    const order = [
      "compose up -d --wait postgres app",
      "compose stop app",
      "compose exec -T postgres psql -U cubby_migrator -d postgres -XAt -v ON_ERROR_STOP=1 -c DROP DATABASE cubby",
      "compose exec -T postgres createdb -U cubby_migrator -T template0 cubby",
      "compose exec -T postgres pg_restore -U cubby_migrator -d cubby --exit-on-error --single-transaction",
      "compose run --rm --no-deps -T --entrypoint tar app --no-same-owner --no-same-permissions -xf - -C /var/lib/cubby/attachments",
      "compose up -d --wait app"
    ].map((call) => calls.indexOf(call));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("refuses an install that already has an account, a household or a photo, before changing anything", () => {
    const occupied: Array<Record<string, string>> = [
      { FAKE_EMPTY_ACCOUNTS: "1" },
      { FAKE_EMPTY_HOUSEHOLDS: "1" },
      { FAKE_STORED: "/var/lib/cubby/attachments/objects" }
    ];
    for (const env of occupied) {
      const { machine, archive } = prepared();
      const result = machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install", "--maintenance"], env);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/restore only into a new, empty install/);
      expect(machine.calls().some((call) => call.includes("DROP DATABASE") || call.includes("pg_restore -U"))).toBe(false);
    }
  });

  it("checks the archive before touching Docker: damaged, not a backup, or from a newer Cubby", () => {
    const { machine, archive } = prepared();
    const archivePath = path.join(machine.checkout, archive);
    const bytes = readFileSync(archivePath);
    const damaged = Buffer.from(bytes);
    const at = damaged.indexOf(Buffer.from("PGDMP rehearsal dump"));
    damaged[at + 6] = "X".charCodeAt(0);
    writeFileSync(path.join(machine.checkout, "damaged.tar"), damaged);
    expect(machine.run("system-restore.sh", ["--archive", "damaged.tar", "--confirm-empty-install", "--maintenance"]).stderr).toContain("a checksum does not match");

    writeFileSync(path.join(machine.checkout, "other.txt"), "not a backup");
    spawnSync("tar", ["-cf", "other.tar", "other.txt"], { cwd: machine.checkout });
    expect(machine.run("system-restore.sh", ["--archive", "other.tar", "--confirm-empty-install", "--maintenance"]).stderr).toContain("not a Cubby system backup");

    rmSync(path.join(machine.checkout, "prisma", "migrations", migration), { recursive: true });
    expect(machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install", "--maintenance"]).stderr).toContain("comes from a newer Cubby");

    expect(machine.calls()).toEqual([]);
  });

  it("keeps partial restore and count failures stopped without automatic retry", () => {
    for (const env of [{ FAKE_RESTORE_FAIL: "1" }, { FAKE_PHOTO_COUNT: "9" }]) {
      const { machine, archive } = prepared();
      const result = machine.run("system-restore.sh", ["--maintenance", "--confirm-empty-install", "--archive", archive], env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("app left stopped");
      expect(machine.calls()).not.toContain("compose up -d --wait app");
      expect(existsSync(path.join(machine.state, "stopped"))).toBe(true);
    }
  });

  it("asks for the confirmation and the old server's .env before anything else", () => {
    const { machine, archive } = prepared();
    expect(machine.run("system-restore.sh", ["--archive", archive]).stderr).toContain("--confirm-empty-install");
    rmSync(path.join(machine.checkout, ".env"));
    expect(machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install", "--maintenance"]).stderr).toContain("put the old server's .env");
    expect(machine.run("system-restore.sh", ["--confirm-empty-install", "--maintenance"]).stderr).toContain("name the archive");
    expect(machine.calls()).toEqual([]);
  });
});

describe("closed system archive validator", () => {
  function validate(bytes: Buffer, prepare = false) {
    const machine = server();
    const input = path.join(machine.root, "fixture.tar");
    const output = path.join(machine.root, "validated");
    mkdirSync(output);
    writeFileSync(input, bytes);
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/system-archive.mjs"), prepare ? "prepare" : "check", input, path.join(machine.checkout, "prisma/migrations"), output], { encoding: "utf8" });
    return { result, output, machine };
  }
  const photo = () => tarEntry(`./objects/ab/${key}`, Buffer.from("synthetic"));
  const inner = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
  it.each([1, 2])("accepts v%i and retains durable pending-photo temp ownership", (version) => {
    const pending = `./objects/ab/.${key}.write-v1.tmp`;
    const { result, output } = validate(syntheticArchive(inner(photo(), tarEntry(pending, Buffer.from("pending"))), undefined, version), true);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(listTar("attachments.tar", output)).toEqual([pending, `./objects/ab/${key}`].sort());
  });
  it("validates but discards v1 derivative/upload/legacy-temp bytes", () => {
    const { result, output } = validate(syntheticArchive(inner(photo(),
      tarEntry(`./thumbnails/ab/${key}`, Buffer.from("cache")),
      tarEntry(`./restore-staging/${key}.zip`, Buffer.from("incoming")),
      tarEntry(`./objects/ab/.${key}.0123456789abcdef.tmp`, Buffer.from("legacy"))
    )), true);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(listTar("attachments.tar", output)).toEqual([`./objects/ab/${key}`]);
  });
  it.each(["1", "2", "3", "4", "6", "7", "x", "g", "L", "K", "S"])("rejects unsupported inner type %s", (type) => {
    const { result, output } = validate(syntheticArchive(inner(tarEntry(`./objects/ab/${key}`, Buffer.alloc(0), type))), true);
    expect(result.status).toBe(1);
    expect(readdirSync(output)).toEqual([]);
  });
  it.each([`objects/ab/${key}`, `./objects//ab/${key}`, `./objects/ab/../${key}`, `/objects/ab/${key}`, `./objects/ab/${key}\n`, `./objects/AB/${key}`, `./objects/cd/${key}`, `./objects\\ab\\${key}`, `./objects/ab/${key}/`, `./other/${key}`])("rejects noncanonical name %s", (name) => {
    const { result, output } = validate(syntheticArchive(inner(tarEntry(name))), true);
    expect(result.status).toBe(1);
    expect(readdirSync(output)).toEqual([]);
  });
  it("rejects outer duplicates, aliases, links and malformed physical extents", () => {
    const valid = syntheticArchive(inner(photo()));
    const link = Buffer.from(valid);
    link[156] = 50;
    link.fill(32, 148, 156);
    link.write(link.subarray(0,512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6,"0") + "\0 ",148,8,"ascii");
    for (const bytes of [link, Buffer.concat([valid.subarray(0, -1024), tarEntry("database.dump", Buffer.from("duplicate")), Buffer.alloc(1024)]), Buffer.concat([tarEntry("./manifest.txt", Buffer.from("alias")), valid]), valid.subarray(0, -1), Buffer.concat([valid, photo()]), Buffer.concat([valid, Buffer.alloc(10240)])]) {
      const { result, output } = validate(bytes, true);
      expect(result.status).toBe(1);
      expect(readdirSync(output)).toEqual([]);
    }
  });
  it("accepts bounded GNU positive base-256 sizes without allocating their declared size", () => {
    const entry = photo();
    entry.fill(0, 124, 136);
    entry[124] = 0x80;
    entry[135] = Buffer.byteLength("synthetic");
    entry.fill(32, 148, 156);
    entry.write(entry.subarray(0,512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6,"0") + "\0 ",148,8,"ascii");
    const { result } = validate(syntheticArchive(inner(entry)));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
  it("rejects excessive metadata, overflowing sizes and truncated nested data", () => {
    const huge = photo();
    huge.fill(255, 124, 136);
    huge[124] = 0x80;
    huge.fill(32, 148, 156);
    huge.write(huge.subarray(0,512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6,"0") + "\0 ",148,8,"ascii");
    for (const bytes of [syntheticArchive(inner(huge)), syntheticArchive(photo()), Buffer.concat([tarEntry("manifest.txt", Buffer.alloc(4097, 65)), Buffer.alloc(1024)])]) {
      const { result, output } = validate(bytes, true);
      expect(result.status).toBe(1);
      expect(readdirSync(output)).toEqual([]);
    }
  });

  it("rejects special permission bits before extracting", () => {
    const entry = photo();
    entry.write("0004600\0", 100, 8, "ascii");
    entry.fill(32, 148, 156);
    entry.write(entry.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    const { result, output } = validate(syntheticArchive(inner(entry)), true);
    expect(result.status).toBe(1);
    expect(readdirSync(output)).toEqual([]);
  });

  it("rejects invalid manifest fields and checksum targets", () => {
    const valid = syntheticArchive(inner(photo()));
    for (const [from, to] of [["migration=20260101000000_rehearsal", "migration=../../../../outside___"], ["households=2", "households=x"], ["20260101T000000Z", "20269999T000000Z"], ["revision=unknown", "revision=../oops"], ["backup-1", "backup-9"], ["  database.dump\n", "  ../other.dump\n"]]) {
      const bytes = Buffer.from(valid);
      const at = bytes.indexOf(Buffer.from(from));
      expect(at).toBeGreaterThan(0);
      bytes.write(to, at, "ascii");
      const { result, output } = validate(bytes, true);
      expect(result.status).toBe(1);
      expect(readdirSync(output)).toEqual([]);
    }
  });
});
