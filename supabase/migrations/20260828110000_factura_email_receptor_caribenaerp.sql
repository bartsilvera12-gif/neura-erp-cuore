-- Correo del receptor en la factura.
--
-- El XML del documento electrónico tiene un campo para el correo del receptor
-- (`dEmailRec`) que hoy sale vacío: el armador lo toma de la ficha del cliente,
-- y en el mostrador la mayoría de las facturas se emiten sin ficha.
--
-- Va en la factura y no sólo en el cliente por lo mismo que la razón social y
-- el RUC: si mañana el cliente cambia de correo, la factura ya emitida tiene
-- que seguir diciendo a dónde se mandó.

BEGIN;

ALTER TABLE cucinaerp.facturas
  ADD COLUMN IF NOT EXISTS cliente_email text;

COMMIT;
