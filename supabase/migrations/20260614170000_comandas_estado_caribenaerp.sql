-- =============================================================================
-- Comandas: estado de cocina + módulo "Comandas" — SOLO schema `cucinaerp`.
--
-- Agrega flujo de cocina a cucinaerp.comandas (enviada → en_preparacion → lista
-- → entregada, o cancelada). Da de alta el módulo `comandas` (catálogo local +
-- empresa_modulos activo) para que admin/cajero lo vean; el mozo queda excluido
-- por su usuario_modulos (solo mesas). NO toca facturación, Mesas ni otros schemas.
-- Idempotente.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.comandas', sch)) IS NULL THEN
    RAISE NOTICE '[comandas] schema % sin tabla comandas; se omite.', sch;
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS estado text', sch);
  EXECUTE format($u$UPDATE %I.comandas SET estado='enviada' WHERE estado IS NULL$u$, sch);
  EXECUTE format('ALTER TABLE %I.comandas ALTER COLUMN estado SET DEFAULT ''enviada''', sch);
  EXECUTE format('ALTER TABLE %I.comandas ALTER COLUMN estado SET NOT NULL', sch);
  EXECUTE format('ALTER TABLE %I.comandas DROP CONSTRAINT IF EXISTS comandas_estado_check', sch);
  EXECUTE format($c$ALTER TABLE %I.comandas ADD CONSTRAINT comandas_estado_check CHECK (estado IN ('enviada','en_preparacion','lista','entregada','cancelada'))$c$, sch);

  EXECUTE format('ALTER TABLE %I.comandas ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', sch);
  EXECUTE format('DROP TRIGGER IF EXISTS tr_comandas_updated ON %I.comandas', sch);
  EXECUTE format('CREATE TRIGGER tr_comandas_updated BEFORE UPDATE ON %I.comandas FOR EACH ROW EXECUTE FUNCTION %I.set_updated_at()', sch, sch);

  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_comandas_empresa_estado ON %I.comandas (empresa_id, estado, created_at DESC)', sch);

  RAISE NOTICE '[comandas] estado + updated_at aplicados en %.', sch;
END $$;

-- Alta del módulo "Comandas" (catálogo schema-local + activación por empresa).
INSERT INTO cucinaerp.modulos (nombre, slug, descripcion)
SELECT 'Comandas', 'comandas', 'Tablero de cocina: comandas enviadas por mesa'
WHERE NOT EXISTS (SELECT 1 FROM cucinaerp.modulos WHERE slug = 'comandas');

INSERT INTO cucinaerp.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
FROM cucinaerp.empresas e
CROSS JOIN cucinaerp.modulos m
WHERE m.slug = 'comandas'
  AND NOT EXISTS (
    SELECT 1 FROM cucinaerp.empresa_modulos em
    WHERE em.empresa_id = e.id AND em.modulo_id = m.id
  );
