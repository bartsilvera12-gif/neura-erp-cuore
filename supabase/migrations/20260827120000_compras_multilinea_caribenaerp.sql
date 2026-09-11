-- Permite que una compra tenga varios productos.
--
-- Una factura de proveedor trae varias líneas, y cada línea es una fila de
-- `compras` porque es la unidad que impacta el inventario: mueve su propio
-- stock y recalcula el costo de su producto. Todas las líneas de la misma
-- factura comparten `numero_control`.
--
-- El índice único por (empresa_id, numero_control) impedía justamente eso: la
-- segunda línea chocaba con la primera. Se reemplaza por uno que incluye el
-- producto, que sigue garantizando lo que importa — que un mismo producto no
-- entre dos veces en la misma factura, lo que sumaría el stock dos veces y
-- dejaría el costo promedio pisado por la última línea sin que se note.

BEGIN;

ALTER TABLE cucinaerp.compras
  DROP CONSTRAINT IF EXISTS uq_compras_empresa_numero_control;

DROP INDEX IF EXISTS cucinaerp.uq_compras_empresa_numero_control;

CREATE UNIQUE INDEX IF NOT EXISTS uq_compras_empresa_numero_producto
  ON cucinaerp.compras (empresa_id, numero_control, producto_id);

-- El listado y el reporte agrupan por número de control; sin esto cada
-- agrupación recorre la tabla entera.
CREATE INDEX IF NOT EXISTS idx_compras_empresa_numero
  ON cucinaerp.compras (empresa_id, numero_control);

COMMIT;
