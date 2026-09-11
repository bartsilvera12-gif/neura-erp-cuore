-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 7: dejar habilitados sólo los módulos que usa Cucina del Cuore.
--
-- Saca del menú el stack omnicanal (Conversaciones, Historial, Finalizadas,
-- Monitoreo), que venía heredado del allowlist de En lo de Mari.
--
-- Cómo funciona el menú (src/lib/modulos/resolve-effective-modules.ts):
--   · admin / super_admin  → ve todos los módulos con activo=true en empresa_modulos
--   · otros roles          → intersección de empresa_modulos con usuario_modulos
--   · empresa_modulos SIN NINGUNA FILA → se interpreta como "ERP completo"
--
-- Por eso el script no borra filas: escribe una fila por cada módulo del
-- catálogo, con activo=true o false. Así el allowlist es explícito y nunca se
-- cae en el "sin filas = todo habilitado".
--
-- Ocultar un módulo NO borra sus tablas ni sus datos: sólo lo saca del menú.
-- Para volver a habilitarlo, agregá su slug a la lista de abajo y volvé a correr.
--
-- Idempotente.
-- =============================================================================

BEGIN;

DO $mod$
DECLARE
  dst      text := 'cucinaerp';

  -- ── Módulos habilitados. Editá esta lista y volvé a correr. ───────────────
  --    (el slug va entre comillas; el comentario es la etiqueta del menú)
  activos  text[] := ARRAY[
    'dashboard',      -- Dashboard
    'mesas',          -- Mesas
    'comandas',       -- Comandas + Pedidos para llevar (comparten slug)
    'ventas',         -- Caja
    'reportes',       -- Reportes
    'proyectos',      -- Pedidos
    'recetas',        -- Recetas
    'inventario',     -- Inventario (Productos, Movimientos, Categorías)
    'clientes',       -- Clientes
    'compras',        -- Compras (Órdenes, Proveedores)
    'gastos'          -- Gastos
  ];
  -- ──────────────────────────────────────────────────────────────────────────

  v_empresa uuid;
  faltan    text;
  n         int;
BEGIN
  EXECUTE format('SELECT id FROM %I.empresas LIMIT 1', dst) INTO v_empresa;
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'No hay empresa en %.empresas. Corré primero 04_empresa_cucina.sql.', dst;
  END IF;

  -- Aviso si algún slug de la lista no existe en el catálogo (typo, o módulo
  -- que esta instancia no tiene). No es fatal: simplemente no se habilita nada.
  EXECUTE format(
    'SELECT string_agg(s, '', '') FROM unnest($1::text[]) AS t(s)
      WHERE NOT EXISTS (SELECT 1 FROM %I.modulos m WHERE m.slug = t.s)', dst)
    INTO faltan USING activos;
  IF faltan IS NOT NULL THEN
    RAISE WARNING 'Estos slugs no existen en %.modulos y se ignoran: %', dst, faltan;
  END IF;

  -- Una fila por cada módulo del catálogo, con su activo correspondiente.
  EXECUTE format(
    'INSERT INTO %I.empresa_modulos (empresa_id, modulo_id, activo)
     SELECT %L::uuid, m.id, (m.slug = ANY($1::text[]))
       FROM %I.modulos m
      WHERE NOT EXISTS (SELECT 1 FROM %I.empresa_modulos em
                        WHERE em.empresa_id = %L::uuid AND em.modulo_id = m.id)',
    dst, v_empresa, dst, dst, v_empresa)
    USING activos;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[7] % filas nuevas en empresa_modulos.', n;

  -- Y alinear las que ya existían.
  EXECUTE format(
    'UPDATE %I.empresa_modulos em SET activo = (m.slug = ANY($1::text[]))
       FROM %I.modulos m
      WHERE m.id = em.modulo_id
        AND em.empresa_id = %L::uuid
        AND em.activo IS DISTINCT FROM (m.slug = ANY($1::text[]))',
    dst, dst, v_empresa)
    USING activos;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '[7] % filas actualizadas.', n;

  EXECUTE format(
    'SELECT count(*) FROM %I.empresa_modulos WHERE empresa_id = %L::uuid AND activo',
    dst, v_empresa) INTO n;
  RAISE NOTICE '[7] % módulos habilitados. Recargá el ERP con Ctrl+F5.', n;
END
$mod$;

COMMIT;

-- ── Cómo quedó el menú ───────────────────────────────────────────────────────
SELECT m.slug,
       m.nombre,
       CASE WHEN em.activo THEN 'HABILITADO' ELSE 'oculto' END AS estado
FROM cucinaerp.modulos m
LEFT JOIN cucinaerp.empresa_modulos em
       ON em.modulo_id = m.id
      AND em.empresa_id = (SELECT id FROM cucinaerp.empresas LIMIT 1)
ORDER BY em.activo DESC NULLS LAST, m.slug;
