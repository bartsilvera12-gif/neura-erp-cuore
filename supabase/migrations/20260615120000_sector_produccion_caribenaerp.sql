-- =============================================================================
-- Sector de producción + trazabilidad de comandas por sector — SOLO cucinaerp.
--
-- FASE 1 del flujo de impresión pizzería/plancha:
--  · productos.sector_produccion ('ninguno' | 'pizzeria' | 'plancha'),
--    configurable desde la UI; backfill inicial por categoría (y SKU de respaldo).
--  · comandas.sector + comandas.batch_id: una "Enviar comanda" puede generar
--    hasta 2 comandas (pizzería = copia completa, plancha = filtrada), agrupadas
--    por batch_id. Las comandas viejas quedan con sector NULL (legacy = todo).
--  · mesa_sesion_items.produccion_batch_id: a qué envío de producción pertenece
--    el ítem (para no reimprimir producción ya enviada).
--
-- Aditiva e idempotente. No borra columnas/datos. No toca otros schemas, ni
-- facturación/IVA, ni Caja. Las comandas existentes siguen funcionando.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.productos', sch)) IS NULL THEN
    RAISE NOTICE '[sector-produccion] schema % sin tabla productos; se omite.', sch;
    RETURN;
  END IF;

  -- 1) productos.sector_produccion ------------------------------------------------
  EXECUTE format('ALTER TABLE %I.productos ADD COLUMN IF NOT EXISTS sector_produccion text NOT NULL DEFAULT ''ninguno''', sch);
  EXECUTE format('ALTER TABLE %I.productos DROP CONSTRAINT IF EXISTS productos_sector_produccion_check', sch);
  EXECUTE format($c$ALTER TABLE %I.productos ADD CONSTRAINT productos_sector_produccion_check CHECK (sector_produccion IN ('ninguno','pizzeria','plancha'))$c$, sch);

  -- Backfill por NOMBRE de categoría (no hay slug en este tenant). Usa la categoría
  -- principal directa (productos.categoria_principal_id) y, de respaldo, las filas
  -- de producto_categorias. Solo toca los que siguen en 'ninguno'.
  IF to_regclass(format('%I.categorias_productos', sch)) IS NOT NULL THEN
    -- Pizzería
    EXECUTE format($u$
      UPDATE %I.productos p SET sector_produccion = 'pizzeria'
      WHERE p.sector_produccion = 'ninguno'
        AND (
          EXISTS (
            SELECT 1 FROM %I.categorias_productos c
            WHERE c.id = p.categoria_principal_id
              AND upper(coalesce(c.nombre,'')) IN ('PIZZAS','LOMPIZZAS')
          )
          OR EXISTS (
            SELECT 1 FROM %I.producto_categorias pc
            JOIN %I.categorias_productos c ON c.id = pc.categoria_id
            WHERE pc.producto_id = p.id
              AND upper(coalesce(c.nombre,'')) IN ('PIZZAS','LOMPIZZAS')
          )
        )
    $u$, sch, sch, sch, sch);
    -- Plancha
    EXECUTE format($u$
      UPDATE %I.productos p SET sector_produccion = 'plancha'
      WHERE p.sector_produccion = 'ninguno'
        AND (
          EXISTS (
            SELECT 1 FROM %I.categorias_productos c
            WHERE c.id = p.categoria_principal_id
              AND upper(coalesce(c.nombre,'')) IN ('HAMBURGUESAS','LOMITOS','LOMITOS ARABES','LOMITOS ÁRABES','PANCHOS','PAPAS FRITAS','ESPECIALES')
          )
          OR EXISTS (
            SELECT 1 FROM %I.producto_categorias pc
            JOIN %I.categorias_productos c ON c.id = pc.categoria_id
            WHERE pc.producto_id = p.id
              AND upper(coalesce(c.nombre,'')) IN ('HAMBURGUESAS','LOMITOS','LOMITOS ARABES','LOMITOS ÁRABES','PANCHOS','PAPAS FRITAS','ESPECIALES')
          )
        )
    $u$, sch, sch, sch, sch);
  END IF;

  -- Respaldo por prefijo de SKU para los que aún quedaron en 'ninguno'.
  EXECUTE format($u$
    UPDATE %I.productos SET sector_produccion = 'pizzeria'
    WHERE sector_produccion = 'ninguno' AND upper(coalesce(sku,'')) LIKE 'PIZ-%%'
  $u$, sch);
  EXECUTE format($u$
    UPDATE %I.productos SET sector_produccion = 'plancha'
    WHERE sector_produccion = 'ninguno'
      AND ( upper(coalesce(sku,'')) LIKE 'ESP-%%'
         OR upper(coalesce(sku,'')) LIKE 'HAM-%%'
         OR upper(coalesce(sku,'')) LIKE 'LOM-%%'
         OR upper(coalesce(sku,'')) LIKE 'PAN-%%'
         OR upper(coalesce(sku,'')) LIKE 'PAP-%%' )
  $u$, sch);

  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_productos_sector_produccion ON %I.productos (empresa_id, sector_produccion)', sch);

  -- 2) comandas.sector + batch_id -------------------------------------------------
  IF to_regclass(format('%I.comandas', sch)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS sector text', sch);
    EXECUTE format('ALTER TABLE %I.comandas DROP CONSTRAINT IF EXISTS comandas_sector_check', sch);
    EXECUTE format($c$ALTER TABLE %I.comandas ADD CONSTRAINT comandas_sector_check CHECK (sector IS NULL OR sector IN ('pizzeria','plancha'))$c$, sch);
    EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS batch_id uuid', sch);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_comandas_batch ON %I.comandas (empresa_id, batch_id)', sch);
  END IF;

  -- 3) mesa_sesion_items.produccion_batch_id -------------------------------------
  IF to_regclass(format('%I.mesa_sesion_items', sch)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.mesa_sesion_items ADD COLUMN IF NOT EXISTS produccion_batch_id uuid', sch);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mesa_items_batch ON %I.mesa_sesion_items (empresa_id, produccion_batch_id)', sch);
  END IF;

  RAISE NOTICE '[sector-produccion] sector_produccion + comandas.sector/batch + items.produccion_batch_id aplicados en %.', sch;
END $$;

-- Resumen de conteos por sector (informativo en la salida de la migración).
DO $$
DECLARE
  sch text := 'cucinaerp';
  r record;
BEGIN
  FOR r IN EXECUTE format('SELECT sector_produccion, count(*) AS n FROM %I.productos GROUP BY sector_produccion ORDER BY sector_produccion', sch)
  LOOP
    RAISE NOTICE '[sector-produccion] % productos en sector %', r.n, r.sector_produccion;
  END LOOP;
END $$;
