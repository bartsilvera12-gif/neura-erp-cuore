/**
 * PG directo para Compras. Mismo patron que productos-pg / proveedores-pg:
 * pool singleton + queries parametrizadas + identifier escape.
 *
 * insertCompra realiza la operacion en transaccion:
 *   1) inserta compra con numero_control generado por secuencia local
 *   2) inserta movimiento ENTRADA (origen=compra) con audit
 *   3) actualiza producto.precio_venta + costo_promedio + stock_actual
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { sqlDiaLocal, sqlDesdeDiaLocal, sqlHastaDiaLocal } from "@/lib/fechas/zona-paraguay";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

export interface CompraRow {
  id: string;
  empresa_id: string;
  proveedor_id: string;
  proveedor_nombre: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: string | number;
  moneda: string;
  tipo_cambio: string | number;
  costo_unitario_original: string | number;
  costo_unitario: string | number;
  iva_tipo: string;
  subtotal: string | number;
  monto_iva: string | number;
  total: string | number;
  precio_venta: string | number;
  margen_venta: string | number | null;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  numero_control: string;
  estado: string;
  fecha: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  usuario_nombre: string | null;
}

const COLS = `
  id, empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
  cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
  iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
  tipo_pago, plazo_dias, nro_timbrado, numero_control, estado, fecha,
  created_at, updated_at, created_by, usuario_nombre
`;

export interface InsertCompraInput {
  proveedor_id: string;
  proveedor_nombre: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  moneda: string;
  tipo_cambio: number;
  costo_unitario_original: number;
  costo_unitario: number;
  iva_tipo: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  precio_venta: number;
  margen_venta: number | null;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  created_by: string | null;
  usuario_nombre: string | null;
}

export async function listCompras(
  schemaRaw: string,
  empresaId: string
): Promise<CompraRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "compras");
  const { rows } = await pool().query<CompraRow>(
    `SELECT ${COLS} FROM ${t} WHERE empresa_id = $1::uuid ORDER BY fecha DESC LIMIT 500`,
    [empresaId]
  );
  return rows;
}

/** Genera proximo COMP-XXXXXX leyendo el maximo existente. */
async function nextNumeroControl(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string
): Promise<string> {
  const t = quoteSchemaTable(schema, "compras");
  const { rows } = await client.query<{ maxn: number | null }>(
    `SELECT COALESCE(MAX(
       CASE WHEN numero_control ~ '^COMP-[0-9]+$'
            THEN (substring(numero_control from 6))::int
            ELSE 0 END
     ), 0) AS maxn
     FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  const next = Number(rows[0]?.maxn ?? 0) + 1;
  return `COMP-${String(next).padStart(6, "0")}`;
}

/** Cabecera: lo que es igual para toda la factura del proveedor. */
export interface CompraCabeceraInput {
  proveedor_id: string;
  proveedor_nombre: string;
  moneda: string;
  tipo_cambio: number;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  created_by: string | null;
  usuario_nombre: string | null;
}

/**
 * Una linea de la factura. El IVA va por linea porque una misma factura puede
 * traer gravadas al 10, al 5 y exentas.
 */
export interface CompraLineaInput {
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  costo_unitario_original: number;
  costo_unitario: number;
  iva_tipo: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  precio_venta: number;
  margen_venta: number | null;
}

export interface CompraMultiResult {
  numero_control: string;
  compras: CompraRow[];
  movimiento_warning: string | null;
}

/**
 * Registra una compra de varias lineas.
 *
 * Cada linea es una fila de compras y todas comparten numero_control: la
 * factura del proveedor es una sola, los productos son varios. No se separo en
 * una tabla de cabecera aparte porque la linea ya es la unidad que impacta el
 * inventario — mueve su propio stock y recalcula el costo de su producto — y
 * partirla en dos tablas obligaria a sostener el vinculo sin ganar nada.
 *
 * Todo va en una transaccion: si una linea falla no queda media factura
 * cargada moviendo stock a medias.
 */
export async function insertCompraMultilinea(
  schemaRaw: string,
  empresaId: string,
  cab: CompraCabeceraInput,
  lineas: CompraLineaInput[]
): Promise<CompraMultiResult> {
  if (lineas.length === 0) throw new Error('La compra no tiene productos.');

  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, 'compras');
  const tM = quoteSchemaTable(schema, 'movimientos_inventario');
  const tP = quoteSchemaTable(schema, 'productos');

  const client = await pool().connect();
  const compras: CompraRow[] = [];
  let fallosMovimiento = 0;

  try {
    await client.query('BEGIN');

    const numero = await nextNumeroControl(client, schema, empresaId);

    for (const l of lineas) {
      const { rows: compraRows } = await client.query<CompraRow>(
        `INSERT INTO ${tC} (
           empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
           cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
           iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
           tipo_pago, plazo_dias, nro_timbrado, numero_control, estado, fecha,
           created_by, usuario_nombre
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4::uuid, $5,
           $6::numeric, $7, $8::numeric, $9::numeric, $10::numeric,
           $11, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
           $17, $18::integer, $19, $20, 'registrada', now(),
           $21::uuid, $22
         )
         RETURNING ${COLS}`,
        [
          empresaId,
          cab.proveedor_id,
          cab.proveedor_nombre,
          l.producto_id,
          l.producto_nombre,
          l.cantidad,
          cab.moneda,
          cab.tipo_cambio,
          l.costo_unitario_original,
          l.costo_unitario,
          l.iva_tipo,
          l.subtotal,
          l.monto_iva,
          l.total,
          l.precio_venta,
          l.margen_venta,
          cab.tipo_pago,
          cab.plazo_dias,
          cab.nro_timbrado,
          numero,
          cab.created_by,
          cab.usuario_nombre,
        ]
      );
      compras.push(compraRows[0]);

      // Movimiento ENTRADA (origen=compra). Best-effort: si falla, la compra
      // queda registrada pero se avisa.
      try {
        await client.query(
          `INSERT INTO ${tM} (
             empresa_id, producto_id, producto_nombre, producto_sku,
             tipo, cantidad, costo_unitario, origen, referencia, fecha,
             created_by, usuario_nombre
           )
           SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''),
                  'ENTRADA', $4::numeric, $5::numeric, 'compra', $6, now(),
                  $7::uuid, $8
           FROM ${tP} p WHERE p.id = $2::uuid`,
          [
            empresaId,
            l.producto_id,
            l.producto_nombre,
            l.cantidad,
            l.costo_unitario,
            numero,
            cab.created_by,
            cab.usuario_nombre,
          ]
        );
      } catch (movErr) {
        fallosMovimiento++;
        console.error('[compras-pg] movimiento ENTRADA fallo', {
          schema, empresaId, numero, producto: l.producto_id,
          message: movErr instanceof Error ? movErr.message : String(movErr),
          code: (movErr as { code?: string })?.code,
        });
      }

      // Actualizar producto: stock + costo_promedio + precio_venta.
      // El precio sólo se pisa si la línea trae uno: comprar de nuevo algo no
      // implica cambiarle el precio de venta, y en ese caso llega en 0.
      await client.query(
        `UPDATE ${tP}
            SET stock_actual = stock_actual + $1::numeric,
                costo_promedio = $2::numeric,
                precio_venta = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE precio_venta END,
                updated_at = now()
          WHERE id = $4::uuid AND empresa_id = $5::uuid`,
        [l.cantidad, l.costo_unitario, l.precio_venta, l.producto_id, empresaId]
      );
    }

    await client.query('COMMIT');
    return {
      numero_control: numero,
      compras,
      movimiento_warning:
        fallosMovimiento === 0
          ? null
          : fallosMovimiento === 1
            ? 'La compra se guardó pero una línea no pudo registrar su movimiento de entrada en inventario.'
            : `La compra se guardó pero ${fallosMovimiento} líneas no pudieron registrar su movimiento de entrada en inventario.`,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export interface CompraResult {
  compra: CompraRow;
  movimiento_id: string | null;
  movimiento_warning: string | null;
}

/** Compra de un solo producto: envuelve la multilinea con una sola linea. */
export async function insertCompraConImpacto(
  schemaRaw: string,
  empresaId: string,
  d: InsertCompraInput
): Promise<CompraResult> {
  const out = await insertCompraMultilinea(
    schemaRaw,
    empresaId,
    {
      proveedor_id: d.proveedor_id,
      proveedor_nombre: d.proveedor_nombre,
      moneda: d.moneda,
      tipo_cambio: d.tipo_cambio,
      tipo_pago: d.tipo_pago,
      plazo_dias: d.plazo_dias,
      nro_timbrado: d.nro_timbrado,
      created_by: d.created_by,
      usuario_nombre: d.usuario_nombre,
    },
    [
      {
        producto_id: d.producto_id,
        producto_nombre: d.producto_nombre,
        cantidad: d.cantidad,
        costo_unitario_original: d.costo_unitario_original,
        costo_unitario: d.costo_unitario,
        iva_tipo: d.iva_tipo,
        subtotal: d.subtotal,
        monto_iva: d.monto_iva,
        total: d.total,
        precio_venta: d.precio_venta,
        margen_venta: d.margen_venta,
      },
    ]
  );
  return {
    compra: out.compras[0],
    movimiento_id: null,
    movimiento_warning: out.movimiento_warning,
  };
}

export async function getCompraById(
  schemaRaw: string,
  empresaId: string,
  id: string
): Promise<CompraRow | null> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "compras");
  const { rows } = await pool().query<CompraRow>(
    `SELECT ${COLS} FROM ${t} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId]
  );
  return rows[0] ?? null;
}

/** Campos administrativos de una compra: no alteran stock ni costos. */
export interface UpdateCompraInput {
  tipo_pago?: string;
  plazo_dias?: number | null;
  nro_timbrado?: string;
  proveedor_id?: string;
  proveedor_nombre?: string;
  fecha?: string;
}

/**
 * Edita solo los campos administrativos.
 *
 * Cantidad, costo y precio quedan deliberadamente fuera: ya impactaron el stock
 * y el costo promedio del producto, así que cambiarlos "en el papel" dejaría el
 * inventario mintiendo. Para corregir esos valores hay que borrar la compra
 * (lo que revierte el movimiento) y cargarla de nuevo.
 */
export async function updateCompraCampos(
  schemaRaw: string,
  empresaId: string,
  id: string,
  d: UpdateCompraInput
): Promise<CompraRow | null> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "compras");

  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (frag: string, v: unknown) => { vals.push(v); sets.push(frag.replace("$?", `$${vals.length}`)); };

  if (d.tipo_pago !== undefined) push("tipo_pago = $?", d.tipo_pago);
  if (d.plazo_dias !== undefined) push("plazo_dias = $?::integer", d.plazo_dias);
  if (d.nro_timbrado !== undefined) push("nro_timbrado = $?", d.nro_timbrado);
  if (d.proveedor_id !== undefined) push("proveedor_id = $?::uuid", d.proveedor_id);
  if (d.proveedor_nombre !== undefined) push("proveedor_nombre = $?", d.proveedor_nombre);
  if (d.fecha !== undefined) push("fecha = $?::timestamptz", d.fecha);

  if (sets.length === 0) return getCompraById(schema, empresaId, id);

  sets.push("updated_at = now()");
  vals.push(id, empresaId);
  const { rows } = await pool().query<CompraRow>(
    `UPDATE ${t} SET ${sets.join(", ")}
      WHERE id = $${vals.length - 1}::uuid AND empresa_id = $${vals.length}::uuid
      RETURNING ${COLS}`,
    vals
  );
  return rows[0] ?? null;
}

export interface BorradoCompraResult {
  borrada: boolean;
  stock_revertido: number;
  movimientos_borrados: number;
  /** El costo promedio y el precio de venta que la compra pisó no se pueden reconstruir. */
  advertencia: string | null;
}

/**
 * Borra una compra revirtiendo lo que hizo al registrarse.
 *
 * Todo en una transacción, y en orden inverso al alta:
 *   1) descuenta del stock la cantidad que había entrado
 *   2) borra el movimiento ENTRADA que la compra generó
 *   3) borra la compra
 *
 * Lo que NO se puede revertir: al registrarse, la compra pisó `costo_promedio` y
 * `precio_venta` del producto con sus propios valores, y los anteriores no se
 * guardaron en ningún lado. Quedan como están y se avisa al usuario — es
 * preferible a inventar un valor.
 */
export async function deleteCompraConReversa(
  schemaRaw: string,
  empresaId: string,
  id: string
): Promise<BorradoCompraResult> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "compras");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const { rows: compraRows } = await client.query<CompraRow>(
      `SELECT ${COLS} FROM ${tC}
        WHERE id = $1::uuid AND empresa_id = $2::uuid
        FOR UPDATE`,
      [id, empresaId]
    );
    const compra = compraRows[0];
    if (!compra) {
      await client.query("ROLLBACK");
      return { borrada: false, stock_revertido: 0, movimientos_borrados: 0, advertencia: null };
    }

    const cantidad = Number(compra.cantidad) || 0;

    // El stock puede quedar en negativo si ya se vendió lo que entró con esta
    // compra. Se permite a propósito: un stock negativo es visible y se corrige,
    // mientras que truncar a cero escondería el faltante.
    await client.query(
      `UPDATE ${tP}
          SET stock_actual = stock_actual - $1::numeric,
              updated_at = now()
        WHERE id = $2::uuid AND empresa_id = $3::uuid`,
      [cantidad, compra.producto_id, empresaId]
    );

    const del = await client.query(
      `DELETE FROM ${tM}
        WHERE empresa_id = $1::uuid
          AND origen = 'compra'
          AND referencia = $2
          AND producto_id = $3::uuid`,
      [empresaId, compra.numero_control, compra.producto_id]
    );

    await client.query(
      `DELETE FROM ${tC} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [id, empresaId]
    );

    await client.query("COMMIT");

    return {
      borrada: true,
      stock_revertido: cantidad,
      movimientos_borrados: del.rowCount ?? 0,
      advertencia:
        "El costo promedio y el precio de venta del producto quedaron como los dejó esta compra: no se guardan los valores anteriores. Revisalos si hace falta.",
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Reporte de compras ────────────────────────────────────────────────────

export interface ReporteComprasFiltro {
  /** "YYYY-MM-DD". Inclusive. */
  desde: string | null;
  /** "YYYY-MM-DD". Inclusive: se compara contra el día completo. */
  hasta: string | null;
  proveedorId: string | null;
}

export interface ReporteCompras {
  resumen: {
    ordenes: number;
    lineas: number;
    total: number;
    gravada: number;
    iva: number;
    contado: number;
    credito: number;
    proveedores: number;
  };
  por_proveedor: Array<{ proveedor_id: string; proveedor: string; ordenes: number; total: number }>;
  por_producto: Array<{ producto: string; cantidad: number; total: number; costo_promedio: number }>;
  por_dia: Array<{ dia: string; total: number; ordenes: number }>;
  detalle: CompraRow[];
}

/**
 * Agregados de compras para el reporte.
 *
 * Las sumas se hacen en la base y no en el cliente: son los mismos datos
 * recorridos cuatro veces con cortes distintos, y traerse todas las compras del
 * año al navegador para sumarlas ahí no escala.
 *
 * El rango es inclusivo en los dos extremos. `hasta` se compara contra el día
 * siguiente porque `fecha` es timestamp: usar `<= hasta` dejaría afuera todo lo
 * cargado después de la medianoche de ese día.
 */
export async function reporteCompras(
  schemaRaw: string,
  empresaId: string,
  f: ReporteComprasFiltro
): Promise<ReporteCompras> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "compras");

  const cond = [`empresa_id = $1::uuid`];
  const vals: unknown[] = [empresaId];
  if (f.desde) { vals.push(f.desde); cond.push(sqlDesdeDiaLocal("fecha", `$${vals.length}`)); }
  if (f.hasta) { vals.push(f.hasta); cond.push(sqlHastaDiaLocal("fecha", `$${vals.length}`)); }
  if (f.proveedorId) { vals.push(f.proveedorId); cond.push(`proveedor_id = $${vals.length}::uuid`); }
  const where = `WHERE ${cond.join(" AND ")}`;

  const p = pool();

  const [resumen, porProveedor, porProducto, porDia, detalle] = await Promise.all([
    p.query<{
      ordenes: string; lineas: string; total: string; gravada: string; iva: string;
      contado: string; credito: string; proveedores: string;
    }>(
      `SELECT COUNT(DISTINCT numero_control)                        AS ordenes,
              COUNT(*)                                              AS lineas,
              COALESCE(SUM(total), 0)                               AS total,
              COALESCE(SUM(subtotal), 0)                            AS gravada,
              COALESCE(SUM(monto_iva), 0)                           AS iva,
              COALESCE(SUM(total) FILTER (WHERE tipo_pago = 'contado'), 0) AS contado,
              COALESCE(SUM(total) FILTER (WHERE tipo_pago = 'credito'), 0) AS credito,
              COUNT(DISTINCT proveedor_id)                          AS proveedores
         FROM ${t} ${where}`,
      vals
    ),
    p.query<{ proveedor_id: string; proveedor: string; ordenes: string; total: string }>(
      `SELECT proveedor_id,
              MAX(proveedor_nombre) AS proveedor,
              COUNT(DISTINCT numero_control) AS ordenes,
              COALESCE(SUM(total), 0)        AS total
         FROM ${t} ${where}
        GROUP BY proveedor_id
        ORDER BY SUM(total) DESC
        LIMIT 50`,
      vals
    ),
    p.query<{ producto: string; cantidad: string; total: string; costo_promedio: string }>(
      `SELECT producto_nombre AS producto,
              COALESCE(SUM(cantidad), 0) AS cantidad,
              COALESCE(SUM(total), 0)    AS total,
              CASE WHEN SUM(cantidad) > 0
                   THEN SUM(total) / SUM(cantidad)
                   ELSE 0 END AS costo_promedio
         FROM ${t} ${where}
        GROUP BY producto_nombre
        ORDER BY SUM(total) DESC
        LIMIT 50`,
      vals
    ),
    p.query<{ dia: string; total: string; ordenes: string }>(
      `SELECT ${sqlDiaLocal("fecha")} AS dia,
              COALESCE(SUM(total), 0)        AS total,
              COUNT(DISTINCT numero_control) AS ordenes
         FROM ${t} ${where}
        GROUP BY 1
        ORDER BY 1`,
      vals
    ),
    p.query<CompraRow>(
      `SELECT ${COLS} FROM ${t} ${where} ORDER BY fecha DESC LIMIT 500`,
      vals
    ),
  ]);

  const n = (v: unknown) => Number(v) || 0;
  const r = resumen.rows[0];

  return {
    resumen: {
      ordenes: n(r?.ordenes),
      lineas: n(r?.lineas),
      total: n(r?.total),
      gravada: n(r?.gravada),
      iva: n(r?.iva),
      contado: n(r?.contado),
      credito: n(r?.credito),
      proveedores: n(r?.proveedores),
    },
    por_proveedor: porProveedor.rows.map((x) => ({
      proveedor_id: x.proveedor_id,
      proveedor: x.proveedor ?? "—",
      ordenes: n(x.ordenes),
      total: n(x.total),
    })),
    por_producto: porProducto.rows.map((x) => ({
      producto: x.producto ?? "—",
      cantidad: n(x.cantidad),
      total: n(x.total),
      costo_promedio: n(x.costo_promedio),
    })),
    por_dia: porDia.rows.map((x) => ({ dia: x.dia, total: n(x.total), ordenes: n(x.ordenes) })),
    detalle: detalle.rows,
  };
}
