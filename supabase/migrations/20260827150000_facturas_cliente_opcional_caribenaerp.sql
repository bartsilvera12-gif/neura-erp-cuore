-- Permite emitir facturas sin cliente en la ficha.
--
-- `facturas.cliente_id` venía NOT NULL de cuando la única factura posible era
-- la de una suscripción, que siempre tiene a quién cobrarle. En el mostrador es
-- al revés: casi nadie está cargado como cliente, y la mayoría de las facturas
-- van a consumidor final o a un RUC que se tipea en el momento y se guarda en
-- la propia factura (cliente_razon_social / cliente_ruc).
--
-- La instancia de Caacupé ya hizo este mismo cambio cuando abrió el puente
-- venta → factura, por el mismo motivo.

BEGIN;

ALTER TABLE cucinaerp.facturas
  ALTER COLUMN cliente_id DROP NOT NULL;

COMMIT;
