-- =============================================================================
-- Entidades bancarias en Configuración — SOLO schema cucinaerp.
-- Agrega `tipo` (banco|pos|billetera|qr|otro) + updated_at/trigger a la tabla
-- existente cuentas_bancarias (la misma que usa conciliacion_pagos). No crea
-- tabla nueva ni toca otros schemas. Idempotente.
-- =============================================================================

DO $$
DECLARE sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.cuentas_bancarias', sch)) IS NULL THEN
    RAISE NOTICE '[cuentas] schema % sin cuentas_bancarias; se omite.', sch; RETURN;
  END IF;

  EXECUTE format('ALTER TABLE %I.cuentas_bancarias ADD COLUMN IF NOT EXISTS tipo text', sch);
  EXECUTE format('ALTER TABLE %I.cuentas_bancarias DROP CONSTRAINT IF EXISTS chk_cuenta_tipo', sch);
  EXECUTE format($c$ALTER TABLE %I.cuentas_bancarias ADD CONSTRAINT chk_cuenta_tipo CHECK (tipo IS NULL OR tipo IN ('banco','pos','billetera','qr','otro'))$c$, sch);

  EXECUTE format('ALTER TABLE %I.cuentas_bancarias ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', sch);
  EXECUTE format('DROP TRIGGER IF EXISTS tr_cuentas_updated ON %I.cuentas_bancarias', sch);
  EXECUTE format('CREATE TRIGGER tr_cuentas_updated BEFORE UPDATE ON %I.cuentas_bancarias FOR EACH ROW EXECUTE FUNCTION %I.set_updated_at()', sch, sch);

  RAISE NOTICE '[cuentas] tipo + updated_at aplicados en %.', sch;
END $$;
