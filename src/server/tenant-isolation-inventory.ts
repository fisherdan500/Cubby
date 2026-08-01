export type TenantOwnership = "direct" | "inherited" | "multi_parent" | "global";
export const prismaModelNames = [
  "Account", "ActivityLog", "ApiKey", "AuditEvent", "Baby", "BackupRecord", "BathLog", "CalendarEvent",
  "CalendarEventBaby", "CalendarEventContact", "Contact", "DashboardWarningDismissal", "DiaperLog", "FeedingLog",
  "Household", "HouseholdMember", "HouseholdSettings", "ImportBatch", "ImportedRecord", "Invite", "MeasurementLog",
  "MedicineCatalog", "MedicineLog", "MilestoneLog", "MilkInventoryLog", "MoodLog", "MutationReceipt", "NoteLog", "NotificationLog",
  "NotificationPreference", "PlatformAuditEvent", "PlatformAuthority", "PlatformRegistrationOperation", "PlatformSettings", "PlayLog", "PumpingLog",
  "PushSubscription", "Reminder", "Session", "SleepLog", "SupplementLog", "User", "VaccineDocument", "VaccineLog",
  "Verification", "WebhookDelivery", "WebhookEndpoint"
] as const;
export type PrismaModelName = (typeof prismaModelNames)[number];
export type TenantIsolationDisposition =
  | "constraint_slice"
  | "service_guard"
  | "deferred_constraint"
  | "inherited_parent"
  | "excluded";

export type TenantIsolationInventoryEntry = {
  model: PrismaModelName;
  ownership: TenantOwnership;
  operationClasses: readonly string[];
  disposition: TenantIsolationDisposition;
};

export const tenantIsolationInventory = [
  { model: "Account", ownership: "global", operationClasses: ["auth_account"], disposition: "excluded" },
  { model: "ActivityLog", ownership: "direct", operationClasses: ["activity_write", "import", "restore"], disposition: "constraint_slice" },
  { model: "ApiKey", ownership: "direct", operationClasses: ["integration_write", "api_auth"], disposition: "deferred_constraint" },
  { model: "AuditEvent", ownership: "direct", operationClasses: ["audit_write"], disposition: "deferred_constraint" },
  { model: "Baby", ownership: "direct", operationClasses: ["baby_lifecycle", "activity_parent"], disposition: "constraint_slice" },
  { model: "BackupRecord", ownership: "direct", operationClasses: ["backup", "restore", "import"], disposition: "deferred_constraint" },
  { model: "CalendarEvent", ownership: "direct", operationClasses: ["calendar_write", "import"], disposition: "deferred_constraint" },
  { model: "Contact", ownership: "direct", operationClasses: ["contact_write", "activity_parent"], disposition: "deferred_constraint" },
  { model: "DashboardWarningDismissal", ownership: "direct", operationClasses: ["dashboard_write"], disposition: "constraint_slice" },
  { model: "HouseholdMember", ownership: "direct", operationClasses: ["membership", "activity_actor"], disposition: "constraint_slice" },
  { model: "HouseholdSettings", ownership: "direct", operationClasses: ["settings_write"], disposition: "service_guard" },
  { model: "ImportBatch", ownership: "direct", operationClasses: ["import"], disposition: "deferred_constraint" },
  { model: "ImportedRecord", ownership: "direct", operationClasses: ["import_mapping"], disposition: "constraint_slice" },
  { model: "Invite", ownership: "direct", operationClasses: ["membership"], disposition: "service_guard" },
  { model: "MedicineCatalog", ownership: "direct", operationClasses: ["catalog_write", "activity_parent"], disposition: "deferred_constraint" },
  { model: "MutationReceipt", ownership: "direct", operationClasses: ["consequential_mutation_receipt"], disposition: "service_guard" },
  { model: "NotificationLog", ownership: "direct", operationClasses: ["notification_delivery"], disposition: "deferred_constraint" },
  { model: "NotificationPreference", ownership: "direct", operationClasses: ["notification_write"], disposition: "constraint_slice" },
  { model: "PlatformAuditEvent", ownership: "global", operationClasses: ["platform_audit"], disposition: "excluded" },
  { model: "PlatformAuthority", ownership: "global", operationClasses: ["platform_authority"], disposition: "excluded" },
  { model: "PlatformRegistrationOperation", ownership: "global", operationClasses: ["platform_registration_operation"], disposition: "excluded" },
  { model: "PlatformSettings", ownership: "global", operationClasses: ["platform_settings"], disposition: "excluded" },
  { model: "PushSubscription", ownership: "direct", operationClasses: ["notification_write"], disposition: "deferred_constraint" },
  { model: "Reminder", ownership: "direct", operationClasses: ["reminder_write"], disposition: "constraint_slice" },
  { model: "Session", ownership: "global", operationClasses: ["auth_session"], disposition: "excluded" },
  { model: "WebhookDelivery", ownership: "direct", operationClasses: ["webhook_delivery"], disposition: "constraint_slice" },
  { model: "WebhookEndpoint", ownership: "direct", operationClasses: ["integration_write", "webhook_delivery"], disposition: "deferred_constraint" },

  { model: "FeedingLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "Household", ownership: "global", operationClasses: ["household_root"], disposition: "excluded" },
  { model: "DiaperLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "SleepLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "PumpingLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "MedicineLog", ownership: "multi_parent", operationClasses: ["activity_detail", "contact_reference"], disposition: "deferred_constraint" },
  { model: "SupplementLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "MeasurementLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "MilestoneLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "NoteLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "BathLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "PlayLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "MoodLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "VaccineLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "MilkInventoryLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "CalendarEventBaby", ownership: "multi_parent", operationClasses: ["calendar_join", "import"], disposition: "deferred_constraint" },
  { model: "CalendarEventContact", ownership: "multi_parent", operationClasses: ["calendar_join", "import"], disposition: "deferred_constraint" },
  { model: "VaccineDocument", ownership: "inherited", operationClasses: ["vaccine_attachment"], disposition: "inherited_parent" },
  { model: "User", ownership: "global", operationClasses: ["auth_user"], disposition: "excluded" },
  { model: "Verification", ownership: "global", operationClasses: ["auth_verification"], disposition: "excluded" }
] as const satisfies readonly TenantIsolationInventoryEntry[];
