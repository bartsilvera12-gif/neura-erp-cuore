-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 6: habilitar las vistas del tablero (Dashboard).
--
-- Síntoma que resuelve: "Sin vistas asignadas / Tu empresa aún no habilitó
-- pestañas para vos".
--
-- El dashboard se resuelve con tres tablas encadenadas:
--   dashboard_views           catálogo global de pestañas (comercial, ventas…)
--   empresa_dashboard_views   cuáles tiene habilitadas la empresa
--   usuario_dashboard_views   cuáles ve cada usuario (subconjunto de la empresa)
--
-- El clon trajo las tres tablas vacías, así que la cadena se corta en el primer
-- eslabón. Este script:
--   6.1  copia el catálogo desde `caribenaerp` conservando el id
--   6.2  habilita TODAS las vistas activas para la empresa de Cucina del Cuore
--   6.3  se las asigna a todos los usuarios, marcando una como predeterminada
--
-- Idempotente: se puede correr las veces que haga falta.
-- Para recortar después: Configuración → Vistas del dashboard, en el ERP.
-- =============================================================================

BEGIN;

DO $dv$
DECLARE
  dst       text := 'cucinaerp';
  src       text := 'caribenaerp';
  cols_ins  text;
  cols_sel  text;
  n         int;
  v_empresa uuid;
BEGIN
  FOREACH cols_ins IN ARRAY ARRAY['dashboard_views','empresa_dashboard_views','usuario_dashboard_views'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                   WHERE ns.nspname = dst AND c.relname = cols_ins AND c.relkind = 'r') THEN
      RAISE EXCEPTION 'No existe %.%. ¿El PASO 1 corrió bien?', dst, cols_ins;
    END IF;
  END LOOP;

  EXECUTE format('SELECT id FROM %I.empresas LIMIT 1', dst) INTO v_empresa;
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'No hay empresa en %.empresas. Corré primero 04_empresa_cucina.sql.', dst;
  END IF;

  ---------------------------------------------------------------------------
  -- 6.1 Catálogo de vistas (se conserva el id: las otras dos tablas lo referencian)
  ---------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = src AND c.relname = 'dashboard_views' AND c.relkind = 'r') THEN

    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
           string_agg('o.' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
      INTO cols_ins, cols_sel
    FROM pg_attribute a
    WHERE a.attrelid = (dst || '.dashboard_views')::regclass
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      AND EXISTS (SELECT 1 FROM pg_attribute b
                  WHERE b.attrelid = (src || '.dashboard_views')::regclass
                    AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped);

    IF cols_ins IS NOT NULL THEN
      EXECUTE format(
        'INSERT INTO %I.dashboard_views (%s) SELECT %s FROM %I.dashboard_views o
           WHERE NOT EXISTS (SELECT 1 FROM %I.dashboard_views d
                             WHERE d.id = o.id OR d.slug = o.slug)',
        dst, cols_ins, cols_sel, src, dst);
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE NOTICE '[6.1] % vistas de catálogo copiadas.', n;
    END IF;
  END IF;

  EXECUTE format('SELECT count(*) FROM %I.dashboard_views WHERE activo', dst) INTO n;
  IF n = 0 THEN
    RAISE EXCEPTION 'El catálogo %.dashboard_views quedó vacío: no hay vistas que habilitar.', dst;
  END IF;
  RAISE NOTICE '[6.1] catálogo con % vistas activas.', n;

  ---------------------------------------------------------------------------
  -- 6.2 Habilitarlas todas para la empresa
  ---------------------------------------------------------------------------
  EXECUTE format(
    'INSERT INTO %I.empresa_dashboard_views (empresa_id, dashboard_view_id, activo)
     SELECT %L::uuid, dv.id, true FROM %I.dashboard_views dv
      WHERE dv.activo
        AND NOT EXISTS (SELECT 1 FROM %I.empresa_dashboard_views e
                        WHERE e.empresa_id = %L::uuid AND e.dashboard_view_id = dv.id)',
    dst, v_empresa, dst, dst, v_empresa);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[6.2] % vistas habilitadas para la empresa.', n;

  -- Por si alguna quedó desactivada de una corrida anterior.
  EXECUTE format('UPDATE %I.empresa_dashboard_views SET activo = true
                   WHERE empresa_id = %L::uuid AND activo IS NOT TRUE', dst, v_empresa);

  ---------------------------------------------------------------------------
  -- 6.3 Asignarlas a todos los usuarios
  ---------------------------------------------------------------------------
  EXECUTE format(
    'INSERT INTO %I.usuario_dashboard_views (usuario_id, dashboard_view_id, es_default)
     SELECT u.id, dv.id, false
       FROM %I.usuarios u
       JOIN %I.empresa_dashboard_views edv ON edv.empresa_id = u.empresa_id AND edv.activo
       JOIN %I.dashboard_views dv ON dv.id = edv.dashboard_view_id AND dv.activo
      WHERE NOT EXISTS (SELECT 1 FROM %I.usuario_dashboard_views x
                        WHERE x.usuario_id = u.id AND x.dashboard_view_id = dv.id)',
    dst, dst, dst, dst, dst);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[6.3] % asignaciones usuario-vista creadas.', n;

  -- Una vista predeterminada por usuario (la de menor `orden`), sólo si no tiene.
  EXECUTE format(
    'UPDATE %I.usuario_dashboard_views udv SET es_default = true
      WHERE udv.id IN (
        SELECT DISTINCT ON (x.usuario_id) x.id
          FROM %I.usuario_dashboard_views x
          JOIN %I.dashboard_views d ON d.id = x.dashboard_view_id
         WHERE NOT EXISTS (SELECT 1 FROM %I.usuario_dashboard_views y
                           WHERE y.usuario_id = x.usuario_id AND y.es_default)
         ORDER BY x.usuario_id, d.orden, d.slug)',
    dst, dst, dst, dst);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[6.3] % vistas marcadas como predeterminadas.', n;

  RAISE NOTICE 'PASO 6 listo. Recargá el ERP con Ctrl+F5.';
END
$dv$;

COMMIT;

-- ── Qué quedó habilitado ─────────────────────────────────────────────────────
SELECT u.email,
       dv.slug,
       dv.nombre,
       dv.orden,
       udv.es_default
FROM cucinaerp.usuario_dashboard_views udv
JOIN cucinaerp.usuarios u        ON u.id  = udv.usuario_id
JOIN cucinaerp.dashboard_views dv ON dv.id = udv.dashboard_view_id
ORDER BY u.email, dv.orden;
