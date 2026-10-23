# Phase 2: occurrence editor (preview local only)

## Screens
- `/admin/event-groups/new`: one class initially; common title/date/venue and class start time; add rows for multiple classes.
- `/admin/event-groups/[id]/edit`: all existing classes and raw edit-start snapshot. Existing rows cannot be removed. End times are never writable.
- Common date/venue inherit until a class explicitly overrides them. The occurrence start/end dates are the minimum/maximum class dates.
- New capacity is 10. Capacity/type/class reception are inside details. New class reception is disabled. Existing capacity/reception/end time are preserved. Group reception is never changed by saving.
- Confirm all classes, then save once. Definite rejection retains input. Unknown outcome locks editing and permits only manual same-key/body retry.
- Frozen save attempts are written to per-tab sessionStorage before transmission. Reload restores the attempt; metadata only, no passwords/tokens/applicants. Browser storage must be available. Closing the tab/clearing storage can lose the recovery key: check the admin list before creating again. No automatic retry.
- Existing unassigned schedules and the legacy schedule manager remain unchanged.

## SQL (NOT applied to cloud)
`supabase/migrations/20261024_add_atomic_occurrence_editor.sql` adds:
- `occurrence_private.save_requests`, RLS, no direct role access. UUID keys stay reserved indefinitely; no expiry-to-new-create conversion.
- authenticated/admin-only `admin_get_occurrence_editor(bigint)` and `admin_save_occurrence(uuid,jsonb)`, SECURITY DEFINER with empty search_path.
- Read-committed isolation is required (other isolation levels fail closed). Parent-first/all-class row locks, complete snapshot comparison, membership and capacity validation, transactional reservation and result. No registration RPC is altered.
- Apply only after review and isolated PostgreSQL tests. Existing occurrence metadata migration 20261022 must already exist. The pending deletion migration is NOT a prerequisite.
- Never apply the baseline or any SQL to production. This change does not deploy or apply SQL automatically. No rollback SQL is executed by tests outside the temporary container. Before undoing a deployed migration, stop editor use; drop only the two new functions, then separately decide retention/export of private request tombstones. Dropping them loses retry protection, so do not recreate the editor with old keys after deleting tombstones.

## Automated checks (no cloud connection)
`node --test tests/occurrence-editor.test.mjs tests/occurrence-editor-screen.test.mjs`

Isolated DB test, only after local Docker Desktop and the already-downloaded image are verified:
`SHINSEIKAI_OCCURRENCE_DB_TEST=1 node --test tests/occurrence-editor-db.test.mjs`

It uses `ghcr.io/supabase/postgres:17.11.0.004`, `--pull=never`, `--network none`, no host mounts/ports, TCP disabled, a private tmpfs DB and `--rm`/`t.after`. Only synthetic data in its own container. No existing containers or cloud databases are used. All DB tests are skipped in the default suite.

Before preview deployment: run the isolated DB test (including rollback, replay, concurrent edit and capacity), review the SQL, apply only the new migration to verified preview separately, then verify function owner/grants and perform a synthetic preview browser check. Commit/push/deploy/cloud migration are not part of this local implementation.

## Limits / remaining manual checks
- Up to 100 classes and 128 KiB request (including snapshot); fail closed rather than show/save partial data.
- Snapshot detects changed values, not an ABA change that returns to the identical values; no additional version column is introduced.
- Old admin schedule APIs remain available; changes there cause editor conflicts. A later legacy change can place a class outside the saved period; global cross-table date enforcement is not added in this phase.
- One request key belongs to one authenticated admin. A different admin cannot replay it. Concurrent same-key saves wait for the first transaction.
- Confirm real mobile date/time widgets, keyboard navigation, all-class confirmation, stopped reception, storage/reload recovery, and historic end-time retention on preview after approval.
