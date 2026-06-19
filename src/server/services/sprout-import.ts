import { createHash } from "crypto";
import path from "path";
import type { SqlJsStatic } from "sql.js";
import JSZip from "jszip";
import {
  ActivityType,
  DiaperKind,
  FeedingKind,
  MilkInventoryAction,
  NursingSide,
  TimerState,
  type Prisma
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { zonedDateStart } from "@/lib/timezone";
import { getHouseholdContext, requirePermission, type HouseholdContext } from "@/server/auth/context";
import { durationSeconds } from "@/lib/dates";

type SproutRow = Record<string, unknown>;
type SproutTables = Record<string, SproutRow[]>;

type ParsedSproutBackup = {
  filename?: string;
  format: "sqlite" | "json";
  tables: SproutTables;
  env: {
    present: boolean;
    encHashPresent: boolean;
  };
  warnings: string[];
};

type ImportKey = {
  sourceTable: string;
  sourceId: string;
};

type ImportMaps = {
  babies: Map<string, string>;
  contacts: Map<string, string>;
  medicines: Map<string, { id?: string; name: string; isSupplement: boolean; unit?: string }>;
  caretakers: Map<string, string>;
  vaccines: Map<string, string>;
};

type ImportCounters = {
  created: number;
  skipped: number;
  babies: number;
  contacts: number;
  medicines: number;
  activities: number;
  calendarEvents: number;
  vaccineDocuments: number;
  warnings: string[];
};

const SOURCE_SYSTEM = "sprout-track";
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const ACTIVITY_TABLES = [
  "SleepLog",
  "FeedLog",
  "DiaperLog",
  "MoodLog",
  "Note",
  "Milestone",
  "PumpLog",
  "BreastMilkAdjustment",
  "PlayLog",
  "BathLog",
  "Measurement",
  "MedicineLog",
  "VaccineLog"
] as const;

const SECRET_OR_RUNTIME_TABLES = new Set([
  "Account",
  "ApiKey",
  "AppConfig",
  "EmailConfig",
  "NotificationConfig",
  "PushSubscription",
  "NotificationPreference",
  "NotificationLog",
  "Session",
  "Verification",
  "Feedback",
  "FeedbackAttachment",
  "BetaSubscriber",
  "BetaCampaign",
  "BetaCampaignEmail"
]);

let sqlReady: Promise<SqlJsStatic> | undefined;

function getSql() {
  sqlReady ??= loadSqlJs();
  return sqlReady;
}

async function getRuntimeRequire() {
  try {
    // Webpack can replace normal require/createRequire in route chunks; module.require stays Node-backed.
    // eslint-disable-next-line no-eval
    const nodeRequire = eval("module.require.bind(module)") as NodeJS.Require;
    if (typeof nodeRequire === "function") {
      return nodeRequire;
    }
  } catch {
    // ESM test runners do not expose CommonJS module; fall through to other Node fallbacks.
  }

  try {
    // Keep this server-only require out of the Next route bundle so sql.js can load from runtime node_modules.
    // eslint-disable-next-line no-eval
    const nodeRequire = (0, eval)("require") as NodeJS.Require;
    if (typeof nodeRequire === "function") {
      return nodeRequire;
    }
  } catch {
    // ESM test runners do not expose require; fall through to Node's createRequire fallback.
  }

  const { createRequire } = await import("module");
  return createRequire(import.meta.url);
}

function loadSqlJs() {
  const wasmDir = path.join(process.cwd(), "node_modules", "sql.js", "dist");
  const loaderPath = path.join(wasmDir, "sql-wasm.js");

  return getRuntimeRequire().then((runtimeRequire) => {
    const initSqlJs = runtimeRequire(loaderPath) as (config: {
      locateFile: (file: string) => string;
    }) => Promise<SqlJsStatic>;
    return initSqlJs({
      locateFile: (file) => path.join(wasmDir, file)
    });
  }).catch((error) => {
    console.error("Failed to load or initialize sql.js for Sprout import", { loaderPath, wasmDir, error });
    throw new Error("sprout_sqlite_unavailable");
  });
}

function rows(tables: SproutTables, name: string) {
  return tables[name] ?? [];
}

function isImportable(row: SproutRow) {
  return !row.deletedAt;
}

function value(row: SproutRow, key: string) {
  return row[key];
}

function text(row: SproutRow, key: string) {
  const raw = value(row, key);
  if (raw === null || raw === undefined) return undefined;
  const next = String(raw).trim();
  return next || undefined;
}

function numberValue(row: SproutRow, key: string) {
  const raw = value(row, key);
  if (raw === null || raw === undefined || raw === "") return undefined;
  const next = Number(raw);
  return Number.isFinite(next) ? next : undefined;
}

function boolValue(row: SproutRow, key: string) {
  const raw = value(row, key);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") return ["1", "true", "yes"].includes(raw.toLowerCase());
  return false;
}

function dateValue(row: SproutRow, key: string) {
  return parseSproutDateForImport(value(row, key));
}

function parseSproutDateForImport(raw: unknown) {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw === "number") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const value = String(raw).trim();
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return zonedDateStart(value, env.APP_TIMEZONE);
  }
  const normalized = normalizeSproutDateTime(value);
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeSproutDateTime(value: string) {
  const normalized = value.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");
  const isIsoLikeDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(normalized);
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return isIsoLikeDateTime && !hasExplicitZone ? `${normalized}Z` : normalized;
}

function requiredDate(row: SproutRow, keys: string[], fallback = new Date()) {
  for (const key of keys) {
    const date = dateValue(row, key);
    if (date) return date;
  }
  return fallback;
}

function sourceId(row: SproutRow, table: string, index: number) {
  return text(row, "id") ?? createHash("sha256").update(`${table}:${index}:${stableJson(row)}`).digest("hex");
}

function stableJson(value: unknown) {
  return JSON.stringify(value, Object.keys((value as Record<string, unknown>) ?? {}).sort());
}

function checksum(row: SproutRow) {
  return createHash("sha256").update(stableJson(row)).digest("hex");
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function birthKey(date?: Date | null) {
  return date ? date.toISOString().slice(0, 10) : "";
}

function babyName(row: SproutRow) {
  const combined = [text(row, "firstName"), text(row, "lastName")].filter(Boolean).join(" ").trim();
  return combined || text(row, "name") || "Imported baby";
}

function parseWarningMinutes(raw: unknown) {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  const value = String(raw).trim();
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : undefined;
}

function appendNotes(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join("\n\n") || undefined;
}

function enumText(row: SproutRow, key: string) {
  return text(row, key)?.toUpperCase();
}

function unit(row: SproutRow, key = "unitAbbr") {
  return text(row, key)?.toLowerCase();
}

function firstText(row: SproutRow, keys: string[]) {
  for (const key of keys) {
    const next = text(row, key);
    if (next) return next;
  }
  return undefined;
}

function firstNumber(row: SproutRow, keys: string[]) {
  for (const key of keys) {
    const next = numberValue(row, key);
    if (next !== undefined) return next;
  }
  return undefined;
}

function mapDiaperKind(kind?: string) {
  if (kind === "WET") return DiaperKind.wet;
  if (kind === "DIRTY") return DiaperKind.dirty;
  if (kind === "BOTH") return DiaperKind.mixed;
  return DiaperKind.dry;
}

function mapNursingSide(side?: string) {
  if (side === "LEFT") return NursingSide.left;
  if (side === "RIGHT") return NursingSide.right;
  if (side === "BOTH") return NursingSide.both;
  return undefined;
}

function mapMilkAction(value?: string, amount?: number) {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("fed")) return MilkInventoryAction.fed;
  if (normalized.includes("discard")) return MilkInventoryAction.discarded;
  if (normalized.includes("expired")) return MilkInventoryAction.expired;
  if (normalized.includes("donat")) return MilkInventoryAction.donated;
  if (normalized.includes("thaw")) return MilkInventoryAction.thawed;
  return amount !== undefined && amount < 0 ? MilkInventoryAction.discarded : MilkInventoryAction.stored;
}

function mapFeedingMode(row: SproutRow) {
  const type = enumText(row, "type");
  if (type === "BREAST") return FeedingKind.breast;
  if (type === "SOLIDS") return FeedingKind.solids;
  const bottleType = text(row, "bottleType")?.toLowerCase() ?? "";
  if (bottleType.includes("formula") && !bottleType.includes("breast")) return FeedingKind.formula;
  return FeedingKind.bottle;
}

function mapMeasurement(row: SproutRow) {
  const measurementType = enumText(row, "type");
  const amount = numberValue(row, "value");
  const measurementUnit = unit(row, "unit") ?? text(row, "unit");
  if (measurementType === "WEIGHT") {
    return { weight: amount, weightUnit: measurementUnit, measurementType: "weight" };
  }
  if (measurementType === "HEIGHT" || measurementType === "LENGTH") {
    return { length: amount, lengthUnit: measurementUnit, measurementType: "length" };
  }
  if (measurementType === "HEAD_CIRCUMFERENCE") {
    return { headCircumference: amount, headUnit: measurementUnit, measurementType: "head" };
  }
  if (measurementType === "TEMPERATURE") {
    return { temperature: amount, temperatureUnit: measurementUnit, measurementType: "temperature" };
  }
  return { measurementType: text(row, "type") };
}

async function parseUpload(formData: FormData) {
  const file = formData.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") throw new Error("missing_file");
  if (file.size > MAX_IMPORT_BYTES) throw new Error("file_too_large");
  const bytes = Buffer.from(await file.arrayBuffer());
  return parseSproutBackup(bytes, file.name);
}

async function parseSproutBackup(bytes: Buffer, filename?: string): Promise<ParsedSproutBackup> {
  const warnings: string[] = [];
  if (filename?.toLowerCase().endsWith(".zip") || looksLikeZip(bytes)) {
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    const dbEntry = entries.find((entry) => entry.name.split(/[\\/]/).pop() === "baby-tracker.db");
    const jsonEntry = entries.find((entry) => entry.name.split(/[\\/]/).pop() === "data.json");
    const envEntry = entries.find((entry) => entry.name.toLowerCase().endsWith(".env"));
    const envText = envEntry ? await envEntry.async("string") : undefined;
    if (dbEntry) {
      const dbBytes = Buffer.from(await dbEntry.async("uint8array"));
      validateSqlite(dbBytes);
      return {
        filename,
        format: "sqlite",
        tables: await tablesFromSqlite(dbBytes),
        env: parseEnv(envText),
        warnings
      };
    }
    if (jsonEntry) {
      const jsonText = await jsonEntry.async("string");
      return {
        filename,
        format: "json",
        tables: tablesFromJson(JSON.parse(jsonText)),
        env: parseEnv(envText),
        warnings
      };
    }
    throw new Error("unsupported_sprout_backup");
  }

  if (filename?.toLowerCase().endsWith(".json")) {
    return {
      filename,
      format: "json",
      tables: tablesFromJson(JSON.parse(bytes.toString("utf8"))),
      env: parseEnv(undefined),
      warnings
    };
  }

  validateSqlite(bytes);
  return {
    filename,
    format: "sqlite",
    tables: await tablesFromSqlite(bytes),
    env: parseEnv(undefined),
    warnings
  };
}

function looksLikeZip(bytes: Buffer) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function validateSqlite(bytes: Buffer) {
  if (bytes.length < 16 || bytes.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000") {
    throw new Error("invalid_sqlite_backup");
  }
}

function parseEnv(raw?: string) {
  return {
    present: Boolean(raw),
    encHashPresent: Boolean(raw && /^ENC_HASH=/m.test(raw))
  };
}

async function tablesFromSqlite(bytes: Buffer): Promise<SproutTables> {
  const SQL = await getSql();
  const db = new SQL.Database(new Uint8Array(bytes));
  try {
    const tableResult = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'"
    )[0];
    const tableNames = tableResult?.values.map((row) => String(row[0])) ?? [];
    const output: SproutTables = {};
    for (const tableName of tableNames) {
      const result = db.exec(`SELECT * FROM ${quoteIdentifier(tableName)}`)[0];
      output[tableName] = result
        ? result.values.map((values) =>
            Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null]))
          )
        : [];
    }
    return output;
  } finally {
    db.close();
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function tablesFromJson(raw: unknown): SproutTables {
  const root = raw as Record<string, unknown>;
  const candidate = (root.data ?? root.tables ?? root) as Record<string, unknown>;
  const output: SproutTables = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (Array.isArray(value)) output[key] = value.filter((row): row is SproutRow => row && typeof row === "object") as SproutRow[];
  }
  return output;
}

function makeSummary(parsed: ParsedSproutBackup, duplicateCount: number) {
  const tables = parsed.tables;
  const activityCounts: Record<string, number> = {};
  for (const table of ACTIVITY_TABLES) {
    const count = rows(tables, table).filter(isImportable).length;
    if (count > 0) activityCounts[table] = count;
  }
  const skippedTables = Object.fromEntries(
    Object.entries(tables)
      .filter(([table, tableRows]) => SECRET_OR_RUNTIME_TABLES.has(table) && tableRows.length > 0)
      .map(([table, tableRows]) => [table, tableRows.length])
  );
  const warningMessages = [...parsed.warnings];
  if (Object.keys(skippedTables).length) {
    warningMessages.push("Sprout auth, API key, push, email, and runtime tables are skipped for safety.");
  }
  if (rows(tables, "VaccineDocument").length) {
    warningMessages.push("Vaccine document metadata can be imported, but encrypted file bytes are not included in normal Sprout database backups.");
  }

  return {
    source: {
      filename: parsed.filename,
      format: parsed.format,
      envPresent: parsed.env.present,
      encHashPresent: parsed.env.encHashPresent
    },
    counts: {
      families: rows(tables, "Family").filter(isImportable).length,
      babies: rows(tables, "Baby").filter(isImportable).length,
      caretakers: rows(tables, "Caretaker").filter(isImportable).length,
      activities: Object.values(activityCounts).reduce((total, count) => total + Number(count), 0),
      contacts: rows(tables, "Contact").filter(isImportable).length,
      medicines: rows(tables, "Medicine").filter(isImportable).length,
      calendarEvents: rows(tables, "CalendarEvent").filter(isImportable).length,
      vaccineDocuments: rows(tables, "VaccineDocument").filter(isImportable).length,
      duplicates: duplicateCount
    },
    activityCounts,
    skippedTables,
    warnings: warningMessages
  };
}

function importKeys(parsed: ParsedSproutBackup): ImportKey[] {
  const keys: ImportKey[] = [];
  for (const table of ["Baby", "Contact", "Medicine", "CalendarEvent", "VaccineDocument", ...ACTIVITY_TABLES]) {
    rows(parsed.tables, table).forEach((row, index) => {
      if (!isImportable(row)) return;
      keys.push({ sourceTable: table, sourceId: sourceId(row, table, index) });
    });
  }
  return keys;
}

async function countDuplicates(ctx: HouseholdContext, keys: ImportKey[]) {
  let total = 0;
  for (const table of new Set(keys.map((key) => key.sourceTable))) {
    const ids = keys.filter((key) => key.sourceTable === table).map((key) => key.sourceId);
    if (!ids.length) continue;
    total += await prisma.importedRecord.count({
      where: {
        householdId: ctx.householdId,
        sourceSystem: SOURCE_SYSTEM,
        sourceTable: table,
        sourceId: { in: ids }
      }
    });
  }
  return total;
}

export async function previewSproutBackup(formData: FormData) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const parsed = await parseUpload(formData);
  const duplicates = await countDuplicates(ctx, importKeys(parsed));
  return makeSummary(parsed, duplicates);
}

export async function importSproutBackup(formData: FormData) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const parsed = await parseUpload(formData);
  const duplicateCount = await countDuplicates(ctx, importKeys(parsed));
  const summary = makeSummary(parsed, duplicateCount);
  const batch = await prisma.importBatch.create({
    data: {
      householdId: ctx.householdId,
      actorUserId: ctx.userId,
      sourceSystem: SOURCE_SYSTEM,
      sourceFilename: parsed.filename,
      sourceFormat: parsed.format,
      status: "running",
      summary: summary as Prisma.InputJsonValue,
      warnings: summary.warnings
    }
  });

  try {
    const result = await commitSproutImport(ctx, parsed, batch.id);
    const finalSummary = { ...summary, result };
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "complete",
        completedAt: new Date(),
        summary: finalSummary as Prisma.InputJsonValue,
        warnings: [...summary.warnings, ...result.warnings]
      }
    });
    await prisma.backupRecord.create({
      data: {
        householdId: ctx.householdId,
        actorUserId: ctx.userId,
        kind: "sprout_import",
        status: "complete",
        itemCount: result.created,
        checksum: createHash("sha256").update(JSON.stringify(finalSummary)).digest("hex")
      }
    });
    return finalSummary;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: "failed", completedAt: new Date(), error: message }
    });
    await prisma.backupRecord.create({
      data: {
        householdId: ctx.householdId,
        actorUserId: ctx.userId,
        kind: "sprout_import",
        status: "failed",
        error: message
      }
    });
    throw error;
  }
}

async function commitSproutImport(ctx: HouseholdContext, parsed: ParsedSproutBackup, batchId: string) {
  const maps: ImportMaps = {
    babies: new Map(),
    contacts: new Map(),
    medicines: new Map(),
    caretakers: buildCaretakerMap(parsed.tables),
    vaccines: new Map()
  };
  const counters = {
    created: 0,
    skipped: 0,
    babies: 0,
    contacts: 0,
    medicines: 0,
    activities: 0,
    calendarEvents: 0,
    vaccineDocuments: 0,
    warnings: [] as string[]
  };

  await importBabies(ctx, parsed.tables, batchId, maps, counters);
  await importContacts(ctx, parsed.tables, batchId, maps, counters);
  await importMedicines(ctx, parsed.tables, batchId, maps, counters);
  await importActivities(ctx, parsed.tables, batchId, maps, counters);
  await importCalendarEvents(ctx, parsed.tables, batchId, maps, counters);
  await importVaccineDocuments(ctx, parsed.tables, batchId, maps, counters);

  return counters;
}

function buildCaretakerMap(tables: SproutTables) {
  const map = new Map<string, string>();
  rows(tables, "Caretaker").forEach((row, index) => {
    map.set(sourceId(row, "Caretaker", index), text(row, "name") ?? text(row, "loginId") ?? "Sprout caretaker");
  });
  return map;
}

async function importedRecord(ctx: HouseholdContext, table: string, id: string) {
  return prisma.importedRecord.findUnique({
    where: {
      householdId_sourceSystem_sourceTable_sourceId: {
        householdId: ctx.householdId,
        sourceSystem: SOURCE_SYSTEM,
        sourceTable: table,
        sourceId: id
      }
    }
  });
}

async function rememberImported(
  ctx: HouseholdContext,
  batchId: string,
  table: string,
  id: string,
  targetType: string,
  targetId: string,
  row?: SproutRow
) {
  await prisma.importedRecord
    .create({
      data: {
        householdId: ctx.householdId,
        importBatchId: batchId,
        sourceSystem: SOURCE_SYSTEM,
        sourceTable: table,
        sourceId: id,
        targetType,
        targetId,
        checksum: row ? checksum(row) : undefined
      }
    })
    .catch(async (error) => {
      if (isUniqueError(error)) return;
      throw error;
    });
}

function isUniqueError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}

async function importBabies(
  ctx: HouseholdContext,
  tables: SproutTables,
  batchId: string,
  maps: ImportMaps,
  counters: ImportCounters
) {
  const existing = await prisma.baby.findMany({ where: { householdId: ctx.householdId, deletedAt: null } });
  for (const [index, row] of rows(tables, "Baby").entries()) {
    if (!isImportable(row)) continue;
    const id = sourceId(row, "Baby", index);
    const previous = await importedRecord(ctx, "Baby", id);
    if (previous) {
      maps.babies.set(id, previous.targetId);
      counters.skipped += 1;
      continue;
    }
    const name = babyName(row);
    const birthDate = dateValue(row, "birthDate");
    const matched = existing.find((baby) => normalizeName(baby.name) === normalizeName(name) && birthKey(baby.birthDate) === birthKey(birthDate));
    const saved =
      matched ??
      (await prisma.baby.create({
        data: {
          householdId: ctx.householdId,
          name,
          birthDate,
          timezone: env.APP_TIMEZONE,
          notes: appendNotes(text(row, "notes"), boolValue(row, "inactive") ? "Imported from Sprout as inactive." : undefined),
          feedingWarningMinutes: parseWarningMinutes(value(row, "feedWarningTime")),
          diaperWarningMinutes: parseWarningMinutes(value(row, "diaperWarningTime"))
        }
      }));
    maps.babies.set(id, saved.id);
    await rememberImported(ctx, batchId, "Baby", id, "baby", saved.id, row);
    counters.babies += matched ? 0 : 1;
    counters.created += matched ? 0 : 1;
    if (!matched) existing.push(saved);
  }
}

async function importContacts(
  ctx: HouseholdContext,
  tables: SproutTables,
  batchId: string,
  maps: ImportMaps,
  counters: ImportCounters
) {
  for (const [index, row] of rows(tables, "Contact").entries()) {
    if (!isImportable(row)) continue;
    const id = sourceId(row, "Contact", index);
    const previous = await importedRecord(ctx, "Contact", id);
    if (previous) {
      maps.contacts.set(id, previous.targetId);
      counters.skipped += 1;
      continue;
    }
    const name = text(row, "name") ?? "Imported contact";
    const contact =
      (await prisma.contact.findFirst({
        where: {
          householdId: ctx.householdId,
          deletedAt: null,
          name,
          kind: text(row, "role") ?? text(row, "kind")
        }
      })) ??
      (await prisma.contact.create({
        data: {
          householdId: ctx.householdId,
          name,
          kind: text(row, "role") ?? text(row, "kind"),
          phone: text(row, "phone"),
          email: text(row, "email"),
          address: text(row, "address"),
          notes: text(row, "notes")
        }
      }));
    maps.contacts.set(id, contact.id);
    await rememberImported(ctx, batchId, "Contact", id, "contact", contact.id, row);
    counters.contacts += 1;
    counters.created += 1;
  }
}

async function importMedicines(
  ctx: HouseholdContext,
  tables: SproutTables,
  batchId: string,
  maps: ImportMaps,
  counters: ImportCounters
) {
  const medicineNames = new Set<string>();
  const supplementNames = new Set<string>();
  for (const [index, row] of rows(tables, "Medicine").entries()) {
    if (!isImportable(row)) continue;
    const id = sourceId(row, "Medicine", index);
    const name = text(row, "name") ?? "Imported medicine";
    const isSupplement = boolValue(row, "isSupplement");
    const previous = await importedRecord(ctx, "Medicine", id);
    if (previous) {
      maps.medicines.set(id, { id: previous.targetId, name, isSupplement, unit: unit(row) });
      counters.skipped += 1;
      continue;
    }
    const catalog =
      (await prisma.medicineCatalog.findFirst({
        where: { householdId: ctx.householdId, deletedAt: null, name, isSupplement }
      })) ??
      (await prisma.medicineCatalog.create({
        data: {
          householdId: ctx.householdId,
          name,
          typicalDoseSize: decimal(numberValue(row, "typicalDoseSize")),
          unit: unit(row),
          doseMinTime: text(row, "doseMinTime"),
          notes: text(row, "notes"),
          active: !boolValue(row, "deletedAt") && (value(row, "active") === undefined ? true : boolValue(row, "active")),
          isSupplement
        }
      }));
    maps.medicines.set(id, { id: catalog.id, name, isSupplement, unit: unit(row) });
    await rememberImported(ctx, batchId, "Medicine", id, "medicine_catalog", catalog.id, row);
    counters.medicines += 1;
    counters.created += 1;
    if (isSupplement) supplementNames.add(name);
    else medicineNames.add(name);
  }

  if (medicineNames.size || supplementNames.size) {
    const settings = await prisma.householdSettings.upsert({
      where: { householdId: ctx.householdId },
      update: {},
      create: { householdId: ctx.householdId }
    });
    await prisma.householdSettings.update({
      where: { householdId: ctx.householdId },
      data: {
        medicines: Array.from(new Set([...settings.medicines, ...medicineNames])).sort(),
        supplements: Array.from(new Set([...settings.supplements, ...supplementNames])).sort()
      }
    });
  }
}

function decimal(value?: number) {
  return value === undefined ? undefined : String(value);
}

async function importActivities(
  ctx: HouseholdContext,
  tables: SproutTables,
  batchId: string,
  maps: ImportMaps,
  counters: ImportCounters
) {
  for (const table of ACTIVITY_TABLES) {
    for (const [index, row] of rows(tables, table).entries()) {
      if (!isImportable(row)) continue;
      const id = sourceId(row, table, index);
      if (await importedRecord(ctx, table, id)) {
        counters.skipped += 1;
        continue;
      }
      const draft = activityDraft(ctx, table, row, maps);
      if (!draft) {
        counters.warnings.push(`Skipped ${table} ${id}: missing baby or required values.`);
        counters.skipped += 1;
        continue;
      }
      const activity = await prisma.activityLog.create({
        data: draft,
        include: { vaccine: true }
      });
      if (table === "VaccineLog" && activity.vaccine) maps.vaccines.set(id, activity.vaccine.id);
      await rememberImported(ctx, batchId, table, id, "activity", activity.id, row);
      counters.activities += 1;
      counters.created += 1;
    }
  }
}

function activityDraft(ctx: HouseholdContext, table: string, row: SproutRow, maps: ImportMaps): Prisma.ActivityLogCreateInput | null {
  const babySourceId = text(row, "babyId");
  const babyId = babySourceId ? maps.babies.get(babySourceId) : undefined;
  if (!babyId) return null;
  const caretakerName = text(row, "caretakerId") ? maps.caretakers.get(text(row, "caretakerId") ?? "") : undefined;
  const base = activityBase(ctx, row, babyId, caretakerName);

  if (table === "SleepLog") {
    const startedAt = requiredDate(row, ["startTime"]);
    const endedAt = dateValue(row, "endTime");
    return {
      ...base,
      type: ActivityType.sleep,
      occurredAt: startedAt,
      startedAt,
      endedAt,
      durationSeconds: durationFromMinutes(row, "duration", startedAt, endedAt),
      sleep: {
        create: {
          sleepType: enumText(row, "type") === "NIGHT_SLEEP" ? "night" : "nap",
          location: text(row, "location"),
          quality: text(row, "quality")?.toLowerCase()
        }
      }
    };
  }
  if (table === "FeedLog") {
    const startedAt = dateValue(row, "startTime");
    const endedAt = dateValue(row, "endTime");
    return {
      ...base,
      type: ActivityType.feeding,
      occurredAt: requiredDate(row, ["time", "startTime"]),
      startedAt,
      endedAt,
      durationSeconds: numberValue(row, "feedDuration") ?? (startedAt && endedAt ? durationSeconds(startedAt, endedAt) : undefined),
      notes: text(row, "notes"),
      feeding: {
        create: {
          mode: mapFeedingMode(row),
          amount: decimal(numberValue(row, "amount")),
          unit: unit(row),
          side: mapNursingSide(enumText(row, "side")),
          bottleType: text(row, "bottleType"),
          food: text(row, "food")
        }
      }
    };
  }
  if (table === "DiaperLog") {
    return {
      ...base,
      type: ActivityType.diaper,
      occurredAt: requiredDate(row, ["time"]),
      diaper: {
        create: {
          kind: mapDiaperKind(enumText(row, "type")),
          condition: text(row, "condition"),
          consistency: text(row, "condition"),
          color: text(row, "color"),
          blowout: boolValue(row, "blowout"),
          creamApplied: boolValue(row, "creamApplied")
        }
      }
    };
  }
  if (table === "MoodLog") {
    return {
      ...base,
      type: ActivityType.mood,
      occurredAt: requiredDate(row, ["time"]),
      durationSeconds: durationFromMinutes(row, "duration"),
      mood: { create: { mood: text(row, "mood") ?? "Mood", intensity: numberValue(row, "intensity") } }
    };
  }
  if (table === "Note") {
    return {
      ...base,
      type: ActivityType.note,
      occurredAt: requiredDate(row, ["time"]),
      note: { create: { text: text(row, "content") ?? "Imported note", category: text(row, "category") } }
    };
  }
  if (table === "Milestone") {
    return {
      ...base,
      type: ActivityType.milestone,
      occurredAt: requiredDate(row, ["date"]),
      notes: text(row, "description"),
      milestone: { create: { title: text(row, "title") ?? "Imported milestone", category: text(row, "category") } }
    };
  }
  if (table === "PumpLog") {
    const startedAt = requiredDate(row, ["startTime"]);
    const endedAt = dateValue(row, "endTime");
    return {
      ...base,
      type: ActivityType.pumping,
      occurredAt: startedAt,
      startedAt,
      endedAt,
      durationSeconds: durationFromMinutes(row, "duration", startedAt, endedAt),
      notes: text(row, "notes"),
      pumping: {
        create: {
          amount: decimal(numberValue(row, "totalAmount")),
          leftAmount: decimal(numberValue(row, "leftAmount")),
          rightAmount: decimal(numberValue(row, "rightAmount")),
          unit: unit(row),
          inventoryAction: mapMilkAction(text(row, "pumpAction"))
        }
      }
    };
  }
  if (table === "BreastMilkAdjustment") {
    const amount = numberValue(row, "amount");
    return {
      ...base,
      type: ActivityType.milk_inventory,
      occurredAt: requiredDate(row, ["time"]),
      notes: appendNotes(text(row, "reason"), text(row, "notes")),
      milkInventory: {
        create: {
          action: mapMilkAction(text(row, "reason"), amount),
          amount: decimal(amount === undefined ? undefined : Math.abs(amount)),
          unit: unit(row)
        }
      }
    };
  }
  if (table === "PlayLog") {
    const startedAt = requiredDate(row, ["startTime"]);
    const endedAt = dateValue(row, "endTime");
    return {
      ...base,
      type: ActivityType.play,
      occurredAt: startedAt,
      startedAt,
      endedAt,
      durationSeconds: durationFromMinutes(row, "duration", startedAt, endedAt),
      notes: text(row, "notes"),
      play: {
        create: {
          activityName: text(row, "activities") ?? text(row, "type")?.replace(/_/g, " ").toLowerCase(),
          intensity: text(row, "type")?.toLowerCase()
        }
      }
    };
  }
  if (table === "BathLog") {
    const products = [
      boolValue(row, "soapUsed") ? "Soap" : undefined,
      boolValue(row, "shampooUsed") ? "Shampoo" : undefined
    ]
      .filter(Boolean)
      .join(", ");
    return {
      ...base,
      type: ActivityType.bath,
      occurredAt: requiredDate(row, ["time"]),
      notes: text(row, "notes"),
      bath: { create: { products: products || undefined } }
    };
  }
  if (table === "Measurement") {
    return {
      ...base,
      type: ActivityType.measurement,
      occurredAt: requiredDate(row, ["date"]),
      notes: text(row, "notes"),
      measurement: { create: mapMeasurement(row) }
    };
  }
  if (table === "MedicineLog") {
    const medicine = text(row, "medicineId") ? maps.medicines.get(text(row, "medicineId") ?? "") : undefined;
    const isSupplement = medicine?.isSupplement ?? false;
    return {
      ...base,
      type: isSupplement ? ActivityType.supplement : ActivityType.medicine,
      occurredAt: requiredDate(row, ["time"]),
      notes: text(row, "notes"),
      ...(isSupplement
        ? {
            supplement: {
              create: {
                name: medicine?.name ?? "Imported supplement",
                dose: decimal(numberValue(row, "doseAmount")),
                unit: unit(row) ?? medicine?.unit
              }
            }
          }
        : {
            medicine: {
              create: {
                name: medicine?.name ?? "Imported medicine",
                dose: decimal(numberValue(row, "doseAmount")),
                unit: unit(row) ?? medicine?.unit
              }
            }
          })
    };
  }
  if (table === "VaccineLog") {
    return {
      ...base,
      type: ActivityType.vaccine,
      occurredAt: requiredDate(row, ["time"]),
      notes: text(row, "notes"),
      vaccine: {
        create: {
          name: text(row, "vaccineName") ?? "Imported vaccine",
          dose: numberValue(row, "doseNumber")?.toString()
        }
      }
    };
  }
  return null;
}

function activityBase(
  ctx: HouseholdContext,
  row: SproutRow,
  babyId: string,
  externalActorName?: string
): Omit<Prisma.ActivityLogCreateInput, "type" | "occurredAt"> {
  return {
    household: { connect: { id: ctx.householdId } },
    baby: { connect: { id: babyId } },
    actorMember: { connect: { id: ctx.memberId } },
    timezone: env.APP_TIMEZONE,
    source: SOURCE_SYSTEM,
    externalActorName,
    timerState: TimerState.none,
    createdAt: dateValue(row, "createdAt"),
    updatedAt: dateValue(row, "updatedAt")
  };
}

function durationFromMinutes(row: SproutRow, key: string, startedAt?: Date, endedAt?: Date) {
  const minutes = numberValue(row, key);
  if (minutes !== undefined) return Math.round(minutes * 60);
  return startedAt && endedAt ? durationSeconds(startedAt, endedAt) : undefined;
}

async function importCalendarEvents(
  ctx: HouseholdContext,
  tables: SproutTables,
  batchId: string,
  maps: ImportMaps,
  counters: ImportCounters
) {
  const babyLinks = rows(tables, "BabyEvent");
  const contactLinks = rows(tables, "ContactEvent");
  const caretakerLinks = rows(tables, "CaretakerEvent");
  for (const [index, row] of rows(tables, "CalendarEvent").entries()) {
    if (!isImportable(row)) continue;
    const id = sourceId(row, "CalendarEvent", index);
    if (await importedRecord(ctx, "CalendarEvent", id)) {
      counters.skipped += 1;
      continue;
    }
    const linkedCaretakers = caretakerLinks
      .filter((link) => text(link, "eventId") === id && text(link, "caretakerId"))
      .map((link) => maps.caretakers.get(text(link, "caretakerId") ?? ""))
      .filter((name): name is string => Boolean(name));
    const event = await prisma.calendarEvent.create({
      data: {
        householdId: ctx.householdId,
        title: text(row, "title") ?? "Imported event",
        description: text(row, "description"),
        startTime: requiredDate(row, ["startTime"]),
        endTime: dateValue(row, "endTime"),
        allDay: boolValue(row, "allDay"),
        eventType: text(row, "type"),
        location: text(row, "location"),
        color: text(row, "color"),
        recurring: boolValue(row, "recurring"),
        recurrencePattern: text(row, "recurrencePattern"),
        recurrenceEnd: dateValue(row, "recurrenceEnd"),
        customRecurrence: text(row, "customRecurrence"),
        reminderMinutes: numberValue(row, "reminderTime"),
        notificationSent: boolValue(row, "notificationSent"),
        source: SOURCE_SYSTEM,
        externalCaretakerNames: linkedCaretakers
      }
    });
    await rememberImported(ctx, batchId, "CalendarEvent", id, "calendar_event", event.id, row);
    counters.calendarEvents += 1;
    counters.created += 1;

    for (const link of babyLinks.filter((item) => text(item, "eventId") === id)) {
      const babyId = text(link, "babyId") ? maps.babies.get(text(link, "babyId") ?? "") : undefined;
      if (babyId) {
        await prisma.calendarEventBaby.create({ data: { eventId: event.id, babyId } }).catch((error) => {
          if (!isUniqueError(error)) throw error;
        });
      }
    }
    for (const link of contactLinks.filter((item) => text(item, "eventId") === id)) {
      const contactId = text(link, "contactId") ? maps.contacts.get(text(link, "contactId") ?? "") : undefined;
      if (contactId) {
        await prisma.calendarEventContact.create({ data: { eventId: event.id, contactId } }).catch((error) => {
          if (!isUniqueError(error)) throw error;
        });
      }
    }
  }
}

async function importVaccineDocuments(
  ctx: HouseholdContext,
  tables: SproutTables,
  batchId: string,
  maps: ImportMaps,
  counters: ImportCounters
) {
  for (const [index, row] of rows(tables, "VaccineDocument").entries()) {
    if (!isImportable(row)) continue;
    const id = sourceId(row, "VaccineDocument", index);
    if (await importedRecord(ctx, "VaccineDocument", id)) {
      counters.skipped += 1;
      continue;
    }
    const vaccineSource = firstText(row, ["vaccineLogId", "vaccineId"]);
    const vaccineLogId = vaccineSource ? maps.vaccines.get(vaccineSource) : undefined;
    if (!vaccineLogId) {
      counters.warnings.push(`Skipped VaccineDocument ${id}: matching vaccine log was not imported.`);
      counters.skipped += 1;
      continue;
    }
    const document = await prisma.vaccineDocument.create({
      data: {
        vaccineLogId,
        originalName: firstText(row, ["originalName", "fileName", "filename", "name", "storedName"]) ?? "Imported vaccine document",
        storedName: firstText(row, ["storedName", "filePath", "path", "url"]),
        mimeType: firstText(row, ["mimeType", "contentType"]),
        fileSize: firstNumber(row, ["fileSize", "size"]),
        sourcePath: firstText(row, ["storedName", "filePath", "path", "url"])
      }
    });
    await rememberImported(ctx, batchId, "VaccineDocument", id, "vaccine_document", document.id, row);
    counters.vaccineDocuments += 1;
    counters.created += 1;
  }
}

export const sproutImportTestUtils = {
  parseSproutBackup,
  parseSproutDateForImport,
  parseWarningMinutes,
  tablesFromJson,
  mapMeasurement,
  validateSqlite,
  activityDraftForTest(table: string, row: SproutRow, babyId = "target-baby") {
    const sourceBabyId = text(row, "babyId") ?? "source-baby";
    return activityDraft(
      {
        householdId: "household-1",
        memberId: "member-1",
        userId: "user-1"
      } as HouseholdContext,
      table,
      { babyId: sourceBabyId, ...row },
      {
        babies: new Map([[sourceBabyId, babyId]]),
        contacts: new Map(),
        medicines: new Map(),
        caretakers: new Map(),
        vaccines: new Map()
      }
    );
  }
};
