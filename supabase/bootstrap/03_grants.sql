-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 3/4: GRANTs sobre el schema `cucinaerp`
--
-- Correr DESPUÉS de 01_clone_schema_estructura.sql y 02_aislar.sql.
-- Replica el patrón que Supabase aplica a `public`: los roles de PostgREST
-- (anon / authenticated / service_role) reciben acceso al schema, y lo que
-- realmente filtra el acceso es RLS, que ya vino clonado en el paso 1.
--
-- Después de esto: Supabase → Settings → API → "Exposed schemas" → agregar
-- `cucinaerp`. Sin ese paso PostgREST no ve el schema por más grants que haya.
-- =============================================================================

BEGIN;

-- ── Acceso al schema ─────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA cucinaerp TO anon, authenticated, service_role;
GRANT ALL   ON SCHEMA cucinaerp TO postgres;

-- ── Objetos que ya existen ───────────────────────────────────────────────────
GRANT ALL ON ALL TABLES    IN SCHEMA cucinaerp TO anon, authenticated, service_role, postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA cucinaerp TO anon, authenticated, service_role, postgres;
GRANT ALL ON ALL ROUTINES  IN SCHEMA cucinaerp TO anon, authenticated, service_role, postgres;

-- ── Objetos futuros (migraciones que corras más adelante) ────────────────────
-- Se declara por cada rol creador posible: los privilegios por defecto se
-- resuelven según QUIÉN crea el objeto, no según quién corre este script.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA cucinaerp
  GRANT ALL ON TABLES    TO anon, authenticated, service_role, postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA cucinaerp
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role, postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA cucinaerp
  GRANT ALL ON ROUTINES  TO anon, authenticated, service_role, postgres;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA cucinaerp
  GRANT ALL ON TABLES    TO anon, authenticated, service_role, postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA cucinaerp
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role, postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA cucinaerp
  GRANT ALL ON ROUTINES  TO anon, authenticated, service_role, postgres;

COMMIT;

-- ── Verificación ─────────────────────────────────────────────────────────────
-- Debe listar anon / authenticated / service_role con USAGE sobre el schema.
SELECT grantee, privilege_type
FROM information_schema.usage_privileges
WHERE object_schema = 'cucinaerp'
UNION ALL
SELECT r.rolname, 'USAGE(schema)'
FROM pg_roles r
WHERE r.rolname IN ('anon','authenticated','service_role','postgres')
  AND has_schema_privilege(r.rolname, 'cucinaerp', 'USAGE');

-- Tablas sin RLS habilitado: idealmente vacío. Cualquier fila acá es una tabla
-- que anon podría leer entera una vez que expongas el schema.
SELECT c.relname AS tabla_sin_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'cucinaerp' AND c.relkind = 'r' AND NOT c.relrowsecurity
ORDER BY 1;
