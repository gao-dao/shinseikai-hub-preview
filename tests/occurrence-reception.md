# New occurrence reception — preview-only forward change

## Scope
Apply `supabase/migrations/20261027_open_new_occurrence_registration.sql` only after review.
Prerequisites: occurrence editor 20261024, end-time editor 20261025 and lifecycle 20261026.
The new migration replaces only `public.admin_save_occurrence(uuid,jsonb)`; compared with
20261025, the function body changes only the new `event_groups.registration_open` value
from false to true. No table, column, RLS, applicant data, cancellation data, registration
RPC, existing occurrence state or save-request tombstone is changed at application time.
The pending group-deletion migration is not a prerequisite and must not be included.

New group reception starts in the same transaction as all class inserts and the saved
request result. New class reception is the submitted boolean, not forced true: the UI
starts new rows ON and permits explicit OFF. Existing group reception is not updated;
existing class flags use their current snapshot unless explicitly changed by the admin.
Lifecycle constraints and capacity guards remain effective.

## Local verification
Mock checks: `node --test tests/occurrence-editor.test.mjs tests/occurrence-editor-screen.test.mjs`
Isolated PostgreSQL: `SHINSEIKAI_OCCURRENCE_DB_TEST=1 node --test tests/occurrence-editor-db.test.mjs`
The existing runner requires a local Docker Desktop Unix socket and the preloaded image;
uses `--pull=never`, `--network none`, no mounts/ports, disabled TCP and its own temporary
container only. Its cleanup stops only that container; `--rm` removes it. Cloud DBs are never used.

## Preview application (manual; not performed by this work)
1. Verify project ref `ofyxyiumpjsfmycchbki`; never use the production project.
2. Before any application, save the existing function definition and permission results:

```sql
select pg_get_functiondef('public.admin_save_occurrence(uuid,jsonb)'::regprocedure);
select pg_get_userbyid(proowner) as owner, prosecdef, proconfig, proacl
from pg_proc where oid='public.admin_save_occurrence(uuid,jsonb)'::regprocedure;
select has_function_privilege('anon','public.admin_save_occurrence(uuid,jsonb)','execute') as anon_execute,
       has_function_privilege('authenticated','public.admin_save_occurrence(uuid,jsonb)','execute') as authenticated_execute,
       has_function_privilege('service_role','public.admin_save_occurrence(uuid,jsonb)','execute') as service_execute;
```

3. Compare the actual definition with 20261025. Stop if unexplained custom changes exist.
   Expected: existing postgres owner, SECURITY DEFINER, empty search_path; authenticated
   execute only, plus the internal administrator check. Check prerequisites and lifecycle
   columns/trigger/check constraint before proceeding. Do not apply the baseline or deletion SQL.
4. Pause occurrence creation during the coordinated preview migration/UI release. Existing
   deployed UI defaults classes OFF; apply and verify the ON-default UI and matching review/
   success text together with the RPC change before resuming normal creation. Close old
   editor tabs and inspect pending attempts; do not erase uncertain save keys to recreate them.
5. Execute the complete new migration once in SQL Editor. If it fails, do not rerun blindly:
   check transaction state, the exact error, current function definition and permissions.
6. Repeat the read-only queries above. Verify the sole body change and unchanged properties.
7. With approved synthetic preview data, test single/multiple creation, explicit OFF,
   stopped-group edits, ON class additions, cancellation/hidden constraints, rollback,
   replay/conflict, capacity and proxy restrictions. An open class must accept public
   registration only when its parent is open and unblocked. These cloud checks are not run here.

## Replay and rollback
Already-succeeded old keys return their original result without opening their saved group.
Recovered/uncertain UI successes therefore direct the admin to inspect current state instead
of claiming that replay opened reception. No automatic retry or second opening API is added.

To roll back, pause new creation and restore the exact pre-application function definition
using CREATE OR REPLACE in a transaction, then verify owner/security/search_path/permissions.
Use the captured definition rather than DROP FUNCTION or deleting private save requests.
Restore matching UI messaging/defaults as appropriate. This changes future new creations only:
groups created ON remain ON, and replay keys retain their original results. If necessary,
stop individual affected groups through existing admin controls; do not delete history.
