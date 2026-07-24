# Backup Recovery

- [Automated Local Backups](recovery/automated-local-backups.md): local-only
  automation defaults, retention, failure semantics, download-based recovery,
  and operator responsibilities.
- [Manual Backup Recovery](recovery/manual-backup.md): version 2 snapshot scope,
  exclusions, fresh-target restore rules, and the isolated PostgreSQL rehearsal.

Cubby JSON backups are logical household recovery artifacts, not PostgreSQL
physical backups or generic migration rollback points. For deployment preflight,
startup/readiness contracts, and the decision between forward correction and a
separately prepared database restore, see
[Always-On Updates And Migration Recovery](ALWAYS_ON_UPDATES.md).

Platform authority, platform registration settings, and platform audit events are
deployment state and are not included in household JSON backups. A physical
PostgreSQL restore preserves those tables with the rest of the database. A fresh
deployment restored only from household JSON must separately create the first
account, complete the audited host-local bootstrap verification when needed, and
bind the explicit platform owner before restoring household data. Never infer the
platform owner from restored household ownership or membership.
