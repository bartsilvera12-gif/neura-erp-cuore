-- Permite cobrar una venta con más de una forma de pago.
--
-- `ventas.metodo_pago` guarda un solo método, así que una venta de 100.000
-- pagada con 60.000 en efectivo y 40.000 por transferencia quedaba atribuida
-- entera a uno de los dos. Eso rompe el arqueo: el cierre de caja calcula el
-- efectivo esperado sumando las ventas por método, y 40.000 que nunca entraron
-- al cajón aparecían como faltante.
--
-- Cada forma de pago pasa a ser una fila. `ventas.metodo_pago` se conserva con
-- el método de mayor monto, para que el listado y los filtros que ya existen
-- sigan mostrando algo razonable sin tener que reescribirlos.
--
-- Es el mismo diseño que ya usa la instancia de Caacupé.

BEGIN;

CREATE TABLE IF NOT EXISTS cucinaerp.ventas_pagos_detalle (
  id                 uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id         uuid NOT NULL REFERENCES cucinaerp.empresas(id) ON DELETE CASCADE,
  venta_id           uuid NOT NULL REFERENCES cucinaerp.ventas(id) ON DELETE CASCADE,
  metodo_pago        text NOT NULL,
  monto              numeric NOT NULL,
  -- A qué cuenta entró la transferencia o el pago con tarjeta. Nulo en efectivo.
  cuenta_bancaria_id uuid REFERENCES cucinaerp.cuentas_bancarias(id) ON DELETE SET NULL,
  referencia         text,
  observacion        text,
  fecha_pago         timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ventas_pagos_detalle_metodo_check
    CHECK (metodo_pago = ANY (ARRAY['efectivo'::text, 'tarjeta'::text, 'transferencia'::text])),
  -- Una línea de cobro por 0 o negativa no es un cobro; sería una forma de
  -- descuadrar el arqueo sin que se note.
  CONSTRAINT ventas_pagos_detalle_monto_check CHECK (monto > 0)
);

-- El cierre de caja recorre los pagos de todas las ventas de una caja.
CREATE INDEX IF NOT EXISTS idx_ventas_pagos_detalle_venta
  ON cucinaerp.ventas_pagos_detalle (empresa_id, venta_id);

COMMIT;
