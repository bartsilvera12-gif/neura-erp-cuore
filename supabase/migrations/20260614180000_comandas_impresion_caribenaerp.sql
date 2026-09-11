-- =============================================================================
-- Comandas como TICKET DE IMPRESIÓN (no kanban de cocina) — SOLO cucinaerp.
--
-- La comanda es un ticket interno que caja/admin imprime y le pasa a cocina.
-- No hay flujo en_preparacion/lista/entregada. Estados: generada | impresa |
-- cancelada. Se agrega tracking de impresión (printed_at/by, print_count) y
-- cancelación. Migra estados viejos sin romper comandas existentes.
-- Idempotente. No toca facturación, Mesas, Caja ni otros schemas.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.comandas', sch)) IS NULL THEN
    RAISE NOTICE '[comandas-print] schema % sin tabla comandas; se omite.', sch;
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS printed_at timestamptz', sch);
  EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS printed_by uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL', sch, sch);
  EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS print_count integer NOT NULL DEFAULT 0', sch);
  EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS cancelled_at timestamptz', sch);
  EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL', sch, sch);

  -- Migrar estados de cocina viejos → generada (impresa si ya tuvo impresiones).
  EXECUTE format('ALTER TABLE %I.comandas DROP CONSTRAINT IF EXISTS comandas_estado_check', sch);
  EXECUTE format('ALTER TABLE %I.comandas ALTER COLUMN estado DROP DEFAULT', sch);
  EXECUTE format($u$
    UPDATE %I.comandas
       SET estado = CASE
         WHEN estado = 'cancelada' THEN 'cancelada'
         WHEN print_count > 0 THEN 'impresa'
         ELSE 'generada'
       END
  $u$, sch);
  EXECUTE format($c$ALTER TABLE %I.comandas ADD CONSTRAINT comandas_estado_check CHECK (estado IN ('generada','impresa','cancelada'))$c$, sch);
  EXECUTE format('ALTER TABLE %I.comandas ALTER COLUMN estado SET DEFAULT ''generada''', sch);

  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_comandas_empresa_estado2 ON %I.comandas (empresa_id, estado, created_at DESC)', sch);

  RAISE NOTICE '[comandas-print] campos de impresión + estados generada/impresa/cancelada aplicados en %.', sch;
END $$;
