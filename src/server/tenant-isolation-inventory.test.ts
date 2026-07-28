import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prismaModelNames, tenantIsolationInventory } from "@/server/tenant-isolation-inventory";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

const schemaModelNames = schema
  .split(/\r?\n(?=model\s)/)
  .filter((modelBlock) => modelBlock.startsWith("model "))
  .map((modelBlock) => modelBlock.match(/^model\s+(\w+)/)?.[1] ?? "")
  .sort();

const directHouseholdModels = schema
  .split(/\r?\n(?=model\s)/)
  .filter((modelBlock) => modelBlock.startsWith("model "))
  .filter((modelBlock) => /\r?\n\s+householdId\s+String\b/.test(modelBlock))
  .map((modelBlock) => modelBlock.match(/^model\s+(\w+)/)?.[1] ?? "")
  .sort();

const expectedDirectHouseholdModels = [
  "ActivityLog",
  "ApiKey",
  "AuditEvent",
  "Baby",
  "BackupRecord",
  "CalendarEvent",
  "Contact",
  "DashboardWarningDismissal",
  "HouseholdMember",
  "HouseholdSettings",
  "ImportBatch",
  "ImportedRecord",
  "Invite",
  "MedicineCatalog",
  "NotificationLog",
  "NotificationPreference",
  "PushSubscription",
  "Reminder",
  "WebhookDelivery",
  "WebhookEndpoint"
];

describe("tenant-isolation inventory", () => {
  it("classifies every direct household-owned Prisma model exactly once", () => {
    expect(directHouseholdModels).toEqual(expectedDirectHouseholdModels);

    expect([...prismaModelNames].sort()).toEqual(schemaModelNames);
    expect(tenantIsolationInventory.map((entry) => entry.model).sort()).toEqual(schemaModelNames);

    const directEntries = tenantIsolationInventory.filter((entry) => entry.ownership === "direct");
    expect(directEntries.map((entry) => entry.model).sort()).toEqual(directHouseholdModels);
    expect(new Set(tenantIsolationInventory.map((entry) => entry.model)).size).toBe(tenantIsolationInventory.length);

    for (const entry of tenantIsolationInventory) {
      expect(entry.disposition).not.toBe("");
      expect(entry.operationClasses.length).toBeGreaterThan(0);
    }
  });

  it("keeps multi-parent and inherited rows explicitly classified", () => {
    expect(tenantIsolationInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "MedicineLog", ownership: "multi_parent" }),
        expect.objectContaining({ model: "CalendarEventBaby", ownership: "multi_parent" }),
        expect.objectContaining({ model: "CalendarEventContact", ownership: "multi_parent" }),
        expect.objectContaining({ model: "VaccineDocument", ownership: "inherited" }),
        expect.objectContaining({
          model: "DashboardWarningDismissal",
          ownership: "direct",
          disposition: "constraint_slice"
        }),
        expect.objectContaining({
          model: "Reminder",
          ownership: "direct",
          disposition: "constraint_slice"
        }),
        expect.objectContaining({
          model: "NotificationPreference",
          ownership: "direct",
          disposition: "constraint_slice"
        }),
        expect.objectContaining({
          model: "WebhookDelivery",
          ownership: "direct",
          disposition: "constraint_slice"
        }),
        expect.objectContaining({
          model: "ImportedRecord",
          ownership: "direct",
          disposition: "constraint_slice"
        })
      ])
    );
  });
});
