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
  "ps --status running --services") [ "\${FAKE_APP_RUNNING:-1}" = 1 ] && echo app; exit 0 ;;
  "exec -T postgres pg_dump "*) [ "\${FAKE_DUMP_FAIL:-0}" = 1 ] && exit 3; printf 'PGDMP rehearsal dump\\n'; exit 0 ;;
  "exec -T postgres pg_restore --list") cat > /dev/null; exit 0 ;;
  "exec -T postgres pg_restore "*) cat > "$FAKE_STATE/restored-dump"; : > "$FAKE_STATE/restored"; exit 0 ;;
  "exec -T postgres createdb "*) exit 0 ;;
  "exec -T app tar -cf "*|"run --rm --no-deps -T --entrypoint tar app -cf "*) tar -cf - -C "$(local_path "$FAKE_PHOTOS")" . ; exit ;;
  "run --rm --no-deps -T --entrypoint tar app -xf "*) tar -xf - -C "$(local_path "$FAKE_RESTORED_PHOTOS")"; exit ;;
  "exec -T app sh -c "*) printf '%s' "\${FAKE_STORED:-}"; exit 0 ;;
  "up "*|"stop "*) exit 0 ;;
esac
case "$last" in
  *_prisma_migrations*) echo "${migration}" ;;
  "DROP DATABASE cubby") exit 0 ;;
  *'"Household"'*) if live; then echo "\${FAKE_HOUSEHOLDS:-2}"; else echo "\${FAKE_EMPTY_HOUSEHOLDS:-0}"; fi ;;
  *'"User"'*) if live; then echo "\${FAKE_ACCOUNTS:-3}"; else echo "\${FAKE_EMPTY_ACCOUNTS:-0}"; fi ;;
  *'"Attachment"'*) echo "\${FAKE_PHOTO_COUNT:-1}" ;;
  *) exit 91 ;;
esac
`;

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
  for (const script of ["system-backup.sh", "system-restore.sh"]) {
    copyFileSync(path.join(repositoryRoot, "scripts", script), path.join(checkout, "scripts", script));
  }
  writeFileSync(path.join(checkout, "docker-compose.yml"), "services: {}\n");
  writeFileSync(path.join(photos, "objects", "ab", "ab0123456789abcdef0123456789abcd"), "photo bytes");
  writeFileSync(path.join(bin, "docker"), fakeDocker);
  chmodSync(path.join(bin, "docker"), 0o755);
  const log = path.join(root, "docker.log");
  writeFileSync(log, "");

  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
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
  const result = machine.run("system-backup.sh", args, { FAKE_MODE: "backup" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const [archive] = machine.archives();
  return path.join("docker-data", "system-backups", archive!);
}

describe("system backup", () => {
  it("writes one archive of the database, the photos, a manifest and their checksums", () => {
    const machine = server();
    const result = machine.run("system-backup.sh", [], { FAKE_MODE: "backup" });

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
    expect(manifest).toMatch(/^format=cubby-system-backup-1\ncreated=\d{8}T\d{6}Z\nrevision=\S+\nmigration=20260101000000_rehearsal\nhouseholds=2\naccounts=3\nphotos=1\n$/);
    expect(readFileSync(path.join(unpacked, "database.dump"), "utf8")).toBe("PGDMP rehearsal dump\n");
    expect(listTar("attachments.tar", unpacked)).toContain("./objects/ab/ab0123456789abcdef0123456789abcd");
    expect(spawnSync("sha256sum", ["-c", "--quiet", "checksums.sha256"], { cwd: unpacked }).status).toBe(0);
    // The keys to sign in and to read queued email stay out of the archive.
    expect(readFileSync(path.join(machine.checkout, archivePath)).includes(Buffer.from(".env"))).toBe(false);
  });

  it("dumps the database as its superuser inside its container, then reads the photos inside the app's", () => {
    const machine = server();
    backUp(machine);
    const calls = machine.calls();

    expect(calls.indexOf("compose exec -T postgres pg_dump -U cubby_migrator -d cubby --format=custom"))
      .toBeLessThan(calls.indexOf("compose exec -T app tar -cf - -C /var/lib/cubby/attachments ."));
    expect(calls).toContain("compose exec -T postgres pg_restore --list");
  });

  it("reads the photos through a one-off container when Cubby is not running", () => {
    const machine = server();
    machine.run("system-backup.sh", [], { FAKE_MODE: "backup", FAKE_APP_RUNNING: "0" });
    expect(machine.calls()).toContain("compose run --rm --no-deps -T --entrypoint tar app -cf - -C /var/lib/cubby/attachments .");
    expect(machine.archives()).toHaveLength(1);
  });

  it("leaves nothing behind, not even a partial archive, when the database cannot be dumped", () => {
    const machine = server();
    const result = machine.run("system-backup.sh", [], { FAKE_MODE: "backup", FAKE_DUMP_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("system_backup_failed: the database could not be dumped");
    expect(machine.archives()).toEqual([]);
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
    expect(machine.run("system-backup.sh", [], { FAKE_MODE: "backup" }).stderr).toContain("run this from the Cubby checkout");
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

  it("replaces the new install's empty database with the archived one, puts the photos back, and checks the counts", () => {
    const { machine, archive } = prepared();
    const result = machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/system_restore_complete households=2 accounts=3 photos=1 from=\d{8}T\d{6}Z/);
    expect(readFileSync(path.join(machine.state, "restored-dump"), "utf8")).toBe("PGDMP rehearsal dump\n");
    expect(readFileSync(path.join(machine.restoredPhotos, "objects", "ab", "ab0123456789abcdef0123456789abcd"), "utf8")).toBe("photo bytes");

    const calls = machine.calls();
    const order = [
      "compose up -d --wait postgres app",
      "compose stop app",
      "compose exec -T postgres psql -U cubby_migrator -d postgres -XAt -v ON_ERROR_STOP=1 -c DROP DATABASE cubby",
      "compose exec -T postgres createdb -U cubby_migrator -T template0 cubby",
      "compose exec -T postgres pg_restore -U cubby_migrator -d cubby --exit-on-error --single-transaction",
      "compose run --rm --no-deps -T --entrypoint tar app -xf - -C /var/lib/cubby/attachments",
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
      const result = machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install"], env);

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
    expect(machine.run("system-restore.sh", ["--archive", "damaged.tar", "--confirm-empty-install"]).stderr).toContain("a checksum does not match");

    writeFileSync(path.join(machine.checkout, "other.txt"), "not a backup");
    spawnSync("tar", ["-cf", "other.tar", "other.txt"], { cwd: machine.checkout });
    expect(machine.run("system-restore.sh", ["--archive", "other.tar", "--confirm-empty-install"]).stderr).toContain("not a Cubby system backup");

    rmSync(path.join(machine.checkout, "prisma", "migrations", migration), { recursive: true });
    expect(machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install"]).stderr).toContain("comes from a newer Cubby");

    expect(machine.calls()).toEqual([]);
  });

  it("asks for the confirmation and the old server's .env before anything else", () => {
    const { machine, archive } = prepared();
    expect(machine.run("system-restore.sh", ["--archive", archive]).stderr).toContain("--confirm-empty-install");
    rmSync(path.join(machine.checkout, ".env"));
    expect(machine.run("system-restore.sh", ["--archive", archive, "--confirm-empty-install"]).stderr).toContain("put the old server's .env");
    expect(machine.run("system-restore.sh", ["--confirm-empty-install"]).stderr).toContain("name the archive");
    expect(machine.calls()).toEqual([]);
  });
});
