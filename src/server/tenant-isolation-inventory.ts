export type TenantOwnership = "direct" | "inherited" | "multi_parent" | "global";
export const prismaModelNames = [
  "Account", "AccountMutationOperation", "AccountMutationOperationTombstone", "AccountOperationBinding", "AccountOperationReservationTombstone", "AccountSecurityState", "ActivityLog", "ActivityTimerPauseInterval", "ApiKey", "AuditEvent", "AuditIntegrityCheckpoint", "Baby", "BackupRecord", "BathLog", "BrowserMutationOperation", "BrowserMutationOperationTombstone", "BrowserOperationBinding", "BrowserOperationReservationTombstone", "CalendarEvent",
  "CalendarEventBaby", "CalendarEventContact", "Contact", "DashboardWarningDismissal", "DiaperLog", "EmailChange", "EmailChangeDelivery", "EmailChangeIdentityMutation", "EmailChangeSessionRotation", "EmailDeliveryEncryptionKey", "FeedingLog", "FreshAuthAttestationKey", "FreshAuthGrant",
  "GlobalSecurityEvent", "GlobalSecurityIncident", "GlobalSecurityOperation", "GlobalSecurityOperationBinding", "GlobalSecurityOperationReservationTombstone", "GlobalSecurityOperationTombstone", "GlobalSecurityThrottleKey", "Household", "HouseholdDeletionRegistry", "HouseholdMember", "HouseholdSettings", "ImportBatch", "ImportedRecord", "Invite", "InvitationAccountSetup", "InvitationLineage", "InvitationOperationBinding", "InvitationOperationIdentity", "InvitationOperationResult", "InvitationOperationTombstone", "InvitationPresentationClaim", "InvitationRecoveryRehearsalChallenge", "InvitationSetupCorridorAttestationReceipt", "MeasurementLog",
  "MedicineCatalog", "MedicineLog", "MilestoneLog", "MilkInventoryLog", "MoodLog", "MutationReceipt", "NoteLog", "NotificationLog", "PasswordChangeCredentialMutation", "RecoveryResetCredentialMutation", "InvitationProcedureTransitionBinding", "InvitationRecoveryEnrollmentBridge",
  "NotificationPreference", "NotificationPreferenceBaby", "PlannedSchedule", "PlatformAuditEvent", "PlatformAuthority", "PlatformRegistrationOperation", "PlatformSettings", "PlatformSetupCode", "PlayLog", "PumpingLog",
  "PushSubscription", "RecoveryCode", "RecoveryCodeSet", "RecoverySession", "Reminder", "Session", "SessionSecurityActivity", "SleepLog", "SupplementLog", "User", "VaccineDocument", "VaccineLog",
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
  { model: "AccountMutationOperation", ownership: "global", operationClasses: ["account_browser_operation"], disposition: "excluded" },
  { model: "AccountMutationOperationTombstone", ownership: "global", operationClasses: ["account_browser_operation_tombstone"], disposition: "excluded" },
  { model: "AccountOperationBinding", ownership: "global", operationClasses: ["account_browser_operation_binding"], disposition: "excluded" },
  { model: "AccountOperationReservationTombstone", ownership: "global", operationClasses: ["account_browser_operation_reservation_tombstone"], disposition: "excluded" },
  { model: "AccountSecurityState", ownership: "global", operationClasses: ["global_security_state"], disposition: "excluded" },
  { model: "ActivityLog", ownership: "direct", operationClasses: ["activity_write", "import", "restore"], disposition: "constraint_slice" },
  { model: "ActivityTimerPauseInterval", ownership: "inherited", operationClasses: ["activity_timer_pause"], disposition: "inherited_parent" },
  { model: "ApiKey", ownership: "direct", operationClasses: ["integration_write", "api_auth"], disposition: "deferred_constraint" },
  { model: "AuditEvent", ownership: "direct", operationClasses: ["audit_write"], disposition: "deferred_constraint" },
  { model: "AuditIntegrityCheckpoint", ownership: "global", operationClasses: ["audit_integrity_checkpoint"], disposition: "excluded" },
  { model: "Baby", ownership: "direct", operationClasses: ["baby_lifecycle", "activity_parent"], disposition: "constraint_slice" },
  { model: "BackupRecord", ownership: "direct", operationClasses: ["backup", "restore", "import"], disposition: "deferred_constraint" },
  { model: "BrowserMutationOperation", ownership: "direct", operationClasses: ["browser_mutation_operation"], disposition: "constraint_slice" },
  { model: "BrowserMutationOperationTombstone", ownership: "direct", operationClasses: ["browser_mutation_tombstone"], disposition: "constraint_slice" },
  { model: "BrowserOperationBinding", ownership: "direct", operationClasses: ["browser_mutation_binding"], disposition: "constraint_slice" },
  { model: "BrowserOperationReservationTombstone", ownership: "direct", operationClasses: ["browser_mutation_reservation_tombstone"], disposition: "constraint_slice" },
  { model: "CalendarEvent", ownership: "direct", operationClasses: ["calendar_write", "import"], disposition: "constraint_slice" },
  { model: "CalendarEventBaby", ownership: "direct", operationClasses: ["calendar_join", "import"], disposition: "constraint_slice" },
  { model: "CalendarEventContact", ownership: "direct", operationClasses: ["calendar_join", "import"], disposition: "constraint_slice" },
  { model: "Contact", ownership: "direct", operationClasses: ["contact_write", "activity_parent"], disposition: "constraint_slice" },
  { model: "DashboardWarningDismissal", ownership: "direct", operationClasses: ["dashboard_write"], disposition: "constraint_slice" },
  { model: "EmailChange", ownership: "global", operationClasses: ["global_security_email_change"], disposition: "excluded" },
  { model: "EmailChangeDelivery", ownership: "global", operationClasses: ["global_security_email_delivery"], disposition: "excluded" },
  { model: "EmailChangeIdentityMutation", ownership: "global", operationClasses: ["global_security_email_identity_mutation"], disposition: "excluded" },
  { model: "EmailChangeSessionRotation", ownership: "global", operationClasses: ["global_security_email_session_rotation"], disposition: "excluded" },
  { model: "EmailDeliveryEncryptionKey", ownership: "global", operationClasses: ["global_security_email_delivery_key"], disposition: "excluded" },
  { model: "FreshAuthGrant", ownership: "global", operationClasses: ["global_security_fresh_auth_grant"], disposition: "excluded" },
  { model: "FreshAuthAttestationKey", ownership: "global", operationClasses: ["global_security_fresh_auth_attestation_key"], disposition: "excluded" },
  { model: "GlobalSecurityEvent", ownership: "global", operationClasses: ["global_security_event"], disposition: "excluded" },
  { model: "GlobalSecurityIncident", ownership: "global", operationClasses: ["global_security_incident"], disposition: "excluded" },
  { model: "GlobalSecurityThrottleKey", ownership: "global", operationClasses: ["global_security_throttle_key"], disposition: "excluded" },
  { model: "GlobalSecurityOperation", ownership: "global", operationClasses: ["global_security_operation"], disposition: "excluded" },
  { model: "GlobalSecurityOperationBinding", ownership: "global", operationClasses: ["global_security_operation_binding"], disposition: "excluded" },
  { model: "GlobalSecurityOperationReservationTombstone", ownership: "global", operationClasses: ["global_security_operation_reservation_tombstone"], disposition: "excluded" },
  { model: "GlobalSecurityOperationTombstone", ownership: "global", operationClasses: ["global_security_operation_tombstone"], disposition: "excluded" },
  { model: "HouseholdMember", ownership: "direct", operationClasses: ["membership", "activity_actor"], disposition: "constraint_slice" },
  { model: "HouseholdSettings", ownership: "direct", operationClasses: ["settings_write"], disposition: "service_guard" },
  { model: "ImportBatch", ownership: "direct", operationClasses: ["import"], disposition: "deferred_constraint" },
  { model: "ImportedRecord", ownership: "direct", operationClasses: ["import_mapping"], disposition: "constraint_slice" },
  { model: "Invite", ownership: "direct", operationClasses: ["membership"], disposition: "service_guard" },
  { model: "InvitationAccountSetup", ownership: "global", operationClasses: ["invitation_account_origin_retention"], disposition: "excluded" },
  { model: "InvitationLineage", ownership: "direct", operationClasses: ["invitation_protocol_lineage"], disposition: "constraint_slice" },
  { model: "InvitationOperationBinding", ownership: "direct", operationClasses: ["invitation_protocol_binding"], disposition: "constraint_slice" },
  { model: "InvitationOperationIdentity", ownership: "direct", operationClasses: ["invitation_protocol_identity"], disposition: "constraint_slice" },
  { model: "InvitationOperationResult", ownership: "direct", operationClasses: ["invitation_protocol_result"], disposition: "constraint_slice" },
  { model: "InvitationOperationTombstone", ownership: "direct", operationClasses: ["invitation_protocol_tombstone"], disposition: "constraint_slice" },
  { model: "InvitationPresentationClaim", ownership: "direct", operationClasses: ["invitation_protocol_claim"], disposition: "constraint_slice" },
  { model: "InvitationProcedureTransitionBinding", ownership: "global", operationClasses: ["invitation_protocol_governance"], disposition: "excluded" },
  { model: "InvitationRecoveryEnrollmentBridge", ownership: "direct", operationClasses: ["invitation_protocol_recovery_enrollment"], disposition: "service_guard" },
  { model: "InvitationRecoveryRehearsalChallenge", ownership: "direct", operationClasses: ["invitation_protocol_recovery_rehearsal"], disposition: "constraint_slice" },
  { model: "InvitationSetupCorridorAttestationReceipt", ownership: "global", operationClasses: ["invitation_protocol_setup_corridor"], disposition: "excluded" },
  { model: "MedicineCatalog", ownership: "direct", operationClasses: ["catalog_write", "activity_parent"], disposition: "deferred_constraint" },
  { model: "MutationReceipt", ownership: "direct", operationClasses: ["consequential_mutation_receipt"], disposition: "service_guard" },
  { model: "NotificationLog", ownership: "direct", operationClasses: ["notification_delivery"], disposition: "deferred_constraint" },
  { model: "NotificationPreference", ownership: "direct", operationClasses: ["notification_write"], disposition: "constraint_slice" },
  { model: "NotificationPreferenceBaby", ownership: "direct", operationClasses: ["notification_preference_selection"], disposition: "constraint_slice" },
  // The baby reference is composite (householdId, babyId), so a plan cannot point at another household's baby.
  { model: "PlannedSchedule", ownership: "direct", operationClasses: ["planned_schedule_write", "restore"], disposition: "constraint_slice" },
  { model: "PlatformAuditEvent", ownership: "global", operationClasses: ["platform_audit"], disposition: "excluded" },
  { model: "PlatformAuthority", ownership: "global", operationClasses: ["platform_authority"], disposition: "excluded" },
  { model: "PlatformRegistrationOperation", ownership: "global", operationClasses: ["platform_registration_operation"], disposition: "excluded" },
  { model: "PlatformSettings", ownership: "global", operationClasses: ["platform_settings"], disposition: "excluded" },
  { model: "PlatformSetupCode", ownership: "global", operationClasses: ["platform_setup_claim"], disposition: "excluded" },
  { model: "PasswordChangeCredentialMutation", ownership: "global", operationClasses: ["global_security_password_change_receipt"], disposition: "excluded" },
  { model: "RecoveryResetCredentialMutation", ownership: "global", operationClasses: ["global_security_recovery_reset_receipt"], disposition: "excluded" },
  { model: "PushSubscription", ownership: "direct", operationClasses: ["notification_write"], disposition: "deferred_constraint" },
  { model: "RecoveryCode", ownership: "global", operationClasses: ["global_security_recovery_code"], disposition: "excluded" },
  { model: "RecoveryCodeSet", ownership: "global", operationClasses: ["global_security_recovery_code_set"], disposition: "excluded" },
  { model: "RecoverySession", ownership: "global", operationClasses: ["global_security_recovery_session"], disposition: "excluded" },
  { model: "Reminder", ownership: "direct", operationClasses: ["reminder_write"], disposition: "constraint_slice" },
  { model: "Session", ownership: "global", operationClasses: ["auth_session"], disposition: "excluded" },
  { model: "SessionSecurityActivity", ownership: "global", operationClasses: ["global_security_session_activity"], disposition: "excluded" },
  { model: "WebhookDelivery", ownership: "direct", operationClasses: ["webhook_delivery"], disposition: "constraint_slice" },
  { model: "WebhookEndpoint", ownership: "direct", operationClasses: ["integration_write", "webhook_delivery"], disposition: "deferred_constraint" },

  { model: "FeedingLog", ownership: "inherited", operationClasses: ["activity_detail"], disposition: "inherited_parent" },
  { model: "Household", ownership: "global", operationClasses: ["household_root"], disposition: "excluded" },
  { model: "HouseholdDeletionRegistry", ownership: "global", operationClasses: ["household_deletion_registry"], disposition: "excluded" },
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

  { model: "VaccineDocument", ownership: "inherited", operationClasses: ["vaccine_attachment"], disposition: "inherited_parent" },
  { model: "User", ownership: "global", operationClasses: ["auth_user"], disposition: "excluded" },
  { model: "Verification", ownership: "global", operationClasses: ["auth_verification"], disposition: "excluded" }
] as const satisfies readonly TenantIsolationInventoryEntry[];
