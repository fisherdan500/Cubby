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
