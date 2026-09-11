-- =============================================================================
-- Neura ERP — Cucina del Cuore · BOOTSTRAP COMPLETO (schema + tablas + grants + empresa)
--
-- Equivale a correr 01 + 02 + 03 + 04 de esta carpeta, pero en UNA SOLA TRANSACCIÓN:
-- o entra todo, o no entra nada.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar TODO → Run.
--                (o: psql "$SUPABASE_DB_URL" -f 00_bootstrap_completo.sql)
--
-- PASO 1 — clona la ESTRUCTURA de `caribenaerp` en `cucinaerp`, leyendo el
--          catálogo en vivo: tipos ENUM/DOMAIN → secuencias → funciones →
--          tablas (columnas, tipos, defaults, identity, generated, NOT NULL) →
--          constraints PK/UNIQUE/CHECK/EXCLUDE con sus nombres originales →
--          índices → foreign keys → vistas y matviews (WITH NO DATA) →
--          triggers → RLS + todas las policies → comentarios.
--          SIN DATOS: el schema queda vacío y las secuencias en su valor inicial.
-- PASO 2 — AÍSLA el schema: corta toda dependencia hacia `public` y `zentra_erp`
--          (FKs, funciones, policies, triggers, defaults, vistas), clonando
--          localmente las funciones que hagan falta. Termina con un reporte de
--          lo que no se pudo aislar.
-- PASO 3 — GRANTs para anon / authenticated / service_role / postgres, más
--          ALTER DEFAULT PRIVILEGES para los objetos que crees más adelante.
-- PASO 4 — crea la empresa Cucina del Cuore con un UUID nuevo (independiente del de
--          En lo de Mari) y le replica el allowlist de módulos.
--
-- Lo único que queda compartido, por diseño de Supabase, es la infraestructura
-- del proyecto: `auth`, `storage`, `extensions`, `pg_catalog`. Para desacoplar
-- también eso hace falta un proyecto Supabase aparte.
--
-- Aborta si `cucinaerp` ya existe. Para rehacerlo:
--     DROP SCHEMA cucinaerp CASCADE;
--
-- Al terminar imprime por NOTICE el EMPRESA_ID de Cucina del Cuore, y las queries del
-- final comparan conteos entre origen y destino.
--
-- DESPUÉS de correr esto:
--   1. Supabase → Settings → API → Exposed schemas → agregar `cucinaerp`.
--   2. En Vercel/.env.local: NEURA_CLIENT_SCHEMA=cucinaerp
--                            NEURA_INSTANCE_MODE=single_client
-- =============================================================================

BEGIN;

-- search_path neutro: fuerza a que pg_get_*def() califique TODO con su schema,
-- para poder reescribir `caribenaerp.` → `cucinaerp.` de forma confiable.
SET LOCAL search_path = pg_catalog;
-- Permite crear funciones cuyo cuerpo referencia tablas que aún no existen.
SET LOCAL check_function_bodies = false;

-- Reescribe el nombre del schema origen por el destino, respetando límites de
-- identificador (no toca `caribenaerp_algo` ni `public.caribenaerp`).
CREATE FUNCTION pg_temp.remap(t text, src text, dst text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(
             coalesce(t, ''),
             '"' || src || '"', '"' || dst || '"', 'g'),
           '(^|[^A-Za-z0-9_$."])' || src || '(?=[^A-Za-z0-9_$]|$)',
           '\1' || dst, 'g')
$fn$;

-- Reescribe `public.x` / `zentra_erp.x` → `cucinaerp.x`, pero SÓLO si
-- `cucinaerp.x` existe (tabla, vista, función o tipo). Si no existe, no
-- inventa nada: deja la referencia como está y el reporte final la lista.
CREATE FUNCTION pg_temp.localizar(t text, dst text)
RETURNS text LANGUAGE plpgsql STABLE AS $lz$
DECLARE
  m     text[];
  out_t text := coalesce(t, '');
  sch   text;
  obj   text;
BEGIN
  IF out_t = '' THEN
    RETURN out_t;
  END IF;
  FOR m IN
    SELECT DISTINCT x
    FROM pg_catalog.regexp_matches(out_t,
           '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS g(x)
  LOOP
    sch := m[1];
    obj := m[2];
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = dst AND c.relname = obj)
       OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = dst AND p.proname = obj)
       OR EXISTS (SELECT 1 FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
               WHERE n.nspname = dst AND ty.typname = obj) THEN
      out_t := pg_catalog.regexp_replace(out_t,
                 '(^|[^A-Za-z0-9_$."])' || sch || '\.' || obj || '(?=[^A-Za-z0-9_$]|$)',
                 '\1' || dst || '.' || obj, 'g');
    END IF;
  END LOOP;
  RETURN out_t;
END
$lz$;

-- Todo el texto de definiciones del schema, para detectar qué referencias
-- externas siguen vivas.
CREATE FUNCTION pg_temp.inventario(dst text)
RETURNS text LANGUAGE sql STABLE AS $inv$
  SELECT pg_catalog.string_agg(d, E'\n') FROM (
    SELECT pg_catalog.pg_get_functiondef(p.oid) AS d
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = dst AND p.prokind IN ('f','p')
    UNION ALL
    SELECT pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)
      FROM pg_attrdef ad JOIN pg_class c ON c.oid = ad.adrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = dst
    UNION ALL
    SELECT pg_catalog.pg_get_constraintdef(co.oid)
      FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = dst
    UNION ALL
    SELECT pg_catalog.pg_get_indexdef(i.indexrelid)
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
     WHERE n.nspname = dst
    UNION ALL
    SELECT pg_catalog.pg_get_viewdef(c.oid, true)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = dst AND c.relkind IN ('v','m')
    UNION ALL
    SELECT pg_catalog.pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = dst AND NOT t.tgisinternal
    UNION ALL
    SELECT coalesce(pol.qual,'') || ' ' || coalesce(pol.with_check,'')
      FROM pg_catalog.pg_policies pol
     WHERE pol.schemaname = dst
  ) q
$inv$;


-- #############################################################################
-- ## PASO 1 — ESTRUCTURA
-- #############################################################################

DO $clone$
DECLARE
  src        text := 'caribenaerp';
  dst        text := 'cucinaerp';
  r          record;
  cols       text;
  stmt       text;
  pendientes text[] := '{}';
  pend2      text[];
  s          text;
  pasada     int;
  n_tablas   int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = src) THEN
    RAISE EXCEPTION 'El schema origen "%" no existe en esta base.', src;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = dst) THEN
    RAISE EXCEPTION 'El schema destino "%" ya existe. Para rehacerlo: DROP SCHEMA % CASCADE;', dst, dst;
  END IF;

  EXECUTE pg_catalog.format('CREATE SCHEMA %I', dst);
  RAISE NOTICE 'Schema % creado.', dst;

  ---------------------------------------------------------------------------
  -- 1.1 Tipos ENUM y DOMAIN propios del schema
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT t.oid, t.typname, t.typtype, t.typbasetype, t.typtypmod,
           t.typnotnull, t.typdefault
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = src AND t.typtype IN ('e', 'd')
    ORDER BY t.typtype, t.typname
  LOOP
    IF r.typtype = 'e' THEN
      SELECT pg_catalog.string_agg(pg_catalog.quote_literal(e.enumlabel), ', '
                                   ORDER BY e.enumsortorder)
        INTO cols
      FROM pg_enum e WHERE e.enumtypid = r.oid;
      EXECUTE pg_catalog.format('CREATE TYPE %I.%I AS ENUM (%s)', dst, r.typname, cols);
    ELSE
      stmt := pg_catalog.format('CREATE DOMAIN %I.%I AS %s', dst, r.typname,
                pg_temp.remap(pg_catalog.format_type(r.typbasetype, r.typtypmod), src, dst));
      IF r.typdefault IS NOT NULL THEN
        stmt := stmt || ' DEFAULT ' || pg_catalog.quote_literal(r.typdefault);
      END IF;
      IF r.typnotnull THEN
        stmt := stmt || ' NOT NULL';
      END IF;
      SELECT coalesce(
               pg_catalog.string_agg(' CONSTRAINT ' || pg_catalog.quote_ident(c.conname)
                 || ' ' || pg_temp.remap(pg_catalog.pg_get_constraintdef(c.oid), src, dst), ' '),
               '')
        INTO cols
      FROM pg_constraint c WHERE c.contypid = r.oid;
      EXECUTE stmt || cols;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.2 Secuencias independientes (las de columnas IDENTITY se crean solas).
  --     START WITH = valor inicial original: el contador arranca de cero, no
  --     hereda el último valor consumido por En lo de Mari.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, s.seqtypid, s.seqstart, s.seqincrement,
           s.seqmax, s.seqmin, s.seqcache, s.seqcycle
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_sequence s  ON s.seqrelid = c.oid
    WHERE n.nspname = src AND c.relkind = 'S'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'i')
    ORDER BY c.relname
  LOOP
    EXECUTE pg_catalog.format(
      'CREATE SEQUENCE %I.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s %s',
      dst, r.relname, pg_catalog.format_type(r.seqtypid, NULL),
      r.seqincrement, r.seqmin, r.seqmax, r.seqstart, r.seqcache,
      CASE WHEN r.seqcycle THEN 'CYCLE' ELSE 'NO CYCLE' END);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.3 Funciones y procedimientos (primera pasada; las que fallen se
  --     reintentan en 1.9, ya con tablas y vistas creadas)
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT pg_catalog.pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = src AND p.prokind IN ('f', 'p')
    ORDER BY p.proname
  LOOP
    stmt := pg_temp.remap(r.def, src, dst);
    BEGIN
      EXECUTE stmt;
    EXCEPTION WHEN others THEN
      pendientes := pendientes || stmt;
    END;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.4 Tablas: columnas, tipos, defaults, identity, generated, NOT NULL
  ---------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = src AND c.relkind = 'p') THEN
    RAISE NOTICE 'Ojo: hay tablas particionadas en %; se crean como tabla plana (sin particiones).', src;
  END IF;

  FOR r IN
    SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = src AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  LOOP
    SELECT pg_catalog.string_agg(
             pg_catalog.format('%I %s%s%s',
               a.attname,
               pg_temp.remap(pg_catalog.format_type(a.atttypid, a.atttypmod), src, dst),
               CASE
                 WHEN a.attidentity <> '' THEN
                   ' GENERATED ' || CASE a.attidentity WHEN 'a' THEN 'ALWAYS' ELSE 'BY DEFAULT' END
                   || ' AS IDENTITY'
                 WHEN a.attgenerated <> '' THEN
                   ' GENERATED ALWAYS AS ('
                   || pg_temp.remap(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), src, dst)
                   || ') STORED'
                 WHEN ad.adbin IS NOT NULL THEN
                   ' DEFAULT ' || pg_temp.remap(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), src, dst)
                 ELSE ''
               END,
               CASE WHEN a.attnotnull AND a.attidentity = '' THEN ' NOT NULL' ELSE '' END),
             E',
  ' ORDER BY a.attnum)
      INTO cols
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped;

    IF cols IS NULL THEN
      EXECUTE pg_catalog.format('CREATE TABLE %I.%I ()', dst, r.relname);
    ELSE
      EXECUTE pg_catalog.format('CREATE TABLE %I.%I (
  %s
)', dst, r.relname, cols);
    END IF;
  END LOOP;

  SELECT pg_catalog.count(*) INTO n_tablas
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = dst AND c.relkind = 'r';
  RAISE NOTICE '% tablas creadas en %.', n_tablas, dst;

  ---------------------------------------------------------------------------
  -- 1.5 Constraints PK / UNIQUE / EXCLUDE / CHECK, conservando sus nombres
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, con.conname, pg_catalog.pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = src AND con.contype IN ('p', 'u', 'c', 'x')
    ORDER BY CASE con.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'x' THEN 3 ELSE 4 END,
             c.relname, con.conname
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
              dst, r.relname, r.conname, pg_temp.remap(r.def, src, dst));
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.6 Índices que no respaldan un constraint
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class ic    ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = src
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                      WHERE con.conindid = i.indexrelid AND con.contype IN ('p','u','x'))
    ORDER BY ic.relname
  LOOP
    EXECUTE pg_temp.remap(r.def, src, dst);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.7 Foreign keys, ya con todas las tablas y sus PK/UNIQUE en su lugar.
  --     Las FK hacia public/zentra_erp/auth siguen apuntando a su schema.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, con.conname, pg_catalog.pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = src AND con.contype = 'f'
    ORDER BY c.relname, con.conname
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
              dst, r.relname, r.conname, pg_temp.remap(r.def, src, dst));
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.8 Vistas y matviews, con reintentos por dependencias entre sí
  ---------------------------------------------------------------------------
  pend2 := '{}';
  FOR r IN
    SELECT c.relname, c.relkind, pg_catalog.pg_get_viewdef(c.oid, true) AS def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = src AND c.relkind IN ('v', 'm')
    ORDER BY c.relname
  LOOP
    IF r.relkind = 'v' THEN
      pend2 := pend2 || pg_catalog.format('CREATE VIEW %I.%I AS %s',
                 dst, r.relname,
                 pg_catalog.rtrim(pg_catalog.rtrim(pg_temp.remap(r.def, src, dst)), ';'));
    ELSE
      pend2 := pend2 || pg_catalog.format('CREATE MATERIALIZED VIEW %I.%I AS %s WITH NO DATA',
                 dst, r.relname,
                 pg_catalog.rtrim(pg_catalog.rtrim(pg_temp.remap(r.def, src, dst)), ';'));
    END IF;
  END LOOP;

  pasada := 0;
  WHILE pg_catalog.array_length(pend2, 1) > 0 AND pasada < 12 LOOP
    pasada := pasada + 1;
    DECLARE
      restantes text[] := '{}';
    BEGIN
      FOREACH s IN ARRAY pend2 LOOP
        BEGIN
          EXECUTE s;
        EXCEPTION WHEN others THEN
          restantes := restantes || s;
        END;
      END LOOP;
      IF pg_catalog.array_length(restantes, 1)
         IS NOT DISTINCT FROM pg_catalog.array_length(pend2, 1) THEN
        -- Ninguna avanzó en esta pasada: reejecutar sin capturar, para que el
        -- error real se propague en vez de girar en falso.
        FOREACH s IN ARRAY restantes LOOP
          EXECUTE s;
        END LOOP;
      END IF;
      pend2 := restantes;
    END;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.9 Funciones pendientes de 1.3
  ---------------------------------------------------------------------------
  IF pg_catalog.array_length(pendientes, 1) > 0 THEN
    FOREACH s IN ARRAY pendientes LOOP
      EXECUTE s;   -- si vuelve a fallar, el error se propaga y la TX aborta
    END LOOP;
  END IF;

  ---------------------------------------------------------------------------
  -- 1.10 Triggers
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT pg_catalog.pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = src AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname
  LOOP
    EXECUTE pg_temp.remap(r.def, src, dst);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.11 RLS: habilitarlo en las mismas tablas y recrear todas las policies
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = src AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', dst, r.relname);
    IF r.relforcerowsecurity THEN
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', dst, r.relname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT p.tablename, p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = src
    ORDER BY p.tablename, p.policyname
  LOOP
    SELECT pg_catalog.string_agg(
             CASE WHEN x IN ('public', '-') THEN 'public' ELSE pg_catalog.quote_ident(x) END, ', ')
      INTO cols
    FROM pg_catalog.unnest(r.roles::text[]) AS u(x);

    EXECUTE pg_catalog.format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s %s %s',
      r.policyname, dst, r.tablename,
      CASE WHEN pg_catalog.upper(r.permissive) = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      r.cmd,
      coalesce(cols, 'public'),
      CASE WHEN r.qual IS NOT NULL
           THEN 'USING (' || pg_temp.remap(r.qual, src, dst) || ')' ELSE '' END,
      CASE WHEN r.with_check IS NOT NULL
           THEN 'WITH CHECK (' || pg_temp.remap(r.with_check, src, dst) || ')' ELSE '' END);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1.12 Comentarios de tablas y columnas
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, pg_catalog.obj_description(c.oid, 'pg_class') AS cmt
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = src AND c.relkind IN ('r', 'p', 'v', 'm')
      AND pg_catalog.obj_description(c.oid, 'pg_class') IS NOT NULL
  LOOP
    EXECUTE pg_catalog.format('COMMENT ON TABLE %I.%I IS %L', dst, r.relname, r.cmt);
  END LOOP;

  FOR r IN
    SELECT c.relname, a.attname, pg_catalog.col_description(c.oid, a.attnum) AS cmt
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = src AND c.relkind IN ('r', 'p', 'v', 'm')
      AND pg_catalog.col_description(c.oid, a.attnum) IS NOT NULL
  LOOP
    EXECUTE pg_catalog.format('COMMENT ON COLUMN %I.%I.%I IS %L', dst, r.relname, r.attname, r.cmt);
  END LOOP;

  EXECUTE pg_catalog.format('COMMENT ON SCHEMA %I IS %L', dst,
    'Neura ERP - instancia dedicada Caribena. Estructura clonada de caribenaerp, sin datos.');

  RAISE NOTICE 'PASO 1 listo: estructura % -> % clonada.', src, dst;
END
$clone$;


-- #############################################################################
-- ## PASO 2 — AISLAMIENTO
-- ## Corta toda dependencia de `cucinaerp` hacia `public` y `zentra_erp`.
-- ## Regla de oro: sólo reescribe hacia local cuando la gemela local EXISTE.
-- ## Lo que no se puede aislar queda intacto y sale en el reporte final.
-- #############################################################################

DO $aislar$
DECLARE
  dst       text := 'cucinaerp';
  r         record;
  inv       text;
  nuevo     text;
  stmt      text;
  s         text;
  pend      text[];
  pasada    int;
  clonadas  int;
  n_cambios int := 0;
BEGIN
  ---------------------------------------------------------------------------
  -- 2.A Traer las funciones externas que el schema todavía llama.
  --     Iterativo: una función clonada puede llamar a otra.
  ---------------------------------------------------------------------------
  pasada := 0;
  LOOP
    pasada   := pasada + 1;
    clonadas := 0;
    EXIT WHEN pasada > 6;

    inv := coalesce(pg_temp.inventario(dst), '');

    FOR r IN
      SELECT DISTINCT x[1] AS sch, x[2] AS fname
      FROM pg_catalog.regexp_matches(inv,
             '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*\(', 'g') AS g(x)
    LOOP
      -- Sólo si allá es realmente una función y acá no hay gemela.
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = r.sch AND p.proname = r.fname AND p.prokind IN ('f','p'));
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = dst AND p.proname = r.fname);

      DECLARE
        p2 record;
      BEGIN
        FOR p2 IN
          SELECT p.oid,
                 pg_catalog.pg_get_functiondef(p.oid) AS def,
                 pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                 p.proconfig
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = r.sch AND p.proname = r.fname AND p.prokind IN ('f','p')
        LOOP
          -- Reapuntar el NOMBRE de la función al schema destino...
          stmt := pg_catalog.regexp_replace(
                    p2.def,
                    '^(CREATE OR REPLACE FUNCTION|CREATE FUNCTION|CREATE OR REPLACE PROCEDURE|CREATE PROCEDURE)[[:space:]]+'
                      || r.sch || '\.',
                    '\1 ' || dst || '.');
          -- ...y localizar lo que su cuerpo referencia y tenga gemela acá.
          stmt := pg_temp.localizar(stmt, dst);
          EXECUTE stmt;

          -- Si la original fijaba search_path, ponerlo con el schema propio primero.
          IF p2.proconfig IS NOT NULL
             AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p2.proconfig) AS pc(cfg)
                         WHERE cfg LIKE 'search\_path=%') THEN
            EXECUTE pg_catalog.format(
              'ALTER ROUTINE %I.%I(%s) SET search_path TO %I, public, extensions',
              dst, r.fname, p2.args, dst);
          END IF;

          clonadas  := clonadas + 1;
          n_cambios := n_cambios + 1;
          RAISE NOTICE '[2.A] función %.%(%) clonada a %.', r.sch, r.fname, p2.args, dst;
        END LOOP;
      END;
    END LOOP;

    EXIT WHEN clonadas = 0;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.B Cuerpos de las funciones locales
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT p.proname, pg_catalog.pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = dst AND p.prokind IN ('f','p')
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE nuevo;
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[2.B] función %.% reescrita.', dst, r.proname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.C Defaults de columnas
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, a.attname, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS def
    FROM pg_attrdef ad
    JOIN pg_class c     ON c.oid = ad.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    WHERE n.nspname = dst AND c.relkind IN ('r','p') AND a.attgenerated = ''
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s',
                dst, r.relname, r.attname, nuevo);
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[2.C] default de %.%.% reescrito.', dst, r.relname, r.attname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.D Foreign keys: repuntar a la tabla gemela local
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, co.conname, pg_catalog.pg_get_constraintdef(co.oid) AS def
    FROM pg_constraint co
    JOIN pg_class c      ON c.oid  = co.conrelid
    JOIN pg_namespace n  ON n.oid  = c.relnamespace
    JOIN pg_class cr     ON cr.oid = co.confrelid
    JOIN pg_namespace nr ON nr.oid = cr.relnamespace
    WHERE n.nspname = dst AND co.contype = 'f' AND nr.nspname <> dst
    ORDER BY c.relname, co.conname
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I DROP CONSTRAINT %I', dst, r.relname, r.conname);
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
                dst, r.relname, r.conname, nuevo);
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[2.D] FK %.% repuntada a local.', r.relname, r.conname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.E Check constraints
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, co.conname, pg_catalog.pg_get_constraintdef(co.oid) AS def
    FROM pg_constraint co
    JOIN pg_class c     ON c.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = dst AND co.contype = 'c'
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I DROP CONSTRAINT %I', dst, r.relname, r.conname);
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
                dst, r.relname, r.conname, nuevo);
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[2.E] CHECK %.% reescrito.', r.relname, r.conname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.F Índices con expresión
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT ic.relname AS idxname, pg_catalog.pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class ic    ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = dst
      AND NOT EXISTS (SELECT 1 FROM pg_constraint co
                      WHERE co.conindid = i.indexrelid AND co.contype IN ('p','u','x'))
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE pg_catalog.format('DROP INDEX %I.%I', dst, r.idxname);
      EXECUTE nuevo;
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[2.F] índice % reescrito.', r.idxname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.G Policies de RLS
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT p.tablename, p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = dst
    ORDER BY p.tablename, p.policyname
  LOOP
    CONTINUE WHEN pg_temp.localizar(coalesce(r.qual,''), dst)
                    IS NOT DISTINCT FROM coalesce(r.qual,'')
                  AND pg_temp.localizar(coalesce(r.with_check,''), dst)
                    IS NOT DISTINCT FROM coalesce(r.with_check,'');

    SELECT pg_catalog.string_agg(
             CASE WHEN x IN ('public','-') THEN 'public' ELSE pg_catalog.quote_ident(x) END, ', ')
      INTO stmt
    FROM pg_catalog.unnest(r.roles::text[]) AS u(x);

    EXECUTE pg_catalog.format('DROP POLICY %I ON %I.%I', r.policyname, dst, r.tablename);
    EXECUTE pg_catalog.format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s %s %s',
      r.policyname, dst, r.tablename,
      CASE WHEN pg_catalog.upper(r.permissive) = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      r.cmd,
      coalesce(stmt, 'public'),
      CASE WHEN r.qual IS NOT NULL
           THEN 'USING (' || pg_temp.localizar(r.qual, dst) || ')' ELSE '' END,
      CASE WHEN r.with_check IS NOT NULL
           THEN 'WITH CHECK (' || pg_temp.localizar(r.with_check, dst) || ')' ELSE '' END);
    n_cambios := n_cambios + 1;
    RAISE NOTICE '[2.G] policy % en % reescrita.', r.policyname, r.tablename;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.H Triggers
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, t.tgname, pg_catalog.pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = dst AND NOT t.tgisinternal
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE pg_catalog.format('DROP TRIGGER %I ON %I.%I', r.tgname, dst, r.relname);
      EXECUTE nuevo;
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[2.H] trigger % en % reescrito.', r.tgname, r.relname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2.I Vistas y matviews (drop de las afectadas + recreación con reintentos)
  ---------------------------------------------------------------------------
  pend := '{}';
  FOR r IN
    SELECT c.relname, c.relkind, pg_catalog.pg_get_viewdef(c.oid, true) AS def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = dst AND c.relkind IN ('v','m')
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    CONTINUE WHEN nuevo IS NOT DISTINCT FROM r.def;

    IF r.relkind = 'v' THEN
      pend := pend || pg_catalog.format('CREATE VIEW %I.%I AS %s',
                dst, r.relname, pg_catalog.rtrim(pg_catalog.rtrim(nuevo), ';'));
      EXECUTE pg_catalog.format('DROP VIEW %I.%I CASCADE', dst, r.relname);
    ELSE
      pend := pend || pg_catalog.format('CREATE MATERIALIZED VIEW %I.%I AS %s WITH NO DATA',
                dst, r.relname, pg_catalog.rtrim(pg_catalog.rtrim(nuevo), ';'));
      EXECUTE pg_catalog.format('DROP MATERIALIZED VIEW %I.%I CASCADE', dst, r.relname);
    END IF;
    n_cambios := n_cambios + 1;
  END LOOP;

  pasada := 0;
  WHILE pg_catalog.array_length(pend, 1) > 0 AND pasada < 12 LOOP
    pasada := pasada + 1;
    DECLARE
      restantes text[] := '{}';
    BEGIN
      FOREACH s IN ARRAY pend LOOP
        BEGIN
          EXECUTE s;
        EXCEPTION WHEN others THEN
          restantes := restantes || s;
        END;
      END LOOP;
      IF pg_catalog.array_length(restantes, 1)
         IS NOT DISTINCT FROM pg_catalog.array_length(pend, 1) THEN
        FOREACH s IN ARRAY restantes LOOP
          EXECUTE s;   -- que se propague el error real
        END LOOP;
      END IF;
      pend := restantes;
    END;
  END LOOP;

  RAISE NOTICE 'PASO 2 listo: % objetos aislados. Revisá el REPORTE del final.', n_cambios;
END
$aislar$;


-- #############################################################################
-- ## PASO 3 — GRANTS
-- ## Replica el patrón que Supabase aplica a `public`: los roles de PostgREST
-- ## reciben acceso al schema y lo que filtra de verdad es RLS, ya clonado.
-- #############################################################################

DO $grants$
DECLARE
  dst      text   := 'cucinaerp';
  destinos text[];
  creador  text;
  rol      text;
BEGIN
  SELECT pg_catalog.array_agg(x)
    INTO destinos
  FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role','postgres']) AS u(x)
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = x);

  IF destinos IS NULL THEN
    RAISE NOTICE 'Ningún rol de Supabase encontrado; se omiten los grants.';
    RETURN;
  END IF;

  -- Objetos que ya existen
  FOREACH rol IN ARRAY destinos LOOP
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO %I', dst, rol);
    EXECUTE pg_catalog.format('GRANT ALL ON ALL TABLES    IN SCHEMA %I TO %I', dst, rol);
    EXECUTE pg_catalog.format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO %I', dst, rol);
    EXECUTE pg_catalog.format('GRANT ALL ON ALL ROUTINES  IN SCHEMA %I TO %I', dst, rol);
  END LOOP;
  EXECUTE pg_catalog.format('GRANT ALL ON SCHEMA %I TO postgres', dst);

  -- Objetos futuros (migraciones que corras más adelante). Se declara por cada
  -- rol creador posible: los privilegios por defecto se resuelven según QUIÉN
  -- crea el objeto, no según quién corre este script.
  FOREACH creador IN ARRAY ARRAY['postgres','supabase_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = creador) THEN
      BEGIN
        FOREACH rol IN ARRAY destinos LOOP
          EXECUTE pg_catalog.format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL ON TABLES TO %I',
            creador, dst, rol);
          EXECUTE pg_catalog.format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL ON SEQUENCES TO %I',
            creador, dst, rol);
          EXECUTE pg_catalog.format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL ON ROUTINES TO %I',
            creador, dst, rol);
        END LOOP;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'Sin permiso para ALTER DEFAULT PRIVILEGES FOR ROLE %; se omite (no es bloqueante).', creador;
      END;
    END IF;
  END LOOP;

  RAISE NOTICE 'PASO 3 listo: grants aplicados sobre %.', dst;
END
$grants$;


-- #############################################################################
-- ## PASO 4 — EMPRESA CARIBEÑA (id propio)
-- ##
-- ## Defensivo: mira qué columnas existen realmente en `cucinaerp.empresas`
-- ## y sólo completa las que encuentra. Si hay columnas NOT NULL sin default
-- ## que no sabe llenar, aborta y te las lista, en vez de dejar la empresa a
-- ## medio crear.
-- #############################################################################

SET LOCAL search_path = pg_catalog, public, extensions;

DO $seed$
DECLARE
  dst        text   := 'cucinaerp';
  nombre_emp text   := 'Cucina del Cuore';        -- ← ajustá el nombre comercial
  ruc_emp    text   := NULL;              -- ← ajustá el RUC si lo tenés
  nueva_id   uuid   := gen_random_uuid();
  col_names  text[] := '{}';
  col_vals   text[] := '{}';
  faltantes  text;
  todas      text;
  cols_ins   text;
  cols_sel   text;
  c          text;
  n          int;
  rel        regclass;
  guard      record;
  nuevo_def  text;
  u          text;
  nombre_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class cl JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE ns.nspname = dst AND cl.relname = 'empresas' AND cl.relkind = 'r'
  ) THEN
    RAISE EXCEPTION 'No existe %.empresas. ¿El PASO 1 corrió bien?', dst;
  END IF;

  rel := (dst || '.empresas')::regclass;

  -- Instancia monocliente: una sola empresa. Si ya hay una, no crear otra.
  EXECUTE format('SELECT count(*) FROM %I.empresas', dst) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Ya hay % empresa(s) en %.empresas. Esta es una instancia monocliente: no se crea otra. Si querés rehacerla, borrá la fila existente primero.',
      n, dst;
  END IF;

  ---------------------------------------------------------------------------
  -- 4.1 Re-apuntar los locks monocliente heredados de caribenaerp
  ---------------------------------------------------------------------------

  -- Nombre de la empresa del schema origen, para limpiar también el texto de
  -- los mensajes de esos guards. Best-effort: si no se puede leer, se ignora.
  BEGIN
    FOREACH c IN ARRAY ARRAY['nombre','nombre_empresa','razon_social','nombre_comercial'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = 'caribenaerp.empresas'::regclass
                   AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped) THEN
        EXECUTE format('SELECT %I::text FROM caribenaerp.empresas LIMIT 1', c) INTO nombre_src;
        EXIT WHEN nombre_src IS NOT NULL AND nombre_src <> '';
      END IF;
    END LOOP;
  EXCEPTION WHEN others THEN
    nombre_src := NULL;
  END;

  FOR guard IN
    SELECT DISTINCT p.oid, p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c2      ON c2.oid = t.tgrelid
    JOIN pg_namespace n2  ON n2.oid = c2.relnamespace
    JOIN pg_proc p        ON p.oid  = t.tgfoid
    JOIN pg_namespace np  ON np.oid = p.pronamespace
    WHERE n2.nspname = dst AND c2.relname = 'empresas'
      AND NOT t.tgisinternal
      AND np.nspname = dst
  LOOP
    nuevo_def := guard.def;

    -- Cualquier UUID literal del cuerpo pasa a ser el de la empresa nueva.
    FOR u IN
      SELECT DISTINCT x[1]
      FROM regexp_matches(guard.def,
             '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
             'g') AS g(x)
    LOOP
      nuevo_def := replace(nuevo_def, u, nueva_id::text);
    END LOOP;

    -- Y el nombre viejo en los mensajes, si lo pudimos averiguar.
    IF nombre_src IS NOT NULL AND nombre_src <> '' AND nombre_src <> nombre_emp THEN
      nuevo_def := replace(nuevo_def, nombre_src, nombre_emp);
      nuevo_def := replace(nuevo_def, upper(nombre_src), upper(nombre_emp));
    END IF;

    IF nuevo_def IS DISTINCT FROM guard.def THEN
      EXECUTE nuevo_def;
      RAISE NOTICE '[4.1] lock monocliente %.%() re-apuntado a la empresa de Cucina del Cuore.',
        dst, guard.proname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.2 Insertar la empresa
  ---------------------------------------------------------------------------

  -- id
  IF EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = rel AND a.attname = 'id'
               AND a.attnum > 0 AND NOT a.attisdropped) THEN
    col_names := col_names || 'id'::text;
    col_vals  := col_vals  || (quote_literal(nueva_id::text) || '::uuid');
  END IF;

  -- nombre comercial (varias convenciones posibles)
  FOREACH c IN ARRAY ARRAY['nombre','nombre_empresa','razon_social','nombre_comercial'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = rel AND a.attname = c
                 AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT (c = ANY (col_names)) THEN
      col_names := col_names || c;
      col_vals  := col_vals  || quote_literal(nombre_emp);
    END IF;
  END LOOP;

  -- RUC
  IF ruc_emp IS NOT NULL THEN
    FOREACH c IN ARRAY ARRAY['ruc','ruc_empresa','documento'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = rel AND a.attname = c
                   AND a.attnum > 0 AND NOT a.attisdropped)
         AND NOT (c = ANY (col_names)) THEN
        col_names := col_names || c;
        col_vals  := col_vals  || quote_literal(ruc_emp);
      END IF;
    END LOOP;
  END IF;

  -- activo
  FOREACH c IN ARRAY ARRAY['activo','activa'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = rel AND a.attname = c
                 AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT (c = ANY (col_names)) THEN
      col_names := col_names || c;
      col_vals  := col_vals  || 'true'::text;
    END IF;
  END LOOP;

  -- data_schema: en instancia dedicada apunta al schema propio
  IF EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = rel AND a.attname = 'data_schema'
               AND a.attnum > 0 AND NOT a.attisdropped) THEN
    col_names := col_names || 'data_schema'::text;
    col_vals  := col_vals  || quote_literal(dst);
  END IF;

  -- ¿Queda alguna columna obligatoria que no sepamos llenar?
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

    RAISE EXCEPTION E'Faltan columnas obligatorias en %.empresas: %\n\n  Estructura completa de la tabla:\n    %\n\n  Agregá esos valores en el bloque de arriba y volvé a correr.',
      dst, faltantes, todas;
  END IF;

  EXECUTE format('INSERT INTO %I.empresas (%s) VALUES (%s)',
                 dst,
                 (SELECT string_agg(quote_ident(x), ', ') FROM unnest(col_names) AS u(x)),
                 array_to_string(col_vals, ', '));

  RAISE NOTICE '────────────────────────────────────────────────────────';
  RAISE NOTICE 'Empresa "%" creada.', nombre_emp;
  RAISE NOTICE 'EMPRESA_ID = %', nueva_id;
  RAISE NOTICE '────────────────────────────────────────────────────────';

  ---------------------------------------------------------------------------
  -- 4.3 Catálogo de módulos + allowlist de la empresa
  --
  -- `modulos` es CATÁLOGO, no datos de negocio: son las definiciones de módulo
  -- del ERP (ventas, inventario, caja…). Se copian conservando el `id`, porque
  -- `empresa_modulos.modulo_id` los referencia por FK. Sin esto el allowlist
  -- no tiene a qué apuntar.
  --
  -- Lectura puntual del bootstrap: no deja ninguna dependencia permanente.
  -- Si algo de esto falla, se avisa y se sigue — la empresa ya quedó creada y
  -- los módulos se pueden configurar después desde el ERP.
  ---------------------------------------------------------------------------
  BEGIN
    -- ── 4.3.a Catálogo `modulos` ─────────────────────────────────────────────
    IF EXISTS (SELECT 1 FROM pg_class cl JOIN pg_namespace ns ON ns.oid = cl.relnamespace
               WHERE ns.nspname = dst AND cl.relname = 'modulos' AND cl.relkind = 'r')
       AND EXISTS (SELECT 1 FROM pg_class cl JOIN pg_namespace ns ON ns.oid = cl.relnamespace
               WHERE ns.nspname = 'caribenaerp' AND cl.relname = 'modulos' AND cl.relkind = 'r') THEN

      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
             string_agg('o.' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
        INTO cols_ins, cols_sel
      FROM pg_attribute a
      WHERE a.attrelid = (dst || '.modulos')::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = ''
        AND EXISTS (SELECT 1 FROM pg_attribute b
                    WHERE b.attrelid = 'caribenaerp.modulos'::regclass
                      AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped);

      IF cols_ins IS NOT NULL THEN
        EXECUTE format(
          'INSERT INTO %I.modulos (%s) SELECT %s FROM caribenaerp.modulos o
             WHERE NOT EXISTS (SELECT 1 FROM %I.modulos d WHERE d.id = o.id)',
          dst, cols_ins, cols_sel, dst);
        GET DIAGNOSTICS n = ROW_COUNT;
        RAISE NOTICE '[4.3] % módulos de catálogo copiados.', n;
      END IF;
    END IF;

    -- ── 4.3.b Allowlist `empresa_modulos` ────────────────────────────────────
    IF EXISTS (SELECT 1 FROM pg_class cl JOIN pg_namespace ns ON ns.oid = cl.relnamespace
               WHERE ns.nspname = dst AND cl.relname = 'empresa_modulos' AND cl.relkind = 'r')
       AND EXISTS (SELECT 1 FROM pg_class cl JOIN pg_namespace ns ON ns.oid = cl.relnamespace
               WHERE ns.nspname = 'caribenaerp' AND cl.relname = 'empresa_modulos' AND cl.relkind = 'r') THEN

      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
             string_agg('o.' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
        INTO cols_ins, cols_sel
      FROM pg_attribute a
      WHERE a.attrelid = (dst || '.empresa_modulos')::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = ''
        AND a.attname NOT IN ('id', 'empresa_id')
        AND EXISTS (SELECT 1 FROM pg_attribute b
                    WHERE b.attrelid = 'caribenaerp.empresa_modulos'::regclass
                      AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped);

      IF cols_ins IS NOT NULL THEN
        -- Sólo las filas cuyo módulo exista localmente, por si algún módulo del
        -- catálogo no se pudo copiar.
        EXECUTE format(
          'INSERT INTO %I.empresa_modulos (empresa_id, %s) SELECT %L::uuid, %s FROM caribenaerp.empresa_modulos o%s',
          dst, cols_ins, nueva_id, cols_sel,
          CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a
                            WHERE a.attrelid = (dst || '.empresa_modulos')::regclass
                              AND a.attname = 'modulo_id'
                              AND a.attnum > 0 AND NOT a.attisdropped)
               THEN format(' WHERE EXISTS (SELECT 1 FROM %I.modulos m WHERE m.id = o.modulo_id)', dst)
               ELSE '' END);
        GET DIAGNOSTICS n = ROW_COUNT;
        RAISE NOTICE '[4.3] % filas de empresa_modulos replicadas.', n;
      END IF;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING '[4.3] No se pudieron replicar los módulos: % (%). La empresa SÍ quedó creada; configurá los módulos desde el ERP.',
      SQLERRM, SQLSTATE;
  END;

  RAISE NOTICE 'PASO 4 listo.';
END
$seed$;

COMMIT;


-- =============================================================================
-- VERIFICACIÓN 1 — los conteos de las dos columnas deben coincidir
-- =============================================================================
SELECT 'tablas' AS objeto,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='caribenaerp' AND c.relkind='r')  AS caribenaerp,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='cucinaerp' AND c.relkind='r') AS cucinaerp
UNION ALL SELECT 'columnas',
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='caribenaerp'),
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='cucinaerp')
UNION ALL SELECT 'constraints',
  (SELECT count(*) FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='caribenaerp'),
  (SELECT count(*) FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cucinaerp')
UNION ALL SELECT 'indices',
  (SELECT count(*) FROM pg_indexes WHERE schemaname='caribenaerp'),
  (SELECT count(*) FROM pg_indexes WHERE schemaname='cucinaerp')
UNION ALL SELECT 'funciones',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='caribenaerp' AND p.prokind IN ('f','p')),
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='cucinaerp' AND p.prokind IN ('f','p'))
UNION ALL SELECT 'triggers',
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='caribenaerp' AND NOT t.tgisinternal),
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='cucinaerp' AND NOT t.tgisinternal)
UNION ALL SELECT 'policies',
  (SELECT count(*) FROM pg_policies WHERE schemaname='caribenaerp'),
  (SELECT count(*) FROM pg_policies WHERE schemaname='cucinaerp')
UNION ALL SELECT 'vistas',
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='caribenaerp' AND c.relkind IN ('v','m')),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='cucinaerp' AND c.relkind IN ('v','m'));

-- =============================================================================
-- VERIFICACIÓN 2 — tablas sin RLS. Idealmente vacío: cada fila acá es una tabla
-- que `anon` podría leer entera una vez que expongas el schema.
-- =============================================================================
SELECT c.relname AS tabla_sin_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'cucinaerp' AND c.relkind = 'r' AND NOT c.relrowsecurity
ORDER BY 1;

-- =============================================================================
-- VERIFICACIÓN 3 — el empresa_id de Cucina del Cuore
-- =============================================================================
SELECT * FROM cucinaerp.empresas;

-- =============================================================================
-- VERIFICACIÓN 4 — AISLAMIENTO. Cada fila es una dependencia que TODAVÍA sale
-- de `cucinaerp` hacia un schema de negocio. Si sale VACÍO, está aislado.
-- `motivo` explica por qué quedó.
-- =============================================================================
SELECT 'foreign_key' AS tipo, c.relname AS objeto, co.conname AS detalle,
       nr.nspname || '.' || cr.relname AS apunta_a,
       CASE WHEN EXISTS (SELECT 1 FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                         WHERE n2.nspname = 'cucinaerp' AND c2.relname = cr.relname)
            THEN 'hay gemela local: revisar a mano'
            ELSE 'no existe cucinaerp.' || cr.relname || ' (tabla realmente compartida)'
       END AS motivo
FROM pg_constraint co
JOIN pg_class c      ON c.oid  = co.conrelid
JOIN pg_namespace n  ON n.oid  = c.relnamespace
JOIN pg_class cr     ON cr.oid = co.confrelid
JOIN pg_namespace nr ON nr.oid = cr.relnamespace
WHERE n.nspname = 'cucinaerp' AND co.contype = 'f'
  AND nr.nspname NOT IN ('cucinaerp','pg_catalog','extensions')

UNION ALL
SELECT 'funcion', p.proname, x[1] || '.' || x[2], x[1] || '.' || x[2],
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc p2 JOIN pg_namespace n2 ON n2.oid = p2.pronamespace
                    WHERE n2.nspname = 'cucinaerp' AND p2.proname = x[2])
         OR EXISTS (SELECT 1 FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                    WHERE n2.nspname = 'cucinaerp' AND c2.relname = x[2])
       THEN 'hay gemela local: revisar a mano'
       ELSE 'no existe cucinaerp.' || x[2]
  END
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL regexp_matches(pg_get_functiondef(p.oid),
             '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS g(x)
WHERE n.nspname = 'cucinaerp' AND p.prokind IN ('f','p')

UNION ALL
SELECT 'policy', pol.tablename, pol.policyname, x[1] || '.' || x[2],
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc p2 JOIN pg_namespace n2 ON n2.oid = p2.pronamespace
                    WHERE n2.nspname = 'cucinaerp' AND p2.proname = x[2])
       THEN 'hay gemela local: revisar a mano'
       ELSE 'no existe cucinaerp.' || x[2]
  END
FROM pg_policies pol
CROSS JOIN LATERAL regexp_matches(coalesce(pol.qual,'') || ' ' || coalesce(pol.with_check,''),
             '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS g(x)
WHERE pol.schemaname = 'cucinaerp'

UNION ALL
SELECT 'trigger', c.relname, t.tgname, x[1] || '.' || x[2],
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc p2 JOIN pg_namespace n2 ON n2.oid = p2.pronamespace
                    WHERE n2.nspname = 'cucinaerp' AND p2.proname = x[2])
       THEN 'hay gemela local: revisar a mano'
       ELSE 'no existe cucinaerp.' || x[2]
  END
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL regexp_matches(pg_get_triggerdef(t.oid),
             '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS g(x)
WHERE n.nspname = 'cucinaerp' AND NOT t.tgisinternal

UNION ALL
SELECT 'default', c.relname, a.attname, x[1] || '.' || x[2],
       'no existe cucinaerp.' || x[2]
FROM pg_attrdef ad
JOIN pg_class c     ON c.oid = ad.adrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
CROSS JOIN LATERAL regexp_matches(pg_get_expr(ad.adbin, ad.adrelid),
             '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS g(x)
WHERE n.nspname = 'cucinaerp'

UNION ALL
SELECT 'vista', c.relname, '', x[1] || '.' || x[2],
       'no existe cucinaerp.' || x[2]
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL regexp_matches(pg_get_viewdef(c.oid, true),
             '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS g(x)
WHERE n.nspname = 'cucinaerp' AND c.relkind IN ('v','m')

ORDER BY 1, 2, 3;
