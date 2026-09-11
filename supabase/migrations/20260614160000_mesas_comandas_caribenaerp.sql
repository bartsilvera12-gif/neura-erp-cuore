-- =============================================================================
-- Mesas: separar COMANDA (cocina) de CAJA (cobro) — SOLO schema `cucinaerp`.
--
-- - cucinaerp.comandas: cada envío a cocina de una sesión de mesa (numerada).
-- - mesa_sesion_items: estado pasa de (activo|cancelado) a
--   (pendiente|enviado|cancelado) + comanda_id + enviado_at.
--     · pendiente: agregado por el mozo, aún NO enviado a cocina.
--     · enviado: incluido en una comanda (cocina). Sigue contando en la cuenta.
--     · cancelado: anulado (no cuenta).
--
-- "Enviar comanda" toma los pendientes y los marca enviados (mesa sigue abierta,
-- NO crea venta, NO toca caja/stock). "Pedir cuenta" (enviar a caja) sigue siendo
-- el flujo de cobro (por_cobrar → factura). Idempotente y schema-local.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.mesa_sesiones', sch)) IS NULL THEN
    RAISE NOTICE '[comandas] schema % sin mesa_sesiones; se omite.', sch;
    RETURN;
  END IF;

  -- ── 1) Tabla comandas ─────────────────────────────────────────────────────
  IF to_regclass(format('%I.comandas', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.comandas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        sesion_id uuid NOT NULL REFERENCES %I.mesa_sesiones(id) ON DELETE CASCADE,
        numero integer NOT NULL,
        creado_por uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_comandas_sesion_numero UNIQUE (sesion_id, numero)
      )
    $ddl$, sch, sch, sch, sch);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_comandas_sesion ON %I.comandas (empresa_id, sesion_id, numero)', sch);

  EXECUTE format('ALTER TABLE %I.comandas ENABLE ROW LEVEL SECURITY', sch);
  EXECUTE format('DROP POLICY IF EXISTS comandas_select ON %I.comandas', sch);
  EXECUTE format('CREATE POLICY comandas_select ON %I.comandas FOR SELECT USING (%I.puede_acceder_empresa(empresa_id))', sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS comandas_insert ON %I.comandas', sch);
  EXECUTE format('CREATE POLICY comandas_insert ON %I.comandas FOR INSERT WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS comandas_update ON %I.comandas', sch);
  EXECUTE format('CREATE POLICY comandas_update ON %I.comandas FOR UPDATE USING (%I.puede_acceder_empresa(empresa_id)) WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS comandas_delete ON %I.comandas', sch);
  EXECUTE format('CREATE POLICY comandas_delete ON %I.comandas FOR DELETE USING (%I.puede_acceder_empresa(empresa_id))', sch, sch);

  -- ── 2) mesa_sesion_items: nuevos estados + comanda_id + enviado_at ─────────
  EXECUTE format('ALTER TABLE %I.mesa_sesion_items ADD COLUMN IF NOT EXISTS comanda_id uuid', sch);
  EXECUTE format('ALTER TABLE %I.mesa_sesion_items ADD COLUMN IF NOT EXISTS enviado_at timestamptz', sch);

  -- FK comanda_id → comandas (guard idempotente)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=sch AND c.relname='mesa_sesion_items' AND con.conname='mesa_sesion_items_comanda_id_fkey'
  ) THEN
    EXECUTE format('ALTER TABLE %I.mesa_sesion_items ADD CONSTRAINT mesa_sesion_items_comanda_id_fkey FOREIGN KEY (comanda_id) REFERENCES %I.comandas(id) ON DELETE SET NULL', sch, sch);
  END IF;

  -- Migrar estado: drop check viejo → normalizar 'activo'→'pendiente' → check nuevo → default.
  EXECUTE format('ALTER TABLE %I.mesa_sesion_items DROP CONSTRAINT IF EXISTS mesa_sesion_items_estado_check', sch);
  EXECUTE format('ALTER TABLE %I.mesa_sesion_items ALTER COLUMN estado DROP DEFAULT', sch);
  EXECUTE format($u$UPDATE %I.mesa_sesion_items SET estado='pendiente' WHERE estado='activo'$u$, sch);
  EXECUTE format($c$ALTER TABLE %I.mesa_sesion_items ADD CONSTRAINT mesa_sesion_items_estado_check CHECK (estado IN ('pendiente','enviado','cancelado'))$c$, sch);
  EXECUTE format($d$ALTER TABLE %I.mesa_sesion_items ALTER COLUMN estado SET DEFAULT 'pendiente'$d$, sch);

  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mesa_items_comanda ON %I.mesa_sesion_items (empresa_id, comanda_id)', sch);

  RAISE NOTICE '[comandas] comandas + estados de item aplicados en %.', sch;
END $$;
