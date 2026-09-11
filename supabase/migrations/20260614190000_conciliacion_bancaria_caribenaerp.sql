-- =============================================================================
-- Conciliación bancaria (pagos transferencia/tarjeta) — SOLO schema cucinaerp.
--
-- Los pagos por transferencia/tarjeta de una venta entran como "pendiente" de
-- conciliación, asociados a la venta y a la caja abierta. Luego desde Reportes
-- se aprueban/rechazan. NO afectan el efectivo esperado de caja (eso no cambia).
-- Idempotente. No toca facturación ni otros schemas.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.ventas', sch)) IS NULL THEN
    RAISE NOTICE '[concil] schema % sin ventas; se omite.', sch; RETURN;
  END IF;

  -- ── cuentas_bancarias ─────────────────────────────────────────────────────
  IF to_regclass(format('%I.cuentas_bancarias', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.cuentas_bancarias (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        nombre text NOT NULL,
        banco text,
        numero_cuenta text,
        moneda text NOT NULL DEFAULT 'PYG',
        activo boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_cuenta_nombre_non_empty CHECK (length(trim(nombre)) > 0)
      )
    $ddl$, sch, sch);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_cuentas_emp ON %I.cuentas_bancarias (empresa_id, activo)', sch);

  -- ── conciliacion_pagos ────────────────────────────────────────────────────
  IF to_regclass(format('%I.conciliacion_pagos', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.conciliacion_pagos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        venta_id uuid NOT NULL REFERENCES %I.ventas(id) ON DELETE CASCADE,
        caja_id uuid REFERENCES %I.cajas(id) ON DELETE SET NULL,
        mesa_sesion_id uuid REFERENCES %I.mesa_sesiones(id) ON DELETE SET NULL,
        cuenta_bancaria_id uuid REFERENCES %I.cuentas_bancarias(id) ON DELETE SET NULL,
        medio_pago text NOT NULL CHECK (medio_pago IN ('transferencia','tarjeta')),
        monto numeric(14,2) NOT NULL,
        referencia text,
        comprobante_url text,
        entidad text,
        tipo_tarjeta text,
        fecha_pago timestamptz,
        estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobado','rechazado')),
        observacion text,
        registrado_por uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        aprobado_por uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        aprobado_at timestamptz,
        rechazado_por uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        rechazado_at timestamptz,
        motivo_rechazo text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$, sch, sch, sch, sch, sch, sch, sch, sch, sch);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_concil_emp_estado ON %I.conciliacion_pagos (empresa_id, estado, created_at DESC)', sch);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_concil_caja ON %I.conciliacion_pagos (empresa_id, caja_id)', sch);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_concil_venta ON %I.conciliacion_pagos (empresa_id, venta_id)', sch);
END $$;

DO $$
DECLARE sch text := 'cucinaerp'; t text;
BEGIN
  IF to_regclass(format('%I.conciliacion_pagos', sch)) IS NULL THEN RETURN; END IF;
  FOREACH t IN ARRAY ARRAY['cuentas_bancarias','conciliacion_pagos'] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', sch, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_select ON %I.%I FOR SELECT USING (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_insert ON %I.%I FOR INSERT WITH CHECK (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch);
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_update ON %I.%I FOR UPDATE USING (%I.puede_acceder_empresa(empresa_id)) WITH CHECK (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch, sch);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_delete ON %I.%I FOR DELETE USING (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch);
  END LOOP;
  EXECUTE format('DROP TRIGGER IF EXISTS tr_concil_updated ON %I.conciliacion_pagos', sch);
  EXECUTE format('CREATE TRIGGER tr_concil_updated BEFORE UPDATE ON %I.conciliacion_pagos FOR EACH ROW EXECUTE FUNCTION %I.set_updated_at()', sch, sch);
  RAISE NOTICE '[concil] cuentas_bancarias + conciliacion_pagos aplicados en %.', sch;
END $$;
