import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  listCompras,
  insertCompraMultilinea,
  type CompraLineaInput,
} from "@/lib/compras/server/compras-pg";

/**
 * GET /api/compras — lista via PG directo.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const rows = await listCompras(schema, ctx.auth.empresa_id);
    return NextResponse.json(successResponse({ compras: rows }));
  } catch (err) {
    console.error("[/api/compras GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las compras."), { status: 500 });
  }
}

const IVA_VALIDO = ["exenta", "5", "10"];

function num(v: unknown): number {
  return Number(v) || 0;
}

/** Valida y normaliza una línea. Devuelve el error listo para mostrar. */
function leerLinea(raw: Record<string, unknown>, i: number, total: number):
  | { ok: true; linea: CompraLineaInput }
  | { ok: false; error: string } {
  // Con una sola línea el número de fila no aporta y suena raro en el mensaje.
  const donde = total > 1 ? ` (producto ${i + 1})` : "";
  const productoId = String(raw.producto_id ?? "").trim();
  if (!productoId) return { ok: false, error: `Falta el producto${donde}.` };
  if (num(raw.cantidad) <= 0)
    return { ok: false, error: `La cantidad debe ser mayor a 0${donde}.` };
  if (num(raw.costo_unitario) <= 0)
    return { ok: false, error: `El costo unitario debe ser mayor a 0${donde}.` };
  // El precio de venta es opcional: 0 significa "dejarle el que ya tiene".
  if (num(raw.precio_venta) < 0)
    return { ok: false, error: `El precio de venta no puede ser negativo${donde}.` };

  return {
    ok: true,
    linea: {
      producto_id: productoId,
      producto_nombre: String(raw.producto_nombre ?? ""),
      cantidad: num(raw.cantidad),
      costo_unitario_original: num(raw.costo_unitario_original) || num(raw.costo_unitario),
      costo_unitario: num(raw.costo_unitario),
      iva_tipo: IVA_VALIDO.includes(String(raw.iva_tipo)) ? String(raw.iva_tipo) : "10",
      subtotal: num(raw.subtotal),
      monto_iva: num(raw.monto_iva),
      total: num(raw.total),
      precio_venta: num(raw.precio_venta),
      margen_venta: raw.margen_venta != null ? num(raw.margen_venta) : null,
    },
  };
}

/**
 * POST /api/compras — crea la compra, sus movimientos ENTRADA y actualiza los
 * productos.
 *
 * Acepta la factura completa en `items: [...]`. Si no viene, se lee el cuerpo
 * como una única línea: es la forma vieja del endpoint y se mantiene para no
 * romper a quien todavía la use.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const proveedorId = String(body.proveedor_id ?? "").trim();
    if (!proveedorId) return NextResponse.json(errorResponse("Falta el proveedor."), { status: 400 });

    const timbrado = String(body.nro_timbrado ?? "").trim();
    if (!timbrado) return NextResponse.json(errorResponse("Falta el N° de timbrado."), { status: 400 });

    const crudas = Array.isArray(body.items)
      ? (body.items as Record<string, unknown>[])
      : [body];
    if (crudas.length === 0) {
      return NextResponse.json(errorResponse("La compra no tiene productos."), { status: 400 });
    }

    const lineas: CompraLineaInput[] = [];
    for (let i = 0; i < crudas.length; i++) {
      const r = leerLinea(crudas[i], i, crudas.length);
      if (!r.ok) return NextResponse.json(errorResponse(r.error), { status: 400 });
      lineas.push(r.linea);
    }

    // Un mismo producto dos veces en la misma factura dejaría el costo promedio
    // pisado por la segunda línea y el stock sumado dos veces sin que se note.
    const repetido = lineas
      .map((l) => l.producto_id)
      .find((id, i, arr) => arr.indexOf(id) !== i);
    if (repetido) {
      const nombre = lineas.find((l) => l.producto_id === repetido)?.producto_nombre ?? "un producto";
      return NextResponse.json(
        errorResponse(`"${nombre}" está cargado dos veces. Juntá las cantidades en una sola línea.`),
        { status: 400 }
      );
    }

    try {
      const out = await insertCompraMultilinea(
        schema,
        empresaId,
        {
          proveedor_id: proveedorId,
          proveedor_nombre: String(body.proveedor_nombre ?? ""),
          moneda: body.moneda === "USD" ? "USD" : "PYG",
          tipo_cambio: num(body.tipo_cambio) || 1,
          tipo_pago: body.tipo_pago === "credito" ? "credito" : "contado",
          plazo_dias:
            body.plazo_dias != null && String(body.plazo_dias).trim() !== ""
              ? parseInt(String(body.plazo_dias), 10) || null
              : null,
          nro_timbrado: timbrado.toUpperCase(),
          created_by: ctx.auth.usuarioCatalogId ?? null,
          usuario_nombre: ctx.auth.user?.email ?? null,
        },
        lineas
      );

      return NextResponse.json(
        successResponse({
          numero_control: out.numero_control,
          compras: out.compras,
          // La forma vieja devolvía una sola compra; se mantiene para que los
          // llamadores que leen `compra` sigan funcionando.
          compra: out.compras[0],
          warning: out.movimiento_warning,
        })
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const code = (e as { code?: string })?.code;
      const detail = (e as { detail?: string })?.detail;
      console.error("[/api/compras POST]", { schema, empresaId, msg, code, detail });
      if (code === "23503") {
        return NextResponse.json(
          errorResponse("Proveedor o producto inválido. Verificá los datos seleccionados."),
          { status: 400 }
        );
      }
      if (code === "23505") {
        return NextResponse.json(
          errorResponse("Conflicto al generar el número de control. Reintentá."),
          { status: 409 }
        );
      }
      return NextResponse.json(
        errorResponse("No se pudo guardar la compra. Revisá los datos e intentá nuevamente."),
        { status: 500 }
      );
    }
  } catch (err) {
    console.error("[/api/compras POST] outer", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo guardar la compra."), { status: 500 });
  }
}
