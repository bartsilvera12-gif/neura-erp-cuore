-- ============================================================================
-- Consumo de insumos por receta y producción manual
-- ----------------------------------------------------------------------------
-- Hasta ahora las recetas solo servían para calcular un costo teórico: vender
-- un producto del menú no descontaba absolutamente nada, porque el descuento de
-- stock se salta los productos con controla_stock = false.
--
-- Esta migración habilita los dos orígenes de movimiento que faltaban:
--
--   consumo_receta → salida de insumos cuando la comanda entra a cocina
--   produccion     → salida de insumos + entrada del producto terminado,
--                    para lo que se arma a mano y se guarda con stock
--                    (una prepizza, una salsa madre)
--
-- La regla de qué camino aplica sale de un dato que ya existe, sin agregar
-- banderas nuevas:
--
--   controla_stock = false  → se arma al momento. Si tiene receta, sus insumos
--                             se descuentan cuando la comanda sale a cocina.
--                             Si no tiene receta, se vende indefinidamente.
--   controla_stock = true   → se produce (botón Producir) o se compra, y al
--                             venderlo se descuenta él mismo. Su receta NO se
--                             vuelve a explotar en la venta: los insumos ya se
--                             consumieron al producirlo.
-- ============================================================================

DO $$
BEGIN
  ALTER TABLE cucinaerp.movimientos_inventario
    DROP CONSTRAINT IF EXISTS movimientos_inventario_origen_check;

  ALTER TABLE cucinaerp.movimientos_inventario
    ADD CONSTRAINT movimientos_inventario_origen_check
    CHECK (origen = ANY (ARRAY[
      'compra'::text,
      'venta'::text,
      'ajuste_manual'::text,
      'inventario_inicial'::text,
      'consumo_receta'::text,
      'produccion'::text
    ]));
END $$;

-- Marca de consumo en la comanda: sin esto, reimprimir una comanda volvería a
-- descontar los insumos. La impresión es reintentable por diseño (el papel se
-- traba, la impresora se queda sin rollo); el consumo no.
ALTER TABLE cucinaerp.comandas
  ADD COLUMN IF NOT EXISTS insumos_consumidos_at timestamptz;

COMMENT ON COLUMN cucinaerp.comandas.insumos_consumidos_at IS
  'Momento en que se descontaron los insumos de las recetas de esta comanda. NULL = todavía no se consumieron. Hace idempotente la reimpresión.';
