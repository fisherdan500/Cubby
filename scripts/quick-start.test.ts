import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const compose = readFileSync(path.join(repositoryRoot, "docker-compose.yml"), "utf8");
const envExample = readFileSync(path.join(repositoryRoot, ".env.example"), "utf8");
const scriptPath = path.join(repositoryRoot, "scripts", "quick-start.sh");

/** Every variable `docker compose` refuses to start without, read from its `${NAME:?...}` references. */
const composeRequired = [...new Set([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map(([, name]) => name!))];

// Keys the app and its entrypoint cannot start without, beyond what Compose itself interpolates.
const appRequired = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CUBBY_FRESH_AUTH_ATTESTATION_KEYRING",
  "CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION",
  "CUBBY_EMAIL_DELIVERY_KEYRING",
  "CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION"
];

function keys(text: string) {
  return new Set([...text.matchAll(/^([A-Z0-9_]+)=/gm)].map(([, name]) => name!));
}

function parseEnv(text: string) {
  return Object.fromEntries([...text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map(([, name, value]) => [name!, value!.trim()]));
}

const checkouts: string[] = [];

afterEach(() => {
  for (const directory of checkouts.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkout() {
  const directory = mkdtempSync(path.join(tmpdir(), "cubby-quick-start-"));
  checkouts.push(directory);
  mkdirSync(path.join(directory, "scripts"));
  copyFileSync(scriptPath, path.join(directory, "scripts", "quick-start.sh"));
  return directory;
}

function currentOwner() {
  const id = spawnSync("sh", ["-c", "printf '%s:%s' \"$(id -u)\" \"$(id -g)\""], { encoding: "utf8" });
  return id.stdout;
}

function runQuickStart(directory: string, args: string[]) {
  return spawnSync("sh", ["scripts/quick-start.sh", ...args], { cwd: directory, encoding: "utf8" });
}

describe("fresh-server environment template", () => {
  it("names every variable Compose requires, and every key the app cannot start without", () => {
    expect(composeRequired.length).toBeGreaterThan(5);
    const template = keys(envExample);
    expect([...composeRequired, ...appRequired].filter((name) => !template.has(name))).toEqual([]);
  });

  it("points the Sprout key secret at the file the quick start writes, not an example path", () => {
    expect(parseEnv(envExample).CUBBY_SPROUT_STAGING_KEY_FILE).toBe("./docker-data/secrets/sprout-staging.key");
  });
});

describe("scripts/quick-start.sh", () => {
  it("writes a complete .env with a fresh, well-formed value for every required key", () => {
    const directory = checkout();

    const result = runQuickStart(directory, ["--url", "https://cubby.example.test", "--data-owner", currentOwner()]);

    expect(result.status, result.stderr).toBe(0);
    const generated = parseEnv(readFileSync(path.join(directory, ".env"), "utf8"));
    expect([...composeRequired, ...appRequired].filter((name) => !generated[name])).toEqual([]);
    expect(generated.BETTER_AUTH_URL).toBe("https://cubby.example.test");
    expect(generated.TRUSTED_ORIGINS).toBe("https://cubby.example.test");
    expect(generated.APP_PORT).toBe("3000");
    expect(generated.CUBBY_TRUSTED_PROXY_HOPS).toBe("0");
    expect(generated.CUBBY_THROTTLE_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(generated.CUBBY_THROTTLE_KEY!, "base64url")).toHaveLength(32);
    for (const keyring of ["CUBBY_FRESH_AUTH_ATTESTATION_KEYRING", "CUBBY_EMAIL_DELIVERY_KEYRING"]) {
      const [version, encoded] = generated[keyring]!.split(":");
      expect(version).toBe("1");
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(encoded!, "base64url")).toHaveLength(32);
    }
    expect(generated.BETTER_AUTH_SECRET!.length).toBeGreaterThanOrEqual(32);
    const passwords = Object.entries(generated).filter(([name]) => name.endsWith("_DB_PASSWORD")).map(([, value]) => value);
    expect(passwords.length).toBe(8);
    for (const password of passwords) expect(password).toMatch(/^[0-9a-f]{64}$/);
    // Each secret is its own draw, never a copy of another.
    expect(new Set(passwords).size).toBe(passwords.length);
  });

  it("writes the Sprout staging key in the form the app reads, and prints no secret", () => {
    const directory = checkout();

    const result = runQuickStart(directory, ["--data-owner", currentOwner()]);

    expect(result.status, result.stderr).toBe(0);
    const keyFile = path.join(directory, "docker-data", "secrets", "sprout-staging.key");
    const raw = readFileSync(keyFile, "utf8").trim();
    expect(Buffer.from(raw, "base64")).toHaveLength(32);
    expect(Buffer.from(raw, "base64").toString("base64")).toBe(raw);
    const generated = parseEnv(readFileSync(path.join(directory, ".env"), "utf8"));
    for (const value of [raw, generated.BETTER_AUTH_SECRET, generated.CUBBY_THROTTLE_KEY, generated.CUBBY_RUNTIME_DB_PASSWORD]) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }
  });

  it("creates the data directories the container writes to", () => {
    const directory = checkout();

    const result = runQuickStart(directory, ["--data-owner", currentOwner()]);

    expect(result.status, result.stderr).toBe(0);
    for (const name of ["backups", "sprout-staging", "secrets"]) {
      expect(statSync(path.join(directory, "docker-data", name)).isDirectory()).toBe(true);
    }
  });

  it("uses the URL's own port for a direct address and keeps 3000 behind a proxy", () => {
    const direct = checkout();
    expect(runQuickStart(direct, ["--url", "http://192.168.1.50:3002", "--data-owner", currentOwner()]).status).toBe(0);
    expect(parseEnv(readFileSync(path.join(direct, ".env"), "utf8")).APP_PORT).toBe("3002");
  });

  it("publishes port 80 for a plain http address with no port, which is where a browser goes", () => {
    const directory = checkout();
    expect(runQuickStart(directory, ["--url", "http://192.168.1.50", "--data-owner", currentOwner()]).status).toBe(0);
    expect(parseEnv(readFileSync(path.join(directory, ".env"), "utf8")).APP_PORT).toBe("80");
  });

  it("lower-cases the address, because browsers send the origin in lower case", () => {
    const directory = checkout();
    expect(runQuickStart(directory, ["--url", "HTTPS://Cubby.Example.TEST", "--data-owner", currentOwner()]).status).toBe(0);
    const generated = parseEnv(readFileSync(path.join(directory, ".env"), "utf8"));
    expect(generated.BETTER_AUTH_URL).toBe("https://cubby.example.test");
    expect(generated.TRUSTED_ORIGINS).toBe("https://cubby.example.test");
  });

  it("leaves no partly written secret file outside the ignored data directory", () => {
    const directory = checkout();
    expect(runQuickStart(directory, ["--data-owner", currentOwner()]).status).toBe(0);
    expect(readdirSync(directory).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("never overwrites an existing install's secrets", () => {
    const directory = checkout();
    writeFileSync(path.join(directory, ".env"), "BETTER_AUTH_SECRET=keep-me\n");

    const result = runQuickStart(directory, ["--data-owner", currentOwner()]);

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(directory, ".env"), "utf8")).toBe("BETTER_AUTH_SECRET=keep-me\n");
    expect(existsSync(path.join(directory, "docker-data", "secrets", "sprout-staging.key"))).toBe(false);
  });

  it.each([
    ["a URL with a path", ["--url", "https://cubby.example.test/app"]],
    ["a URL without a scheme", ["--url", "cubby.example.test"]],
    ["an invalid proxy hop count", ["--trusted-proxy-hops", "2"]],
    ["a malformed owner", ["--data-owner", "node"]],
    ["an unknown option", ["--yolo"]]
  ])("refuses %s before writing anything", (_label, args) => {
    const directory = checkout();

    const result = runQuickStart(directory, args);

    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(directory, ".env"))).toBe(false);
    expect(existsSync(path.join(directory, "docker-data"))).toBe(false);
  });
});
