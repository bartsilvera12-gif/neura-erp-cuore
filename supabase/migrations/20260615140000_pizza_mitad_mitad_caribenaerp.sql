-- =============================================================================
-- Pizza mitad y mitad — SOLO cucinaerp. FASE 2.
--
-- Una pizza "mitad un sabor / mitad otro" es UNA línea de venta/mesa con metadata
-- (no se crean productos por combinación). Precio = max(precio_sabor_1, sabor_2).
-- Columnas aditivas en mesa_sesion_items y ventas_items. Idempotente, no borra nada.
-- No toca IVA, facturación ni otros schemas.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
  t text;
  tablas text[] := ARRAY['mesa_sesion_items', 'ventas_items'];
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    IF to_regclass(format('%I.%I', sch, t)) IS NULL THEN
      RAISE NOTICE '[mitad-mitad] %.% no existe; se omite.', sch, t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS es_mitad_mitad boolean NOT NULL DEFAULT false', sch, t);
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS mitad_1_producto_id uuid', sch, t);
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS mitad_2_producto_id uuid', sch, t);
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS mitad_1_nombre text', sch, t);
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS mitad_2_nombre text', sch, t);
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS item_display_name text', sch, t);
    RAISE NOTICE '[mitad-mitad] columnas mitad y mitad aplicadas en %.%', sch, t;
  END LOOP;
END $$;
