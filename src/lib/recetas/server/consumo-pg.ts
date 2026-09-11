/**
 * Consumo de insumos por receta.
 *
 * Hay dos momentos en que una receta toca el inventario, y dependen de un dato
 * que ya existía en el producto — no hace falta una bandera nueva:
 *
 *   controla_stock = false → se arma al momento (una pizza que sale al plato).
 *     Sus insumos se descuentan cuando la comanda entra a cocina. Si NO tiene
 *     receta cargada, no se descuenta nada: se vende indefinidamente.
 *
 *   controla_stock = true  → se guarda con stock (una prepizza, una salsa
 *     madre). Se fabrica con `producirProducto` y al venderlo se descuenta él
 *     mismo. Su receta no se vuelve a explotar en la venta: los insumos ya se
 *     consumieron cuando se produjo.
 *
 * Todo corre en transacción: si falla el descuento de un insumo, no queda un
 * inventario a medio actualizar.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { PoolClient } from "pg";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

/** Una salida de insumo ya resuelta a la unidad en que el producto lleva stock. */
export interface ConsumoInsumo {
  insumo_producto_id: string;
  insumo_nombre: string;
  insumo_sku: string;
  /** En la unidad del insumo, con la merma ya aplicada. */
  cantidad: number;
  costo_unitario: number;
  /** Stock que queda después del descuento. Negativo = se produjo sin respaldo. */
  stock_resultante: number;
}

export interface ResultadoConsumo {
  consumos: ConsumoInsumo[];
  /** Insumos que quedaron en negativo: se avisa, no se bloquea. */
  faltantes: ConsumoInsumo[];
  /** true cuando la comanda ya había descontado y no se hizo nada. */
  ya_consumido: boolean;
}

/** Producto pedido, tal como sale de la comanda o de una orden de producción. */
interface LineaPedida {
  producto_id: string;
  cantidad: number;
}

/**
 * Explota las recetas de las líneas pedidas y descuenta los insumos.
 *
 * La conversión de unidades la hace `fn_factor_unidad` en la base — la misma que
 * usa el costeo, para que lo que se descuenta y lo que se costea nunca digan
 * cosas distintas.
 *
 * Solo se descuentan los insumos con control de stock activo. Ese interruptor,
 * por insumo, es lo que permite seguir el queso de cerca y no llevar la cuenta
 * de la sal.
 *
 * Se permite dejar stock en negativo a propósito. En un local a la noche,
 * bloquear una comanda porque el sistema cree que no queda queso es peor que un
 * negativo visible que después se corrige con un ajuste.
 */
async function descontarInsumos(
  client: PoolClient,
  schema: string,
  empresaId: string,
  lineas: LineaPedida[],
  referencia: string,
  usuario: { id: string | null; nombre: string | null }
): Promise<ConsumoInsumo[]> {
  if (lineas.length === 0) return [];

  const tP = quoteSchemaTable(schema, "productos");
  const tR = quoteSchemaTable(schema, "recetas");
  const tRI = quoteSchemaTable(schema, "receta_items");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  // Misma función de conversión que usa el costeo de la receta.
  const fnFactor = quoteSchemaTable(schema, "fn_factor_unidad");

  const productoIds = lineas.map((l) => l.producto_id);
  const cantidades = lineas.map((l) => l.cantidad);

  // Agrupa por insumo: si la comanda lleva dos pizzas que comparten mozzarella,
  // se descuenta y se registra una sola vez, no dos.
  const { rows: necesidades } = await client.query<{
    insumo_producto_id: string;
    nombre: string;
    sku: string;
    costo_promedio: string;
    cantidad_total: string;
  }>(
    `WITH pedido AS (
       SELECT unnest($2::uuid[]) AS producto_id, unnest($3::numeric[]) AS cantidad
     )
     SELECT ri.insumo_producto_id,
            pi.nombre,
            COALESCE(pi.sku, '') AS sku,
            COALESCE(pi.costo_promedio, 0) AS costo_promedio,
            SUM(
              pedido.cantidad
              * ri.cantidad
              * (1 + COALESCE(ri.merma_pct, 0))
              * ${fnFactor}(
                  COALESCE(ri.unidad_medida, pi.unidad_medida), pi.unidad_medida
                )
            ) AS cantidad_total
       FROM pedido
       JOIN ${tR} r  ON r.producto_id = pedido.producto_id
                    AND r.empresa_id = $1::uuid
                    AND r.activa
       JOIN ${tRI} ri ON ri.receta_id = r.id
       JOIN ${tP} pi  ON pi.id = ri.insumo_producto_id
                    -- Solo baja lo que el local decidió controlar. Un insumo
                    -- marcado "Sin control" (la sal, el agua) no se cuenta: si
                    -- se descontara igual, terminaría en un negativo enorme que
                    -- nadie va a corregir y que ensucia Movimientos.
                    AND pi.controla_stock
      GROUP BY ri.insumo_producto_id, pi.nombre, pi.sku, pi.costo_promedio`,
    [empresaId, productoIds, cantidades]
  );

  const salida: ConsumoInsumo[] = [];

  for (const n of necesidades) {
    const cantidad = Number(n.cantidad_total) || 0;
    if (cantidad <= 0) continue;

    const { rows: updRows } = await client.query<{ stock_actual: string }>(
      `UPDATE ${tP}
          SET stock_actual = stock_actual - $1::numeric,
              updated_at = now()
        WHERE id = $2::uuid AND empresa_id = $3::uuid
        RETURNING stock_actual`,
      [cantidad, n.insumo_producto_id, empresaId]
    );

    await client.query(
      `INSERT INTO ${tM} (
         empresa_id, producto_id, producto_nombre, producto_sku,
         tipo, cantidad, costo_unitario, origen, referencia, fecha,
         created_by, usuario_nombre
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         'SALIDA', $5::numeric, $6::numeric, 'consumo_receta', $7, now(),
         $8::uuid, $9
       )`,
      [
        empresaId,
        n.insumo_producto_id,
        n.nombre,
        n.sku,
        cantidad,
        Number(n.costo_promedio) || 0,
        referencia,
        usuario.id,
        usuario.nombre,
      ]
    );

    salida.push({
      insumo_producto_id: n.insumo_producto_id,
      insumo_nombre: n.nombre,
      insumo_sku: n.sku,
      cantidad,
      costo_unitario: Number(n.costo_promedio) || 0,
      stock_resultante: Number(updRows[0]?.stock_actual ?? 0),
    });
  }

  return salida;
}

/**
 * Descuenta los insumos de una comanda que entra a cocina.
 *
 * Idempotente por diseño: la comanda marca `insumos_consumidos_at` y una
 * segunda llamada no hace nada. Importa porque imprimir es reintentable —el
 * papel se traba, la impresora se queda sin rollo— y reimprimir no puede
 * descontar el queso dos veces.
 *
 * Solo se explotan los productos con controla_stock = false. Los que llevan
 * stock propio (reventa, o una prepizza ya producida) se descuentan al
 * facturar, en create-venta-pg; explotarlos acá los contaría dos veces.
 */
export async function consumirInsumosDeComanda(
  schemaRaw: string,
  empresaId: string,
  comandaId: string,
  usuario: { id: string | null; nombre: string | null }
): Promise<ResultadoConsumo> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "comandas");
  const tI = quoteSchemaTable(schema, "mesa_sesion_items");
  const tP = quoteSchemaTable(schema, "productos");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const { rows: comandaRows } = await client.query<{
      id: string;
      numero: number;
      batch_id: string | null;
      insumos_consumidos_at: string | null;
    }>(
      `SELECT id, numero, batch_id, insumos_consumidos_at
         FROM ${tC}
        WHERE id = $1::uuid AND empresa_id = $2::uuid
        FOR UPDATE`,
      [comandaId, empresaId]
    );
    const comanda = comandaRows[0];
    if (!comanda) {
      await client.query("ROLLBACK");
      throw new Error("Comanda no encontrada.");
    }
    if (comanda.insumos_consumidos_at) {
      await client.query("ROLLBACK");
      return { consumos: [], faltantes: [], ya_consumido: true };
    }

    // Los ítems cuelgan del batch de producción; las comandas viejas, del id.
    // Los cancelados no se cocinan, así que no consumen.
    const { rows: itemRows } = await client.query<{
      producto_id: string;
      cantidad: string;
      es_mitad_mitad: boolean;
      mitad_1_producto_id: string | null;
      mitad_2_producto_id: string | null;
    }>(
      `SELECT i.producto_id, i.cantidad, i.es_mitad_mitad,
              i.mitad_1_producto_id, i.mitad_2_producto_id
         FROM ${tI} i
        WHERE i.empresa_id = $1::uuid
          AND i.estado <> 'cancelado'
          AND (
            ($2::uuid IS NOT NULL AND i.produccion_batch_id = $2::uuid)
            OR ($2::uuid IS NULL AND i.comanda_id = $3::uuid)
          )`,
      [empresaId, comanda.batch_id, comandaId]
    );

    // Una pizza mitad y mitad consume media receta de cada sabor.
    const pedidas: LineaPedida[] = [];
    for (const it of itemRows) {
      const cant = Number(it.cantidad) || 0;
      if (cant <= 0) continue;
      if (it.es_mitad_mitad && it.mitad_1_producto_id && it.mitad_2_producto_id) {
        pedidas.push({ producto_id: it.mitad_1_producto_id, cantidad: cant / 2 });
        pedidas.push({ producto_id: it.mitad_2_producto_id, cantidad: cant / 2 });
      } else {
        pedidas.push({ producto_id: it.producto_id, cantidad: cant });
      }
    }

    let consumos: ConsumoInsumo[] = [];
    if (pedidas.length > 0) {
      const ids = [...new Set(pedidas.map((l) => l.producto_id))];
      const { rows: prods } = await client.query<{ id: string; controla_stock: boolean }>(
        `SELECT id, controla_stock FROM ${tP} WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresaId, ids]
      );
      const alMomento = new Set(prods.filter((p) => p.controla_stock === false).map((p) => p.id));
      const aExplotar = pedidas.filter((l) => alMomento.has(l.producto_id));

      consumos = await descontarInsumos(
        client,
        schema,
        empresaId,
        aExplotar,
        `CMD-${String(comanda.numero).padStart(4, "0")}`,
        usuario
      );
    }

    await client.query(
      `UPDATE ${tC} SET insumos_consumidos_at = now() WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [comandaId, empresaId]
    );

    await client.query("COMMIT");
    return {
      consumos,
      faltantes: consumos.filter((c) => c.stock_resultante < 0),
      ya_consumido: false,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export interface ResultadoProduccion {
  producto_nombre: string;
  cantidad_producida: number;
  stock_resultante: number;
  costo_unitario: number;
  consumos: ConsumoInsumo[];
  faltantes: ConsumoInsumo[];
}

/**
 * Fabrica un producto a partir de su receta: descuenta los insumos y suma el
 * resultado al stock del producto.
 *
 * Es para lo que se arma a mano y se guarda — una prepizza, una salsa madre —,
 * no para lo que sale directo al plato. Por eso exige que el producto lleve
 * stock: si no lo lleva, no hay dónde guardar lo producido y el consumo tiene
 * que pasar por la comanda.
 *
 * El costo del producto se recalcula como promedio ponderado entre lo que ya
 * había en stock y lo recién producido, igual que hace una compra. Así el costo
 * de la prepizza refleja lo que costó hacerla y no queda en cero.
 */
export async function producirProducto(
  schemaRaw: string,
  empresaId: string,
  productoId: string,
  cantidad: number,
  usuario: { id: string | null; nombre: string | null }
): Promise<ResultadoProduccion> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tP = quoteSchemaTable(schema, "productos");
  const tR = quoteSchemaTable(schema, "recetas");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");

  if (!(cantidad > 0)) throw new Error("La cantidad a producir debe ser mayor a 0.");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const { rows: prodRows } = await client.query<{
      id: string;
      nombre: string;
      sku: string | null;
      controla_stock: boolean;
      stock_actual: string;
      costo_promedio: string;
      rendimiento: string | null;
      receta_id: string | null;
    }>(
      `SELECT p.id, p.nombre, p.sku, p.controla_stock, p.stock_actual, p.costo_promedio,
              r.rendimiento_cantidad AS rendimiento, r.id AS receta_id
         FROM ${tP} p
         LEFT JOIN ${tR} r ON r.producto_id = p.id AND r.empresa_id = p.empresa_id AND r.activa
        WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid
        FOR UPDATE OF p`,
      [productoId, empresaId]
    );
    const prod = prodRows[0];
    if (!prod) {
      await client.query("ROLLBACK");
      throw new Error("Producto no encontrado.");
    }
    if (!prod.receta_id) {
      await client.query("ROLLBACK");
      throw new Error("El producto no tiene una receta activa: no hay con qué producirlo.");
    }
    if (prod.controla_stock === false) {
      await client.query("ROLLBACK");
      throw new Error(
        "Este producto no lleva stock, así que se arma al momento del pedido: sus insumos se descuentan cuando la comanda entra a cocina. Si querés fabricarlo y guardarlo, activá el control de stock en el producto."
      );
    }

    // El rendimiento dice cuántas unidades salen de una vuelta de receta.
    const rendimiento = Number(prod.rendimiento) || 1;
    const vueltas = cantidad / rendimiento;

    const consumos = await descontarInsumos(
      client,
      schema,
      empresaId,
      [{ producto_id: productoId, cantidad: vueltas }],
      `PROD-${prod.sku ?? prod.nombre}`,
      usuario
    );

    const costoTotal = consumos.reduce((s, c) => s + c.cantidad * c.costo_unitario, 0);
    const costoUnitario = cantidad > 0 ? costoTotal / cantidad : 0;

    // Promedio ponderado con lo que ya había, igual que una compra.
    const stockPrevio = Number(prod.stock_actual) || 0;
    const costoPrevio = Number(prod.costo_promedio) || 0;
    const stockNuevo = stockPrevio + cantidad;
    const costoPromedio =
      stockNuevo > 0
        ? (Math.max(stockPrevio, 0) * costoPrevio + cantidad * costoUnitario) / (Math.max(stockPrevio, 0) + cantidad)
        : costoUnitario;

    await client.query(
      `UPDATE ${tP}
          SET stock_actual = $1::numeric,
              costo_promedio = $2::numeric,
              updated_at = now()
        WHERE id = $3::uuid AND empresa_id = $4::uuid`,
      [stockNuevo, costoPromedio, productoId, empresaId]
    );

    await client.query(
      `INSERT INTO ${tM} (
         empresa_id, producto_id, producto_nombre, producto_sku,
         tipo, cantidad, costo_unitario, origen, referencia, fecha,
         created_by, usuario_nombre
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         'ENTRADA', $5::numeric, $6::numeric, 'produccion', $7, now(),
         $8::uuid, $9
       )`,
      [
        empresaId,
        productoId,
        prod.nombre,
        prod.sku ?? "",
        cantidad,
        costoUnitario,
        `PROD-${prod.sku ?? prod.nombre}`,
        usuario.id,
        usuario.nombre,
      ]
    );

    await client.query("COMMIT");
    return {
      producto_nombre: prod.nombre,
      cantidad_producida: cantidad,
      stock_resultante: stockNuevo,
      costo_unitario: costoUnitario,
      consumos,
      faltantes: consumos.filter((c) => c.stock_resultante < 0),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}
