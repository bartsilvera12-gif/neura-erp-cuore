-- =============================================================================
-- Módulo MESAS (pedidos por tablet de mozo) — SOLO schema `cucinaerp`.
--
-- Cuenta abierta por mesa: el mozo agrega productos a una sesión de mesa. NO se
-- crea venta, NO se descuenta stock, NO se toca caja hasta que CAJA factura la
-- mesa (reutilizando la lógica de ventas/caja existente). Una mesa se factura
-- de forma idempotente (mesa_sesiones.venta_id evita duplicar).
--
-- Instancia MONOCLIENTE: catálogo (empresas, usuarios, productos, ventas,
-- modulos) y funciones RLS/trigger viven DENTRO de cucinaerp. Todo schema-local.
-- Idempotente. NO toca public/zentra_erp ni otros clientes.
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.ventas', sch)) IS NULL THEN
    RAISE NOTICE '[mesas] schema % sin tabla ventas; se omite.', sch;
    RETURN;
  END IF;

  -- ── 1) mesas ──────────────────────────────────────────────────────────────
  IF to_regclass(format('%I.mesas', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.mesas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        numero integer NOT NULL,
        nombre text,
        estado text NOT NULL DEFAULT 'libre'
          CHECK (estado IN ('libre','ocupada','por_cobrar','cerrada','inactiva')),
        activo boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_mesas_empresa_numero UNIQUE (empresa_id, numero)
      )
    $ddl$, sch, sch);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mesas_empresa_estado ON %I.mesas (empresa_id, estado, activo)', sch);

  -- ── 2) mesa_sesiones ──────────────────────────────────────────────────────
  IF to_regclass(format('%I.mesa_sesiones', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.mesa_sesiones (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        mesa_id uuid NOT NULL REFERENCES %I.mesas(id) ON DELETE CASCADE,
        estado text NOT NULL DEFAULT 'abierta'
          CHECK (estado IN ('abierta','por_cobrar','facturada','cancelada')),
        mozo_id uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        abierta_at timestamptz NOT NULL DEFAULT now(),
        enviada_caja_at timestamptz,
        cerrada_at timestamptz,
        venta_id uuid REFERENCES %I.ventas(id) ON DELETE SET NULL,
        observacion text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$, sch, sch, sch, sch, sch);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mesa_ses_empresa_estado ON %I.mesa_sesiones (empresa_id, estado)', sch);
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mesa_ses_mesa ON %I.mesa_sesiones (empresa_id, mesa_id, estado)', sch);
  -- Una sola sesión viva (abierta/por_cobrar) por mesa.
  EXECUTE format($ix$CREATE UNIQUE INDEX IF NOT EXISTS uq_mesa_ses_viva ON %I.mesa_sesiones (mesa_id) WHERE estado IN ('abierta','por_cobrar')$ix$, sch);

  -- ── 3) mesa_sesion_items ──────────────────────────────────────────────────
  IF to_regclass(format('%I.mesa_sesion_items', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.mesa_sesion_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL REFERENCES %I.empresas(id) ON DELETE CASCADE,
        sesion_id uuid NOT NULL REFERENCES %I.mesa_sesiones(id) ON DELETE CASCADE,
        producto_id uuid NOT NULL REFERENCES %I.productos(id) ON DELETE RESTRICT,
        producto_nombre text NOT NULL,
        sku text,
        cantidad numeric(14,3) NOT NULL CHECK (cantidad > 0),
        precio_unitario numeric(14,2) NOT NULL,
        total numeric(14,2) NOT NULL,
        observacion text,
        estado text NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','cancelado')),
        creado_por uuid REFERENCES %I.usuarios(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$, sch, sch, sch, sch, sch);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS ix_mesa_items_sesion ON %I.mesa_sesion_items (empresa_id, sesion_id, estado)', sch);
END $$;

-- RLS + triggers por tabla (idempotente).
DO $$
DECLARE
  sch text := 'cucinaerp';
  t   text;
BEGIN
  IF to_regclass(format('%I.mesas', sch)) IS NULL THEN RETURN; END IF;
  FOREACH t IN ARRAY ARRAY['mesas','mesa_sesiones','mesa_sesion_items'] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', sch, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_select ON %I.%I FOR SELECT USING (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_insert ON %I.%I FOR INSERT WITH CHECK (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch);
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_update ON %I.%I FOR UPDATE USING (%I.puede_acceder_empresa(empresa_id)) WITH CHECK (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch, sch);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON %I.%I', t, sch, t);
    EXECUTE format('CREATE POLICY %I_delete ON %I.%I FOR DELETE USING (%I.puede_acceder_empresa(empresa_id))', t, sch, t, sch);

    EXECUTE format('DROP TRIGGER IF EXISTS tr_%I_updated ON %I.%I', t, sch, t);
    EXECUTE format('CREATE TRIGGER tr_%I_updated BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.set_updated_at()', t, sch, t, sch);
  END LOOP;
END $$;

-- Seed: mesas 1..12 por empresa (idempotente).
INSERT INTO cucinaerp.mesas (empresa_id, numero)
SELECT e.id, g.n
FROM cucinaerp.empresas e
CROSS JOIN generate_series(1, 12) AS g(n)
WHERE NOT EXISTS (
  SELECT 1 FROM cucinaerp.mesas m WHERE m.empresa_id = e.id AND m.numero = g.n
);

-- Catálogo de módulos: alta de "mesas" (schema-local) + activación para la empresa.
INSERT INTO cucinaerp.modulos (nombre, slug, descripcion)
SELECT 'Mesas', 'mesas', 'Pedidos por mesa para mozos (tablet)'
WHERE NOT EXISTS (SELECT 1 FROM cucinaerp.modulos WHERE slug = 'mesas');

INSERT INTO cucinaerp.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
FROM cucinaerp.empresas e
CROSS JOIN cucinaerp.modulos m
WHERE m.slug = 'mesas'
  AND NOT EXISTS (
    SELECT 1 FROM cucinaerp.empresa_modulos em
    WHERE em.empresa_id = e.id AND em.modulo_id = m.id
  );
