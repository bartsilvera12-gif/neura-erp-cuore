-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 5: vincular un usuario de Supabase Auth con la empresa, creando su fila
--         en `cucinaerp.usuarios`.
--
-- Requisito: el usuario ya tiene que existir en Supabase Auth (Authentication →
-- Users → Add user). Este script NO crea usuarios ni maneja contraseñas: sólo
-- crea la fila del ERP y la ata al usuario de Auth que ya existe.
--
-- El ERP resuelve la sesión así (src/lib/auth/resolve-usuario-erp.ts):
--   1º por `auth_user_id`  ← la vía confiable, la que llena este script
--   2º por `email` (con variantes)
--
-- Es idempotente: si el usuario ya está vinculado, avisa y no hace nada.
-- Si hay columnas NOT NULL que no sabe llenar, aborta y vuelca la estructura
-- de la tabla en vez de crear una fila a medias.
-- =============================================================================

BEGIN;

DO $usr$
DECLARE
  dst        text := 'cucinaerp';

  -- ── Ajustá estos tres valores ─────────────────────────────────────────────
  v_email    text := 'admin@cucinadelcoure.com';   -- el mismo de Supabase Auth
  v_nombre   text := 'Administrador';
  v_rol      text := 'super_admin';            -- admin | super_admin | mozo
  -- ──────────────────────────────────────────────────────────────────────────

  v_auth_id  uuid;
  v_empresa  uuid;
  nueva_id   uuid := gen_random_uuid();
  col_names  text[] := '{}';
  col_vals   text[] := '{}';
  faltantes  text;
  todas      text;
  c          text;
  rel        regclass;
  n          int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class cl JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE ns.nspname = dst AND cl.relname = 'usuarios' AND cl.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'No existe %.usuarios. ¿El PASO 1 corrió bien?', dst;
  END IF;

  rel := (dst || '.usuarios')::regclass;

  -- ── El usuario de Auth ─────────────────────────────────────────────────────
  SELECT id INTO v_auth_id FROM auth.users WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION
      'No hay ningún usuario en Supabase Auth con el email %. Crealo primero en Authentication → Users, o corregí v_email arriba.',
      v_email;
  END IF;

  -- ── La empresa (instancia monocliente: hay una sola) ───────────────────────
  EXECUTE format('SELECT id FROM %I.empresas LIMIT 1', dst) INTO v_empresa;
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa en %.empresas. Corré primero 04_empresa_cucina.sql.', dst;
  END IF;

  -- ── ¿Ya está vinculado? ────────────────────────────────────────────────────
  EXECUTE format(
    'SELECT count(*) FROM %I.usuarios WHERE auth_user_id = $1 OR lower(email) = lower($2)', dst)
    INTO n USING v_auth_id, v_email;
  IF n > 0 THEN
    RAISE NOTICE 'El usuario % ya tiene fila en %.usuarios. No se hace nada.', v_email, dst;
    RETURN;
  END IF;

  -- ── Armar el INSERT con las columnas que realmente existan ────────────────
  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel
             AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped) THEN
    col_names := col_names || 'id'::text;
    col_vals  := col_vals  || (quote_literal(nueva_id::text) || '::uuid');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel
             AND a.attname = 'auth_user_id' AND a.attnum > 0 AND NOT a.attisdropped) THEN
    col_names := col_names || 'auth_user_id'::text;
    col_vals  := col_vals  || (quote_literal(v_auth_id::text) || '::uuid');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel
             AND a.attname = 'empresa_id' AND a.attnum > 0 AND NOT a.attisdropped) THEN
    col_names := col_names || 'empresa_id'::text;
    col_vals  := col_vals  || (quote_literal(v_empresa::text) || '::uuid');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel
             AND a.attname = 'email' AND a.attnum > 0 AND NOT a.attisdropped) THEN
    col_names := col_names || 'email'::text;
    col_vals  := col_vals  || quote_literal(v_email);
  END IF;

  FOREACH c IN ARRAY ARRAY['nombre','nombre_completo','full_name'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel
               AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT (c = ANY (col_names)) THEN
      col_names := col_names || c;
      col_vals  := col_vals  || quote_literal(v_nombre);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel
             AND a.attname = 'rol' AND a.attnum > 0 AND NOT a.attisdropped) THEN
    col_names := col_names || 'rol'::text;
    col_vals  := col_vals  || quote_literal(v_rol);
  END IF;

  FOREACH c IN ARRAY ARRAY['activo','activa'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel
               AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT (c = ANY (col_names)) THEN
      col_names := col_names || c;
      col_vals  := col_vals  || 'true'::text;
    END IF;
  END LOOP;

  -- ── ¿Queda alguna columna obligatoria sin resolver? ───────────────────────
  SELECT string_agg(a.attname || ' (' || format_type(a.atttypid, a.atttypmod) || ')',
                    ', ' ORDER BY a.attnum)
    INTO faltantes
  FROM pg_attribute a
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE a.attrelid = rel
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attnotnull AND ad.adbin IS NULL
    AND a.attidentity = '' AND a.attgenerated = ''
    AND NOT (a.attname::text = ANY (col_names));

  IF faltantes IS NOT NULL THEN
    SELECT string_agg(
             a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
             || CASE WHEN ad.adbin IS NOT NULL
                     THEN ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid) ELSE '' END,
             E'\n    ' ORDER BY a.attnum)
      INTO todas
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped;

    RAISE EXCEPTION E'Faltan columnas obligatorias en %.usuarios: %\n\n  Estructura completa de la tabla:\n    %\n\n  Agregá esos valores en el bloque de arriba y volvé a correr.',
      dst, faltantes, todas;
  END IF;

  EXECUTE format('INSERT INTO %I.usuarios (%s) VALUES (%s)',
                 dst,
                 (SELECT string_agg(quote_ident(x), ', ') FROM unnest(col_names) AS u(x)),
                 array_to_string(col_vals, ', '));

  RAISE NOTICE '────────────────────────────────────────────────────────';
  RAISE NOTICE 'Usuario vinculado.';
  RAISE NOTICE '  email        = %', v_email;
  RAISE NOTICE '  rol          = %', v_rol;
  RAISE NOTICE '  auth_user_id = %', v_auth_id;
  RAISE NOTICE '  empresa_id   = %', v_empresa;
  RAISE NOTICE '────────────────────────────────────────────────────────';
END
$usr$;

COMMIT;

-- ── Verificación: la fila del ERP atada a su usuario de Auth ─────────────────
SELECT u.*, au.email AS auth_email, au.email_confirmed_at
FROM cucinaerp.usuarios u
LEFT JOIN auth.users au ON au.id = u.auth_user_id;
