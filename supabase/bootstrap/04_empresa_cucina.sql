-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 4/4: crear la empresa propia de esta instancia (id nuevo, independiente
--           del de En lo de Mari) y habilitarle los mismos módulos.
--
-- Correr DESPUÉS de 01_clone_schema_estructura.sql, 02_aislar.sql y 03_grants.sql.
--
-- Hace tres cosas, en este orden:
--
--   4.1  Re-apunta los "locks monocliente" heredados. El schema `caribenaerp`
--        tiene triggers sobre `empresas` que hardcodean el UUID de SU empresa
--        para impedir que se cree ninguna otra. Al clonarse llegaron intactos a
--        `cucinaerp`, así que bloquean la creación de la empresa de Cucina del Cuore.
--        Se reescriben para que apunten al UUID nuevo. Sólo se tocan funciones
--        que son trigger de `cucinaerp.empresas`, y sólo sus literales UUID.
--
--   4.2  Inserta la empresa. Defensivo: mira qué columnas existen realmente y
--        acepta varias convenciones (`nombre`, `nombre_empresa`, …). Si queda
--        alguna columna NOT NULL sin default que no sabe llenar, aborta y te
--        vuelca la estructura completa de la tabla.
--
--   4.3  Copia el catálogo `modulos` (definiciones de módulo del ERP, no datos
--        de negocio — conservando el id, porque `empresa_modulos.modulo_id` los
--        referencia por FK) y replica el allowlist de la empresa. Si esto falla,
--        avisa y sigue: la empresa ya quedó creada.
--
-- Al terminar imprime el UUID de la empresa nueva: ese es el `empresa_id` de
-- Cucina del Cuore.
-- =============================================================================

BEGIN;

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

-- ── El empresa_id de Cucina del Cuore ────────────────────────────────────────────────
SELECT * FROM cucinaerp.empresas;

-- ── Locks monocliente activos sobre empresas, ya re-apuntados ────────────────
-- El UUID que aparezca acá debe ser el de la fila de arriba.
SELECT t.tgname AS trigger, p.proname AS funcion,
       (SELECT string_agg(DISTINCT x[1], ', ')
        FROM regexp_matches(pg_get_functiondef(p.oid),
               '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
               'g') AS g(x)) AS uuids_hardcodeados
FROM pg_trigger t
JOIN pg_class c      ON c.oid = t.tgrelid
JOIN pg_namespace n  ON n.oid = c.relnamespace
JOIN pg_proc p       ON p.oid = t.tgfoid
WHERE n.nspname = 'cucinaerp' AND c.relname = 'empresas' AND NOT t.tgisinternal;


-- =============================================================================
-- Si el script aborta pidiendo columnas que no sabe llenar, esta query te
-- muestra la estructura de la tabla para completar el bloque de arriba:
--
--   SELECT a.attnum, a.attname,
--          format_type(a.atttypid, a.atttypmod) AS tipo,
--          a.attnotnull                          AS obligatoria,
--          pg_get_expr(ad.adbin, ad.adrelid)     AS valor_por_defecto
--   FROM pg_attribute a
--   LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
--   WHERE a.attrelid = 'cucinaerp.empresas'::regclass
--     AND a.attnum > 0 AND NOT a.attisdropped
--   ORDER BY a.attnum;
-- =============================================================================
