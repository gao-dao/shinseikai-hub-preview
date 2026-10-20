// Catalog reads only. No applicant rows, key values, role passwords or tokens.
// This scope includes the private tables' columns, constraints and indexes.
const scope = alias => `${alias}.nspname IN ('public','registration_private')`
const grantObject = `jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)`
const acl = (expression, type, owner) => `(SELECT coalesce(jsonb_agg(${grantObject}),'[]'::jsonb) FROM aclexplode(coalesce(${expression},acldefault('${type}',${owner}))) a)`
const relationId = `jsonb_build_array(n.nspname,c.relname)`
const relations = `FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`

export const READ_CONTEXT = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
SET LOCAL extra_float_digits=3;`

export const METADATA_QUERIES = Object.freeze({
  rpc: `SELECT jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) id,
    pg_get_userbyid(p.proowner) owner,l.lanname language,pg_get_functiondef(p.oid) definition,
    p.prosecdef security_definer,p.proconfig config,p.proacl IS NULL acl_is_null,
    ${acl('p.proacl', 'f', 'p.proowner')} acl,
    (SELECT jsonb_agg(jsonb_build_array(r,has_function_privilege(r,p.oid,'EXECUTE')) ORDER BY r)
      FROM unnest(ARRAY['anon','authenticated','service_role']) roles(r)) execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE (${scope('n')} OR (n.nspname='auth' AND p.proname='uid')) AND p.prokind IN ('f','p')`,
  tables: `SELECT ${relationId} id,c.relkind::text kind,pg_get_userbyid(c.relowner) owner,
    c.relrowsecurity rls,c.relforcerowsecurity force_rls,c.relacl IS NULL acl_is_null,
    ${acl('c.relacl', 'r', 'c.relowner')} acl,${acl('NULL', 'r', 'c.relowner')} acl_default ${relations}
    WHERE ${scope('n')} AND c.relkind IN ('r','p','v','m')`,
  columns: `SELECT jsonb_build_array(n.nspname,c.relname,a.attname) id,a.attnum::int AS "position",
    format_type(a.atttypid,a.atttypmod) AS "type",a.attnotnull not_null,
    pg_get_expr(d.adbin,d.adrelid,false) default_expression,a.attidentity::text AS "identity",a.attgenerated::text AS "generated",
    CASE WHEN a.attcollation=0 THEN NULL ELSE format('%I.%I',cn.nspname,co.collname) END collation
    ${relations} JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
    WHERE ${scope('n')} AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped`,
  policies: `SELECT jsonb_build_array(schemaname,tablename,policyname) id,
    permissive,roles,cmd command,qual using_expression,with_check check_expression
    FROM pg_policies WHERE schemaname IN ('public','registration_private')`,
  constraints: `SELECT jsonb_build_array(n.nspname,c.relname,k.conname) id,k.contype::text type,
    k.convalidated validated,k.condeferrable AS "deferrable",k.condeferred initially_deferred,pg_get_constraintdef(k.oid,false) definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope('n')}`,
  triggers: `SELECT jsonb_build_array(n.nspname,c.relname,t.tgname) id,t.tgenabled::text enabled,pg_get_triggerdef(t.oid,false) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE ${scope('n')} AND NOT t.tgisinternal`,
  event_triggers: `SELECT jsonb_build_array(e.evtname) id,e.evtevent event,pg_get_userbyid(e.evtowner) owner,
    format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS "function",
    e.evtenabled::text enabled,e.evttags tags FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace`,
  indexes: `SELECT jsonb_build_array(n.nspname,c.relname,ic.relname) id,
    pg_get_indexdef(i.indexrelid,0,false) definition,i.indisvalid valid,i.indisready ready,i.indisunique AS "unique",i.indisprimary AS "primary"
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${scope('n')}`,
  extensions: `SELECT jsonb_build_array(e.extname) id,e.extversion version,n.nspname schema,pg_get_userbyid(e.extowner) owner
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace`,
  roles: `SELECT jsonb_build_array(rolname) id,rolsuper superuser,rolinherit inherit,rolcreaterole create_role,rolcreatedb create_db,
    rolcanlogin login,rolreplication replication,rolbypassrls bypass_rls,rolconnlimit connection_limit,rolconfig config FROM pg_roles`,
  memberships: `SELECT jsonb_build_array(pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)) id,
    admin_option admin,inherit_option inherit,set_option AS "set" FROM pg_auth_members`,
  default_acl: `SELECT jsonb_build_array(pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype::text) id,
    coalesce((SELECT jsonb_agg(${grantObject}) FROM aclexplode(d.defaclacl) a),'[]'::jsonb) acl
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace`,
  schemas: `SELECT jsonb_build_array(n.nspname) id,pg_get_userbyid(n.nspowner) owner,n.nspacl IS NULL acl_is_null,
    ${acl('n.nspacl', 'n', 'n.nspowner')} acl,${acl('NULL', 'n', 'n.nspowner')} acl_default FROM pg_namespace n WHERE ${scope('n')}`,
  sequence_associations: `SELECT jsonb_build_array(n.nspname,c.relname,a.attname) id,jsonb_build_array(sn.nspname,s.relname) sequence
    FROM pg_class s JOIN pg_namespace sn ON sn.oid=s.relnamespace
    JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid
    WHERE s.relkind='S' AND sn.nspname NOT LIKE 'pg_%' AND NOT a.attisdropped`,
  sequences: `SELECT jsonb_build_array(n.nspname,c.relname) id,pg_get_userbyid(c.relowner) owner,format_type(s.seqtypid,NULL) type,
    s.seqstart::text AS "start",s.seqincrement::text increment,s.seqmin::text min,s.seqmax::text max,s.seqcycle cycle,s.seqcache::text cache
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%'`,
})

export function quoteIdentifier(name) {
  if (typeof name !== 'string' || name.includes('\0')) throw new Error('INVALID_IDENTIFIER')
  return `"${name.replaceAll('"', '""')}"`
}

export function sequenceStateQuery(id) {
  if (!Array.isArray(id) || id.length !== 2) throw new Error('INVALID_SEQUENCE_ID')
  return `SELECT last_value::text last_value,is_called FROM ${id.map(quoteIdentifier).join('.')}`
}

export async function collectMetadata(readQuery) {
  const snapshot = {}
  for (const [category, query] of Object.entries(METADATA_QUERIES)) {
    try {
      const rows = await readQuery(query)
      if (!Array.isArray(rows)) throw new Error('INVALID_QUERY_RESULT')
      snapshot[category] = { status: 'ok', rows }
    } catch {
      snapshot[category] = { status: 'error', code: 'QUERY_FAILED' }
    }
  }
  try {
    if (snapshot.sequences.status !== 'ok') throw new Error('SEQUENCE_DEFINITION_UNAVAILABLE')
    const states = []
    for (const sequence of snapshot.sequences.rows) {
      const rows = await readQuery(sequenceStateQuery(sequence.id))
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error('INVALID_SEQUENCE_STATE')
      states.push({ id: sequence.id, last_value: rows[0].last_value, is_called: rows[0].is_called })
    }
    snapshot.sequence_states = { status: 'ok', rows: states }
  } catch {
    snapshot.sequence_states = { status: 'error', code: 'QUERY_FAILED' }
  }
  return snapshot
}
