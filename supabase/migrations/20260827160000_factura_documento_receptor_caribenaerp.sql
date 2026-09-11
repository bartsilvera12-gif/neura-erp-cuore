-- Guarda la cédula del receptor en la factura.
--
-- En el mostrador la factura se pide de tres formas: a nombre de una empresa
-- con RUC, a nombre de una persona con cédula, o sin datos (consumidor final).
-- La factura ya tenía dónde anotar el RUC y la razón social, pero no la cédula,
-- así que el caso del medio — que es el más común después de consumidor final —
-- no tenía dónde ir.
--
-- Importa para el XML: con RUC el documento sale como contribuyente (B2B) y
-- con cédula como consumidor final identificado (B2C). Meter una cédula en el
-- campo del RUC haría que el SET rechace el lote.

BEGIN;

ALTER TABLE cucinaerp.facturas
  ADD COLUMN IF NOT EXISTS cliente_documento text;

COMMIT;
