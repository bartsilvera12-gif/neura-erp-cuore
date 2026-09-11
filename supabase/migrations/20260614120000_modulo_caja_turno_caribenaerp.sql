-- =============================================================================
-- Módulo CAJA por turno — SOLO schema `cucinaerp` (instancia Cucina del Cuore).
--
-- Agrupa las ventas por apertura/cierre de caja (turno) en vez de por fecha
-- calendario: el local trabaja 18:00 → 02:00/03:00 del día siguiente, así que
-- un turno cruza la medianoche y NO puede partirse por día.
--
-- Crea:
--   · cucinaerp.cajas             (un turno de caja: apertura/cierre/arqueo)
--   · cucinaerp.caja_movimientos  (ingresos/egresos/retiros/ajustes manuales)
--   · cucinaerp.ventas.caja_id    (asocia cada venta nueva a su caja)
--
-- Reglas:
--   · Aditiva e idempotente (CREATE ... IF NOT EXISTS / DROP+CREATE POLICY).
--   · Instancia MONOCLIENTE: el catálogo (empresas, usuarios) y las funciones
--     RLS/trigger viven DENTRO del schema cucinaerp. Todas las referencias son
--     schema-local (cucinaerp.*). NO toca public, zentra_erp ni otros clientes.
--   · NO reasigna ventas históricas: caja_id queda NULL en las previas.
--   · empresa_id → cucinaerp.empresas; usuarios → cucinaerp.usuarios
--     (mismo patrón que cucinaerp.ventas / cucinaerp.proyectos).
--   · RLS: cucinaerp.puede_acceder_empresa(empresa_id). Trigger: cucinaerp.set_updated_at.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  -- Guardia: solo corre si existe el schema y su tabla ventas.
  IF to_regclass(format('%I.ventas', sch)) IS NULL THEN
    RAISE NOTICE '[caja] schema % sin tabla ventas; se omite.', sch;
    RETURN;
  END IF;

  -- ── 1) Tabla cajas ────────────────────────────────────────────────────────
  IF to_regclass(format('%I.cajas', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.cajas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        numero_caja bigint NOT NULL,
        estado text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
        abierta_por uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        cerrada_por uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        fecha_apertura timestamptz NOT NULL DEFAULT now(),
        fecha_cierre timestamptz,
        monto_apertura numeric(14,2) NOT NULL DEFAULT 0,
        monto_cierre_contado numeric(14,2),
        monto_esperado_efectivo numeric(14,2),
        diferencia numeric(14,2),
        observacion_apertura text,
        observacion_cierre text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_cajas_empresa_numero UNIQUE (empresa_id, numero_caja)
      )
    $ddl$, sch, sch, sch, sch);
  END IF;

  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_cajas_empresa_estado ON %I.cajas (empresa_id, estado)', sch);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_cajas_empresa_apertura ON %I.cajas (empresa_id, fecha_apertura DESC)', sch);
  -- Una sola caja ABIERTA por empresa a la vez.
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_cajas_una_abierta ON %I.cajas (empresa_id) WHERE estado = ''abierta''', sch);

  EXECUTE format('ALTER TABLE %I.cajas ENABLE ROW LEVEL SECURITY', sch);
  EXECUTE format('DROP POLICY IF EXISTS cajas_select ON %I.cajas', sch);
  EXECUTE format('CREATE POLICY cajas_select ON %I.cajas FOR SELECT USING (%I.puede_acceder_empresa(empresa_id))', sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS cajas_insert ON %I.cajas', sch);
  EXECUTE format('CREATE POLICY cajas_insert ON %I.cajas FOR INSERT WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS cajas_update ON %I.cajas', sch);
  EXECUTE format('CREATE POLICY cajas_update ON %I.cajas FOR UPDATE USING (%I.puede_acceder_empresa(empresa_id)) WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS cajas_delete ON %I.cajas', sch);
  EXECUTE format('CREATE POLICY cajas_delete ON %I.cajas FOR DELETE USING (%I.puede_acceder_empresa(empresa_id))', sch, sch);

  EXECUTE format('DROP TRIGGER IF EXISTS tr_cajas_updated ON %I.cajas', sch);
  EXECUTE format('CREATE TRIGGER tr_cajas_updated BEFORE UPDATE ON %I.cajas FOR EACH ROW EXECUTE FUNCTION %I.set_updated_at()', sch, sch);

  -- ── 2) Tabla caja_movimientos ─────────────────────────────────────────────
  IF to_regclass(format('%I.caja_movimientos', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.caja_movimientos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        caja_id uuid NOT NULL REFERENCES %I.cajas(id) ON DELETE CASCADE,
        tipo text NOT NULL CHECK (tipo IN ('ingreso','egreso','retiro','ajuste')),
        concepto text NOT NULL,
        monto numeric(14,2) NOT NULL,
        medio_pago text NOT NULL DEFAULT 'efectivo',
        usuario_id uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        observacion text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_caja_mov_concepto_non_empty CHECK (length(trim(concepto)) > 0)
      )
    $ddl$, sch, sch, sch, sch);
  END IF;

  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_caja_mov_caja ON %I.caja_movimientos (empresa_id, caja_id, created_at)', sch);

  EXECUTE format('ALTER TABLE %I.caja_movimientos ENABLE ROW LEVEL SECURITY', sch);
  EXECUTE format('DROP POLICY IF EXISTS caja_mov_select ON %I.caja_movimientos', sch);
  EXECUTE format('CREATE POLICY caja_mov_select ON %I.caja_movimientos FOR SELECT USING (%I.puede_acceder_empresa(empresa_id))', sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS caja_mov_insert ON %I.caja_movimientos', sch);
  EXECUTE format('CREATE POLICY caja_mov_insert ON %I.caja_movimientos FOR INSERT WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS caja_mov_update ON %I.caja_movimientos', sch);
  EXECUTE format('CREATE POLICY caja_mov_update ON %I.caja_movimientos FOR UPDATE USING (%I.puede_acceder_empresa(empresa_id)) WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch, sch);
  EXECUTE format('DROP POLICY IF EXISTS caja_mov_delete ON %I.caja_movimientos', sch);
  EXECUTE format('CREATE POLICY caja_mov_delete ON %I.caja_movimientos FOR DELETE USING (%I.puede_acceder_empresa(empresa_id))', sch, sch);

  -- ── 3) ventas.caja_id (no se reasignan ventas históricas: quedan NULL) ─────
  EXECUTE format('ALTER TABLE %I.ventas ADD COLUMN IF NOT EXISTS caja_id uuid', sch);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_ventas_caja ON %I.ventas (empresa_id, caja_id)', sch);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = sch AND c.relname = 'ventas' AND con.conname = 'ventas_caja_id_fkey'
  ) THEN
    BEGIN
      EXECUTE format('ALTER TABLE %I.ventas ADD CONSTRAINT ventas_caja_id_fkey
        FOREIGN KEY (caja_id) REFERENCES %I.cajas(id) ON DELETE SET NULL', sch, sch);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[caja] no se pudo crear FK ventas.caja_id: %', SQLERRM;
    END;
  END IF;

  RAISE NOTICE '[caja] modulo de caja por turno aplicado en schema %.', sch;
END $$;
