-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 2/4: AISLAR `cucinaerp` de `public` y `zentra_erp`.
--
-- Correr DESPUÉS de que exista el schema (01 o 00_bootstrap_completo.sql).
-- Es idempotente: si ya está aislado, no hace nada y el reporte final sale vacío.
--
-- El objetivo: que `cucinaerp` no dependa de ningún objeto de negocio fuera de
-- sí mismo. Lo único que queda compartido, por diseño de Supabase, es la
-- infraestructura del proyecto: `auth`, `storage`, `extensions`, `pg_catalog`.
-- Para desacoplar TAMBIÉN eso hace falta un proyecto Supabase aparte.
--
-- Qué hace, en orden:
--   4.A  Clona a `cucinaerp` las funciones de public/zentra_erp que el schema
--        todavía llama y que no tienen gemela local (p. ej. puede_acceder_empresa,
--        set_updated_at), reescribiendo su cuerpo para que lean tablas locales.
--   4.B  Reescribe los cuerpos de las funciones locales.
--   4.C  Reescribe defaults de columnas.
--   4.D  Repunta foreign keys a la tabla gemela local.
--   4.E  Reescribe check constraints.
--   4.F  Reescribe índices con expresión.
--   4.G  Reescribe policies de RLS.
--   4.H  Reescribe triggers.
--   4.I  Reescribe vistas y matviews.
--   4.J  REPORTE: lista lo que NO se pudo aislar, con el motivo.
--
-- Regla de oro: sólo reescribe `otroschema.objeto` → `cucinaerp.objeto` cuando
-- `cucinaerp.objeto` EXISTE. Si no existe, no inventa nada: lo deja como está
-- y lo reporta al final. Nunca vas a terminar con una referencia rota.
--
-- Todo en una transacción: si algo falla, no queda nada a medias.
-- =============================================================================

BEGIN;

SET LOCAL search_path = pg_catalog;
SET LOCAL check_function_bodies = false;

-- ── Helper: reescribe `public.x` / `zentra_erp.x` → `cucinaerp.x`, pero SÓLO
--    si `cucinaerp.x` existe (tabla, vista, función o tipo). ────────────────
CREATE OR REPLACE FUNCTION pg_temp.localizar(t text, dst text)
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

-- ── Helper: todo el texto de definiciones del schema, para buscar qué
--    referencias externas quedan. ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.inventario(dst text)
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


DO $aislar$
DECLARE
  dst       text := 'cucinaerp';
  r         record;
  m         text[];
  inv       text;
  nuevo     text;
  stmt      text;
  s         text;
  pend      text[];
  pasada    int;
  clonadas  int;
  n_cambios int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = dst) THEN
    RAISE EXCEPTION 'El schema % no existe. Corré primero 01_clone_schema_estructura.sql.', dst;
  END IF;

  ---------------------------------------------------------------------------
  -- 4.A Traer las funciones externas que el schema todavía llama.
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
      -- Sólo si es realmente una función allá y NO existe gemela acá.
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = r.sch AND p.proname = r.fname AND p.prokind IN ('f','p'));
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = dst AND p.proname = r.fname);

      -- Clonar todas las sobrecargas.
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
          -- ...y localizar todo lo que su cuerpo referencia y tenga gemela acá.
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
          RAISE NOTICE '[4.A] función %.%(%) clonada a %.', r.sch, r.fname, p2.args, dst;
        END LOOP;
      END;
    END LOOP;

    EXIT WHEN clonadas = 0;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.B Cuerpos de las funciones locales
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT p.oid, p.proname, pg_catalog.pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = dst AND p.prokind IN ('f','p')
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE nuevo;
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[4.B] función %.% reescrita.', dst, r.proname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.C Defaults de columnas
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, a.attname,
           pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS def
    FROM pg_attrdef ad
    JOIN pg_class c     ON c.oid = ad.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    WHERE n.nspname = dst AND c.relkind IN ('r','p')
      AND a.attgenerated = ''
  LOOP
    nuevo := pg_temp.localizar(r.def, dst);
    IF nuevo IS DISTINCT FROM r.def THEN
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s',
                dst, r.relname, r.attname, nuevo);
      n_cambios := n_cambios + 1;
      RAISE NOTICE '[4.C] default de %.%.% reescrito.', dst, r.relname, r.attname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.D Foreign keys: repuntar a la tabla gemela local
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.relname, co.conname, pg_catalog.pg_get_constraintdef(co.oid) AS def
    FROM pg_constraint co
    JOIN pg_class c      ON c.oid = co.conrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
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
      RAISE NOTICE '[4.D] FK %.% repuntada a local.', r.relname, r.conname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.E Check constraints
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
      RAISE NOTICE '[4.E] CHECK %.% reescrito.', r.relname, r.conname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.F Índices con expresión (los que respaldan constraints ya se trataron)
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
      RAISE NOTICE '[4.F] índice % reescrito.', r.idxname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.G Policies de RLS
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT p.tablename, p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = dst
    ORDER BY p.tablename, p.policyname
  LOOP
    IF pg_temp.localizar(coalesce(r.qual,''), dst)
         IS NOT DISTINCT FROM coalesce(r.qual,'')
       AND pg_temp.localizar(coalesce(r.with_check,''), dst)
         IS NOT DISTINCT FROM coalesce(r.with_check,'') THEN
      CONTINUE;
    END IF;

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
    RAISE NOTICE '[4.G] policy % en % reescrita.', r.policyname, r.tablename;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.H Triggers
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
      RAISE NOTICE '[4.H] trigger % en % reescrito.', r.tgname, r.relname;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4.I Vistas y matviews (drop de todas las afectadas y recreación con
  --     reintentos, porque pueden depender entre sí)
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

  RAISE NOTICE '────────────────────────────────────────────────────────';
  RAISE NOTICE 'PASO 4 listo: % objetos reescritos.', n_cambios;
  RAISE NOTICE 'Revisá el REPORTE de abajo: debe salir vacío.';
  RAISE NOTICE '────────────────────────────────────────────────────────';
END
$aislar$;

COMMIT;


-- =============================================================================
-- 4.J REPORTE — lo que NO se pudo aislar.
--
-- Cada fila es una dependencia que sigue saliendo de `cucinaerp` hacia un
-- schema de negocio. Si sale VACÍO, el aislamiento está completo.
-- `motivo` te dice por qué quedó: casi siempre es que no existe la gemela local.
-- =============================================================================

-- 1) Foreign keys que siguen apuntando afuera
SELECT
  'foreign_key'                                   AS tipo,
  c.relname                                       AS objeto,
  co.conname                                      AS detalle,
  nr.nspname || '.' || cr.relname                 AS apunta_a,
  CASE WHEN EXISTS (SELECT 1 FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                    WHERE n2.nspname = 'cucinaerp' AND c2.relname = cr.relname)
       THEN 'hay gemela local: revisar a mano'
       ELSE 'no existe cucinaerp.' || cr.relname || ' (tabla realmente compartida)'
  END                                             AS motivo
FROM pg_constraint co
JOIN pg_class c      ON c.oid  = co.conrelid
JOIN pg_namespace n  ON n.oid  = c.relnamespace
JOIN pg_class cr     ON cr.oid = co.confrelid
JOIN pg_namespace nr ON nr.oid = cr.relnamespace
WHERE n.nspname = 'cucinaerp'
  AND co.contype = 'f'
  AND nr.nspname NOT IN ('cucinaerp','pg_catalog','extensions')

UNION ALL

-- 2) Funciones locales cuyo cuerpo todavía nombra public./zentra_erp.
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

-- 3) Policies de RLS que todavía nombran public./zentra_erp.
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

-- 4) Triggers que todavía ejecutan una función de otro schema
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

-- 5) Defaults de columnas que todavía nombran public./zentra_erp.
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

-- 6) Vistas que todavía leen de public./zentra_erp.
SELECT 'vista', c.relname, '', x[1] || '.' || x[2],
  'no existe cucinaerp.' || x[2]
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL regexp_matches(pg_get_viewdef(c.oid, true),
             '(public|zentra_erp)\.([A-Za-z_][A-Za-z0-9_]*)', 'g') AS g(x)
WHERE n.nspname = 'cucinaerp' AND c.relkind IN ('v','m')

ORDER BY 1, 2, 3;
