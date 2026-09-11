-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 1/4: clonar la ESTRUCTURA del schema `caribenaerp` en `cucinaerp`
--           SIN copiar datos de las tablas.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar TODO → Run.
--                (o: psql "$SUPABASE_DB_URL" -f 01_clone_schema_estructura.sql)
--
-- Qué clona, en este orden:
--   tipos ENUM/DOMAIN → secuencias → funciones/procedimientos → tablas
--   (columnas, tipos, defaults, identity, generated, NOT NULL)
--   → constraints PK/UNIQUE/CHECK/EXCLUDE → índices → foreign keys
--   → vistas y vistas materializadas (WITH NO DATA) → triggers
--   → RLS habilitado + todas las policies → comentarios
--
-- Qué NO clona (a propósito):
--   · Los datos de las tablas: el schema queda vacío y las secuencias en su
--     valor inicial.
--   · Objetos de otros schemas (`public`, `zentra_erp`, `auth`, `storage`).
--     Las FKs que apuntan a esos schemas se mantienen apuntando ahí.
--   · Los GRANTs → van en el PASO 3 (03_grants.sql).
--
-- Todo corre dentro de una transacción: si algo falla, no queda nada a medias.
-- Aborta si `cucinaerp` ya existe (para rehacerlo: DROP SCHEMA cucinaerp CASCADE).
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
  -- 1. Tipos ENUM y DOMAIN propios del schema
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
  -- 2. Secuencias independientes (las de columnas IDENTITY se crean solas).
  --    START WITH = valor inicial original: el contador arranca de cero, no
  --    hereda el último valor consumido por En lo de Mari.
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
  -- 3. Funciones y procedimientos (primera pasada; las que fallen se reintentan
  --    en el paso 9, ya con tablas y vistas creadas)
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
  -- 4. Tablas: columnas, tipos, defaults, identity, generated, NOT NULL
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
  -- 5. Constraints PK / UNIQUE / EXCLUDE / CHECK, conservando sus nombres
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
  -- 6. Índices que no respaldan un constraint
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
  -- 7. Foreign keys, ya con todas las tablas y sus PK/UNIQUE en su lugar.
  --    Las FK hacia public/zentra_erp/auth siguen apuntando a su schema original.
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
  -- 8. Vistas y vistas materializadas, con reintentos por dependencias entre sí
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
  -- 9. Funciones pendientes del paso 3
  ---------------------------------------------------------------------------
  IF pg_catalog.array_length(pendientes, 1) > 0 THEN
    FOREACH s IN ARRAY pendientes LOOP
      EXECUTE s;   -- si vuelve a fallar, el error se propaga y la TX aborta
    END LOOP;
  END IF;

  ---------------------------------------------------------------------------
  -- 10. Triggers
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
  -- 11. RLS: habilitarlo en las mismas tablas y recrear todas las policies
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
  -- 12. Comentarios de tablas y columnas
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

  RAISE NOTICE 'Clonado % -> % terminado.', src, dst;
END
$clone$;

COMMIT;

-- =============================================================================
-- Verificación: las dos columnas de conteo deben coincidir.
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
