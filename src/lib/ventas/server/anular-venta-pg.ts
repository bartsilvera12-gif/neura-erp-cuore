/**
 * Anula una venta: devuelve el stock, la saca del arqueo y deja constancia.
 *
 * Se llama al cancelar el documento electrónico en el SET. Antes eso dejaba la
 * venta viva: seguía sumando al efectivo esperado del turno y a los reportes, y
 * la mercadería descontada no volvía al inventario. El cajero cerraba con un
 * faltante que no era suyo.
 *
 * No borra nada. La venta queda marcada como anulada con su motivo, y la
 * devolución de stock entra como un movimiento propio — el inventario tiene que
 * poder explicar por qué volvió esa mercadería, no aparecer con más stock sin
 * razón visible.
 *
 * Idempotente: anular dos veces no duplica la devolución de stock.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { Pool } from "pg";

function pool(): Pool {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool de Postgres no disponible.");
  return p;
}

export interface AnularVentaResult {
  ok: boolean;
  /** true si ya estaba anulada: no se hizo nada y no es un error. */
  yaAnulada: boolean;
  /** Cuántas líneas devolvieron stock. */
  productosDevueltos: number;
  message: string;
}

export async function anularVentaPg(
  schemaRaw: string,
  empresaId: string,
  params: {
    ventaId: string;
    motivo: string;
    usuarioId?: string | null;
    usuarioNombre?: string | null;
  }
): Promise<AnularVentaResult> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tV = quoteSchemaTable(schema, "ventas");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const { rows: ventas } = await client.query<{
      id: string;
      numero_control: string;
      estado: string;
    }>(
      `SELECT id, numero_control, estado FROM ${tV}
        WHERE id = $1::uuid AND empresa_id = $2::uuid
          FOR UPDATE`,
      [params.ventaId, empresaId]
    );
    const venta = ventas[0];
    if (!venta) {
      await client.query("ROLLBACK");
      return { ok: false, yaAnulada: false, productosDevueltos: 0, message: "La venta no existe." };
    }
    if (venta.estado === "anulada") {
      await client.query("ROLLBACK");
      return {
        ok: true,
        yaAnulada: true,
        productosDevueltos: 0,
        message: `${venta.numero_control} ya estaba anulada.`,
      };
    }

    // Devolución de stock: una entrada por cada salida que generó la venta.
    // Sólo las líneas que movieron stock tienen movimiento — los productos de
    // menú no descuentan, así que no hay nada que devolver.
    const { rows: salidas } = await client.query<{
      producto_id: string;
      producto_nombre: string;
      producto_sku: string;
      cantidad: string | number;
      costo_unitario: string | number;
    }>(
      `SELECT producto_id, producto_nombre, producto_sku, cantidad, costo_unitario
         FROM ${tM}
        WHERE empresa_id = $1::uuid AND venta_id = $2::uuid
          AND origen = 'venta' AND tipo = 'SALIDA'`,
      [empresaId, params.ventaId]
    );

    const referencia = `Anulación ${venta.numero_control}`;
    for (const s of salidas) {
      const cantidad = Number(s.cantidad) || 0;
      if (cantidad <= 0) continue;

      await client.query(
        `UPDATE ${tP} SET stock_actual = stock_actual + $1::numeric, updated_at = now()
          WHERE id = $2::uuid AND empresa_id = $3::uuid`,
        [cantidad, s.producto_id, empresaId]
      );
      await client.query(
        `INSERT INTO ${tM} (
           empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
           costo_unitario, origen, referencia, fecha, venta_id, created_by, usuario_nombre
         ) VALUES ($1::uuid, $2::uuid, $3, $4, 'ENTRADA', $5::numeric,
                   $6::numeric, 'venta', $7, now(), $8::uuid, $9::uuid, $10)`,
        [
          empresaId,
          s.producto_id,
          s.producto_nombre,
          s.producto_sku,
          cantidad,
          Number(s.costo_unitario) || 0,
          referencia,
          params.ventaId,
          params.usuarioId ?? null,
          params.usuarioNombre ?? null,
        ]
      );
    }

    await client.query(
      `UPDATE ${tV}
          SET estado = 'anulada', anulada_at = now(), anulada_por = $1::uuid,
              anulacion_motivo = $2, updated_at = now()
        WHERE id = $3::uuid AND empresa_id = $4::uuid`,
      [params.usuarioId ?? null, params.motivo.slice(0, 500), params.ventaId, empresaId]
    );

    await client.query("COMMIT");
    return {
      ok: true,
      yaAnulada: false,
      productosDevueltos: salidas.length,
      message:
        salidas.length > 0
          ? `${venta.numero_control} anulada. Volvieron ${salidas.length} producto(s) al stock.`
          : `${venta.numero_control} anulada. No había stock que devolver.`,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}
