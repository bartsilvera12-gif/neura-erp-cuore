-- Agrega QR como forma de cobro.
--
-- Se cobra escaneando un QR y el dinero no entra al cajón: para el arqueo se
-- comporta como una transferencia. Se lo separa en vez de anotarlo como
-- transferencia porque el control de fin de día es distinto — el total de QR
-- se compara contra la liquidación del proveedor, no contra el extracto — y
-- mezclarlos deja al que cierra sin forma de saber cuál es cuál.
--
-- No hace falta ninguna conexión con el POS: igual que con una transferencia,
-- el cajero ve la confirmación en el celular y la registra. Lo que daría la
-- integración es que esa confirmación llegue sola.

BEGIN;

-- Detalle de cobro de la venta.
ALTER TABLE cucinaerp.ventas_pagos_detalle
  DROP CONSTRAINT IF EXISTS ventas_pagos_detalle_metodo_check;
ALTER TABLE cucinaerp.ventas_pagos_detalle
  ADD CONSTRAINT ventas_pagos_detalle_metodo_check
  CHECK (metodo_pago = ANY (ARRAY['efectivo'::text, 'tarjeta'::text, 'transferencia'::text, 'qr'::text]));

-- Método predominante que se guarda en la venta.
ALTER TABLE cucinaerp.ventas
  DROP CONSTRAINT IF EXISTS ventas_metodo_pago_chk;
ALTER TABLE cucinaerp.ventas
  ADD CONSTRAINT ventas_metodo_pago_chk
  CHECK ((metodo_pago IS NULL) OR (metodo_pago = ANY (ARRAY['efectivo'::text, 'tarjeta'::text, 'transferencia'::text, 'qr'::text])));

-- Conciliación bancaria: un cobro por QR también hay que contrastarlo contra
-- lo que efectivamente acreditó el proveedor.
ALTER TABLE cucinaerp.conciliacion_pagos
  DROP CONSTRAINT IF EXISTS conciliacion_pagos_medio_pago_check;
ALTER TABLE cucinaerp.conciliacion_pagos
  ADD CONSTRAINT conciliacion_pagos_medio_pago_check
  CHECK (medio_pago = ANY (ARRAY['transferencia'::text, 'tarjeta'::text, 'qr'::text]));

COMMIT;
