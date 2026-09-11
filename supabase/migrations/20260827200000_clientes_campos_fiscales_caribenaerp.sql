-- Campos fiscales del cliente que necesita la facturación electrónica.
--
-- `es_contribuyente` no es un dato decorativo: el armador del XML se niega a
-- construir un documento para un receptor que tiene RUC cargado y no está
-- marcado como contribuyente, porque el SET devuelve 0301 [1264] ("RUC del
-- receptor no habilitado") y el envío se pierde. Sin la columna, cualquier
-- factura atada a un cliente real fallaba antes de salir.
--
-- `nombre_facturacion` es el nombre que va en el documento cuando difiere del
-- comercial: el ERP ya lo lee al armar el payload, así que su ausencia rompía
-- la consulta entera.
--
-- Las dos ya existen en la instancia de Caacupé, que es la que está operando
-- contra el SET.

BEGIN;

ALTER TABLE cucinaerp.clientes
  ADD COLUMN IF NOT EXISTS nombre_facturacion text,
  ADD COLUMN IF NOT EXISTS es_contribuyente   boolean;

-- Los clientes que ya tienen RUC son, por definición, contribuyentes: dejarlos
-- en NULL haría que su primera factura se frene sin motivo aparente.
UPDATE cucinaerp.clientes
   SET es_contribuyente = true
 WHERE es_contribuyente IS NULL
   AND COALESCE(TRIM(ruc), '') <> '';

COMMIT;
