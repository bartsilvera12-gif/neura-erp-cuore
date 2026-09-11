-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- PASO 8: sembrar los estados del tablero de Pedidos (cocina).
--
-- Síntoma que resuelve: la pantalla "Pedidos" abre en blanco, sin columnas.
-- Las columnas del kanban son las filas de `proyecto_estados` de la empresa;
-- el clon trajo la tabla vacía, así que no hay ninguna columna que dibujar.
--
-- `proyecto_estados` tiene `empresa_id`: NO es catálogo global, es configuración
-- por empresa. Por eso no se copia de En lo de Mari — se siembra con los mismos
-- 6 estados de cocina, pero apuntados a la empresa de Cucina del Cuore.
--
-- Equivale a la migración supabase/cucinaerp/migrations/20260519000000_
-- pedidos_estados_seed.sql, pero resolviendo la empresa dinámicamente en vez de
-- hardcodearla.
--
-- Idempotente.
-- =============================================================================

BEGIN;

DO $ped$
DECLARE
  dst       text := 'cucinaerp';
  v_empresa uuid;
  v_modulo  uuid;
  n         int;
BEGIN
  EXECUTE format('SELECT id FROM %I.empresas LIMIT 1', dst) INTO v_empresa;
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'No hay empresa en %.empresas. Corré primero 04_empresa_cucina.sql.', dst;
  END IF;
  RAISE NOTICE '[8] empresa = %', v_empresa;

  -- 1) El módulo `proyectos` es el que la UI muestra como "Pedidos".
  SELECT id INTO v_modulo FROM cucinaerp.modulos WHERE slug = 'proyectos';
  IF v_modulo IS NULL THEN
    RAISE EXCEPTION 'No existe el slug `proyectos` en %.modulos.', dst;
  END IF;

  INSERT INTO cucinaerp.empresa_modulos (empresa_id, modulo_id, activo)
  SELECT v_empresa, v_modulo, true
   WHERE NOT EXISTS (SELECT 1 FROM cucinaerp.empresa_modulos
                     WHERE empresa_id = v_empresa AND modulo_id = v_modulo);
  UPDATE cucinaerp.empresa_modulos SET activo = true
   WHERE empresa_id = v_empresa AND modulo_id = v_modulo AND activo IS NOT TRUE;

  -- 2) Tipo "Pedido".
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = dst AND c.relname = 'proyecto_tipos') THEN
    INSERT INTO cucinaerp.proyecto_tipos (empresa_id, nombre, codigo, activo)
    VALUES (v_empresa, 'Pedido', 'pedido', true)
    ON CONFLICT (empresa_id, codigo) DO UPDATE
      SET nombre = EXCLUDED.nombre, activo = true;
  END IF;

  -- 3) Los 6 estados de cocina, en orden de tablero.
  INSERT INTO cucinaerp.proyecto_estados
    (empresa_id, codigo, nombre, color, sort_order, es_estado_inicial, es_estado_final, tipo_sla, activo)
  VALUES
    (v_empresa, 'nuevo',          'Nuevo',          '#2563eb', 10, true,  false, 'interno', true),
    (v_empresa, 'en_preparacion', 'En preparación', '#f59e0b', 20, false, false, 'interno', true),
    (v_empresa, 'listo',          'Listo',          '#10b981', 30, false, false, 'interno', true),
    (v_empresa, 'en_camino',      'En camino',      '#8b5cf6', 40, false, false, 'interno', true),
    (v_empresa, 'entregado',      'Entregado',      '#16a34a', 50, false, true,  'final',   true),
    (v_empresa, 'cancelado',      'Cancelado',      '#ef4444', 60, false, true,  'final',   true)
  ON CONFLICT (empresa_id, codigo) DO UPDATE SET
    nombre            = EXCLUDED.nombre,
    color             = EXCLUDED.color,
    sort_order        = EXCLUDED.sort_order,
    es_estado_inicial = EXCLUDED.es_estado_inicial,
    es_estado_final   = EXCLUDED.es_estado_final,
    tipo_sla          = EXCLUDED.tipo_sla,
    activo            = true;

  SELECT count(*) INTO n FROM cucinaerp.proyecto_estados
   WHERE empresa_id = v_empresa AND activo;
  RAISE NOTICE '[8] % estados activos. Recargá Pedidos con Ctrl+F5.', n;
END
$ped$;

COMMIT;

-- ── Las columnas que va a dibujar el tablero ─────────────────────────────────
SELECT codigo, nombre, color, sort_order, es_estado_inicial, es_estado_final
FROM cucinaerp.proyecto_estados
WHERE empresa_id = (SELECT id FROM cucinaerp.empresas LIMIT 1)
  AND activo
ORDER BY sort_order;
