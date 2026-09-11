-- Anulación de ventas.
--
-- Cancelar el documento electrónico en el SET dejaba la venta viva: seguía
-- sumando al arqueo de caja y a los reportes, y el stock descontado no volvía.
-- El ERP no tenía dónde anotar que una venta se dio de baja — `ventas.estado`
-- admite 'anulada' pero nada decía cuándo, quién ni por qué.
--
-- Estas tres columnas cierran eso. El cálculo de caja y los reportes ya
-- excluyen las ventas anuladas, así que con marcarlas alcanza para que dejen de
-- contar.

BEGIN;

ALTER TABLE cucinaerp.ventas
  ADD COLUMN IF NOT EXISTS anulada_at       timestamptz,
  ADD COLUMN IF NOT EXISTS anulada_por      uuid REFERENCES cucinaerp.usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS anulacion_motivo text;

COMMIT;
