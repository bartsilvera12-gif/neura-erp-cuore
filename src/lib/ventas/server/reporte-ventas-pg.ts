/**
 * Agregados de ventas para el reporte, con el corte por modalidad del pedido.
 *
 * La modalidad no vive en `ventas`: el ERP la registra en dos lugares según por
 * dónde entró la venta, y el reporte las unifica acá.
 *
 *   - Mesas / Para llevar → `mesa_sesiones.tipo` ('mesa' | 'para_llevar'), la
 *     sesión apunta a la venta por `venta_id` al facturarse.
 *   - Caja / Nueva venta  → el pedido de cocina que se crea junto con la venta,
 *     en `proyectos.metadata->>'modalidad'` ('local' | 'delivery' | 'carry_out'),
 *     que apunta de vuelta con `metadata->>'venta_id'`.
 *
 * Los dos caminos son excluyentes: `facturarSesionPg` crea la venta con
 * `pedidoCocina: null`, así que una venta de mesa nunca tiene proyecto. Aun así
 * la resolución se hace con subconsultas escalares y no con JOIN, para que un
 * dato duplicado no multiplique los totales.
 *
 * Las sumas se hacen en la base: son los mismos datos recorridos con cortes
 * distintos, y traerse todas las ventas del año al navegador no escala.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { sqlDiaLocal, sqlDesdeDiaLocal, sqlHastaDiaLocal } from "@/lib/fechas/zona-paraguay";
import type { Pool } from "pg";

function pool(): Pool {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool de Postgres no disponible.");
  return p;
}

/** Claves crudas que quedan guardadas en la base. */
export type ModalidadVenta =
  | "mesa"
  | "local"
  | "delivery"
  | "carry_out"
  | "para_llevar"
  | "sin_dato";

/** Agrupación de negocio: dónde termina consumiéndose el pedido. */
export type GrupoModalidad = "local" | "delivery" | "retiro" | "otros";

export const MODALIDAD_LABEL: Record<ModalidadVenta, string> = {
  mesa: "Salón (mesa)",
  local: "En el local (mostrador)",
  delivery: "Delivery",
  carry_out: "Retiro / Carry out",
  para_llevar: "Para llevar (mostrador)",
  sin_dato: "Sin modalidad",
};

export const MODALIDAD_GRUPO: Record<ModalidadVenta, GrupoModalidad> = {
  mesa: "local",
  local: "local",
  delivery: "delivery",
  carry_out: "retiro",
  para_llevar: "retiro",
  sin_dato: "otros",
};

export const GRUPO_LABEL: Record<GrupoModalidad, string> = {
  local: "En el local",
  delivery: "Delivery",
  retiro: "Retiro y para llevar",
  otros: "Sin clasificar",
};

const MODALIDADES: ModalidadVenta[] = [
  "mesa",
  "local",
  "delivery",
  "carry_out",
  "para_llevar",
  "sin_dato",
];

export function esModalidad(v: string): v is ModalidadVenta {
  return (MODALIDADES as string[]).includes(v);
}

export interface ReporteVentasFiltro {
  /** "YYYY-MM-DD". Inclusive. */
  desde: string | null;
  /** "YYYY-MM-DD". Inclusive: se compara contra el día completo. */
  hasta: string | null;
  modalidad: ModalidadVenta | null;
  /** Si es false, las ventas anuladas quedan fuera de todos los agregados. */
  incluirAnuladas: boolean;
}

export interface ReporteVentas {
  resumen: {
    ventas: number;
    total: number;
    gravada: number;
    iva: number;
    ticket_promedio: number;
    anuladas: number;
    total_anulado: number;
  };
  por_modalidad: Array<{
    modalidad: ModalidadVenta;
    grupo: GrupoModalidad;
    ventas: number;
    total: number;
    ticket_promedio: number;
  }>;
  por_metodo_pago: Array<{ metodo: string; ventas: number; total: number }>;
  por_dia: Array<{ dia: string; total: number; ventas: number }>;
  por_producto: Array<{ producto: string; cantidad: number; total: number }>;
  detalle: Array<{
    id: string;
    numero_control: string;
    fecha: string;
    modalidad: ModalidadVenta;
    referencia: string | null;
    metodo_pago: string | null;
    estado: string;
    total: number;
  }>;
}

/**
 * Expresión SQL que resuelve la modalidad de una fila de `ventas` aliaseada
 * como `ve`. Se repite en cada consulta porque cada una arranca de su propio
 * FROM; el costo real es el mismo índice por `venta_id`.
 */
function modalidadExpr(tMesaSesiones: string, tProyectos: string): string {
  return `COALESCE(
    (SELECT ms.tipo
       FROM ${tMesaSesiones} ms
      WHERE ms.empresa_id = ve.empresa_id AND ms.venta_id = ve.id
      LIMIT 1),
    (SELECT pr.metadata->>'modalidad'
       FROM ${tProyectos} pr
      WHERE pr.empresa_id = ve.empresa_id AND pr.metadata->>'venta_id' = ve.id::text
      LIMIT 1),
    'sin_dato'
  )`;
}

/**
 * Etiqueta corta que identifica el pedido en el detalle: número de mesa,
 * número de para llevar o nombre del cliente de delivery. Sale de la misma
 * observación que ya escribe el ERP al facturar, o del brief del pedido.
 */
function referenciaExpr(tMesaSesiones: string, tProyectos: string): string {
  return `COALESCE(
    NULLIF(ve.observaciones, ''),
    (SELECT NULLIF(pr.brief_data->>'cliente_nombre', '')
       FROM ${tProyectos} pr
      WHERE pr.empresa_id = ve.empresa_id AND pr.metadata->>'venta_id' = ve.id::text
      LIMIT 1),
    (SELECT ms.nombre_cliente
       FROM ${tMesaSesiones} ms
      WHERE ms.empresa_id = ve.empresa_id AND ms.venta_id = ve.id
      LIMIT 1)
  )`;
}

export async function reporteVentas(
  schemaRaw: string,
  empresaId: string,
  f: ReporteVentasFiltro
): Promise<ReporteVentas> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tVentas = quoteSchemaTable(schema, "ventas");
  const tItems = quoteSchemaTable(schema, "ventas_items");
  const tSes = quoteSchemaTable(schema, "mesa_sesiones");
  const tProy = quoteSchemaTable(schema, "proyectos");

  const modalidad = modalidadExpr(tSes, tProy);
  const referencia = referenciaExpr(tSes, tProy);

  const cond = [`ve.empresa_id = $1::uuid`];
  const vals: unknown[] = [empresaId];
  if (f.desde) {
    vals.push(f.desde);
    cond.push(sqlDesdeDiaLocal("ve.fecha", `$${vals.length}`));
  }
  if (f.hasta) {
    vals.push(f.hasta);
    cond.push(sqlHastaDiaLocal("ve.fecha", `$${vals.length}`));
  }
  if (!f.incluirAnuladas) cond.push(`ve.estado <> 'anulada'`);
  if (f.modalidad) {
    vals.push(f.modalidad);
    cond.push(`${modalidad} = $${vals.length}`);
  }
  const where = `WHERE ${cond.join(" AND ")}`;

  // El resumen de anuladas se calcula siempre sobre el período completo, sin
  // el filtro de estado: es el dato que explica por qué el total no cierra
  // contra el listado de ventas.
  const condAnul = cond.filter((c) => c !== `ve.estado <> 'anulada'`);
  const whereAnul = `WHERE ${condAnul.join(" AND ")} AND ve.estado = 'anulada'`;

  const p = pool();

  const [resumen, anuladas, porModalidad, porMetodo, porDia, porProducto, detalle] =
    await Promise.all([
      p.query<{ ventas: string; total: string; gravada: string; iva: string }>(
        `SELECT COUNT(*)                       AS ventas,
                COALESCE(SUM(ve.total), 0)     AS total,
                COALESCE(SUM(ve.subtotal), 0)  AS gravada,
                COALESCE(SUM(ve.monto_iva), 0) AS iva
           FROM ${tVentas} ve ${where}`,
        vals
      ),
      p.query<{ ventas: string; total: string }>(
        `SELECT COUNT(*) AS ventas, COALESCE(SUM(ve.total), 0) AS total
           FROM ${tVentas} ve ${whereAnul}`,
        vals
      ),
      p.query<{ modalidad: string; ventas: string; total: string }>(
        `SELECT ${modalidad} AS modalidad,
                COUNT(*) AS ventas,
                COALESCE(SUM(ve.total), 0) AS total
           FROM ${tVentas} ve ${where}
          GROUP BY 1
          ORDER BY SUM(ve.total) DESC`,
        vals
      ),
      p.query<{ metodo: string | null; ventas: string; total: string }>(
        `SELECT ve.metodo_pago AS metodo,
                COUNT(*) AS ventas,
                COALESCE(SUM(ve.total), 0) AS total
           FROM ${tVentas} ve ${where}
          GROUP BY 1
          ORDER BY SUM(ve.total) DESC`,
        vals
      ),
      p.query<{ dia: string; total: string; ventas: string }>(
        `SELECT ${sqlDiaLocal("ve.fecha")} AS dia,
                COALESCE(SUM(ve.total), 0)      AS total,
                COUNT(*)                        AS ventas
           FROM ${tVentas} ve ${where}
          GROUP BY 1
          ORDER BY 1`,
        vals
      ),
      // El nombre a mostrar prioriza el de la mitad y mitad, que es el que
      // reconoce el mozo; si no hay, cae al nombre del producto.
      p.query<{ producto: string; cantidad: string; total: string }>(
        `SELECT COALESCE(NULLIF(vi.item_display_name, ''), vi.producto_nombre) AS producto,
                COALESCE(SUM(vi.cantidad), 0)    AS cantidad,
                COALESCE(SUM(vi.total_linea), 0) AS total
           FROM ${tItems} vi
           JOIN ${tVentas} ve ON ve.id = vi.venta_id AND ve.empresa_id = vi.empresa_id
          ${where}
          GROUP BY 1
          ORDER BY SUM(vi.total_linea) DESC
          LIMIT 50`,
        vals
      ),
      p.query<{
        id: string;
        numero_control: string;
        fecha: string;
        modalidad: string;
        referencia: string | null;
        metodo_pago: string | null;
        estado: string;
        total: string;
      }>(
        `SELECT ve.id, ve.numero_control, ve.fecha, ve.metodo_pago, ve.estado, ve.total,
                ${modalidad}  AS modalidad,
                ${referencia} AS referencia
           FROM ${tVentas} ve ${where}
          ORDER BY ve.fecha DESC
          LIMIT 500`,
        vals
      ),
    ]);

  const n = (v: unknown) => Number(v) || 0;
  const norm = (v: string | null): ModalidadVenta =>
    v && esModalidad(v) ? v : "sin_dato";

  const r = resumen.rows[0];
  const ventas = n(r?.ventas);
  const total = n(r?.total);

  return {
    resumen: {
      ventas,
      total,
      gravada: n(r?.gravada),
      iva: n(r?.iva),
      ticket_promedio: ventas > 0 ? total / ventas : 0,
      anuladas: n(anuladas.rows[0]?.ventas),
      total_anulado: n(anuladas.rows[0]?.total),
    },
    por_modalidad: porModalidad.rows.map((x) => {
      const m = norm(x.modalidad);
      const cant = n(x.ventas);
      const tot = n(x.total);
      return {
        modalidad: m,
        grupo: MODALIDAD_GRUPO[m],
        ventas: cant,
        total: tot,
        ticket_promedio: cant > 0 ? tot / cant : 0,
      };
    }),
    por_metodo_pago: porMetodo.rows.map((x) => ({
      metodo: x.metodo ?? "sin_dato",
      ventas: n(x.ventas),
      total: n(x.total),
    })),
    por_dia: porDia.rows.map((x) => ({ dia: x.dia, total: n(x.total), ventas: n(x.ventas) })),
    por_producto: porProducto.rows.map((x) => ({
      producto: x.producto ?? "—",
      cantidad: n(x.cantidad),
      total: n(x.total),
    })),
    detalle: detalle.rows.map((x) => ({
      id: x.id,
      numero_control: x.numero_control,
      fecha: x.fecha,
      modalidad: norm(x.modalidad),
      referencia: x.referencia,
      metodo_pago: x.metodo_pago,
      estado: x.estado,
      total: n(x.total),
    })),
  };
}
