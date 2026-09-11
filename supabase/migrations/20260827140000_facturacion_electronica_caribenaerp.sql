-- Prepara la base de Cucina del Cuore para la facturación electrónica.
--
-- El motor SIFEN ya estaba instalado (facturas, factura_electronica,
-- sifen_jobs), pero faltaba el puente entre una venta y su factura: no había
-- forma de decir "esta factura sale de esta venta". Sin eso el cajero podía
-- emitir, pero nada quedaba atado al ticket que cobró.
--
-- Se copian las columnas de la instancia de Caacupé, que es la que está
-- operando contra el SET, menos `sucursal_id`: Cucina del Cuore es un solo local y no
-- tiene tabla de sucursales, así que esa columna no tendría de dónde salir.
--
-- Todo es aditivo y nullable. La única excepción es factura_items.tipo_iva,
-- que va NOT NULL con default '10%' porque el desglose del IVA es obligatorio
-- en el XML del SET; como la tabla está vacía, el default no altera nada.

BEGIN;

-- ── Venta ↔ factura ───────────────────────────────────────────────────────
ALTER TABLE cucinaerp.ventas
  ADD COLUMN IF NOT EXISTS factura_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ventas_factura_id_fkey'
      AND conrelid = 'cucinaerp.ventas'::regclass
  ) THEN
    ALTER TABLE cucinaerp.ventas
      ADD CONSTRAINT ventas_factura_id_fkey
      FOREIGN KEY (factura_id) REFERENCES cucinaerp.facturas(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ventas_factura ON cucinaerp.ventas (factura_id);

-- ── Datos que la factura necesita para el XML ─────────────────────────────
-- La razón social y el RUC se guardan en la factura y no sólo en el cliente:
-- si mañana el cliente cambia de razón social, la factura ya emitida tiene que
-- seguir diciendo lo que decía el papel que se entregó.
ALTER TABLE cucinaerp.facturas
  ADD COLUMN IF NOT EXISTS cliente_razon_social text,
  ADD COLUMN IF NOT EXISTS cliente_ruc          text,
  ADD COLUMN IF NOT EXISTS origen_venta_id      uuid,
  ADD COLUMN IF NOT EXISTS observaciones        text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facturas_origen_venta_id_fkey'
      AND conrelid = 'cucinaerp.facturas'::regclass
  ) THEN
    ALTER TABLE cucinaerp.facturas
      ADD CONSTRAINT facturas_origen_venta_id_fkey
      FOREIGN KEY (origen_venta_id) REFERENCES cucinaerp.ventas(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Una venta se factura una sola vez. Parcial porque la enorme mayoría de las
-- ventas de mostrador nunca van a tener factura y quedan en NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_facturas_origen_venta
  ON cucinaerp.facturas (empresa_id, origen_venta_id)
  WHERE origen_venta_id IS NOT NULL;

-- ── Desglose de IVA por ítem ──────────────────────────────────────────────
ALTER TABLE cucinaerp.factura_items
  ADD COLUMN IF NOT EXISTS tipo_iva text NOT NULL DEFAULT '10%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'factura_items_tipo_iva_check'
      AND conrelid = 'cucinaerp.factura_items'::regclass
  ) THEN
    ALTER TABLE cucinaerp.factura_items
      ADD CONSTRAINT factura_items_tipo_iva_check
      CHECK (tipo_iva = ANY (ARRAY['EXENTA'::text, '5%'::text, '10%'::text]));
  END IF;
END $$;

-- ── Contacto del emisor en el KUDE ────────────────────────────────────────
ALTER TABLE cucinaerp.empresa_sifen_config
  ADD COLUMN IF NOT EXISTS emisor_telefono text,
  ADD COLUMN IF NOT EXISTS emisor_email    text;

COMMIT;
