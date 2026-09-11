import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { registrarMovimientoPg, getCajaAbiertaPg } from "@/lib/caja/server/caja-pg";
import { successResponse, errorResponse } from "@/lib/api/response";
import type { MedioPagoCaja, TipoMovimientoCaja } from "@/lib/caja/types";

const TIPOS: TipoMovimientoCaja[] = ["ingreso", "egreso", "retiro", "ajuste"];
const MEDIOS: MedioPagoCaja[] = ["efectivo", "tarjeta", "transferencia", "otro"];

/** POST /api/caja/movimiento — registra ingreso/egreso/retiro/ajuste en la caja abierta. */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }
    const o = (body ?? {}) as Record<string, unknown>;

    const tipo = o.tipo as TipoMovimientoCaja;
    if (!TIPOS.includes(tipo)) {
      return NextResponse.json(errorResponse("Tipo de movimiento inválido."), { status: 400 });
    }
    const concepto = typeof o.concepto === "string" ? o.concepto.trim() : "";
    if (concepto.length === 0) {
      return NextResponse.json(errorResponse("El concepto es obligatorio."), { status: 400 });
    }
    const monto = Number(o.monto);
    if (!Number.isFinite(monto) || monto === 0) {
      return NextResponse.json(errorResponse("Monto inválido."), { status: 400 });
    }
    const medioPago: MedioPagoCaja = MEDIOS.includes(o.medio_pago as MedioPagoCaja)
      ? (o.medio_pago as MedioPagoCaja)
      : "efectivo";
    const observacion =
      o.observacion == null || o.observacion === "" ? null : String(o.observacion).slice(0, 2000);

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);

    let cajaId = o.caja_id == null || o.caja_id === "" ? null : String(o.caja_id);
    if (!cajaId) {
      const abierta = await getCajaAbiertaPg(schema, auth.empresa_id);
      if (!abierta) {
        return NextResponse.json(
          errorResponse("No hay caja abierta. Abrí la caja antes de registrar movimientos."),
          { status: 409 }
        );
      }
      cajaId = abierta.id;
    }

    const movimiento = await registrarMovimientoPg({
      schema,
      empresaId: auth.empresa_id,
      cajaId,
      tipo,
      concepto,
      monto,
      medioPago,
      observacion,
      usuarioId: auth.usuarioCatalogId ?? null,
    });
    return NextResponse.json(successResponse({ movimiento }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo registrar el movimiento.";
    const status = msg.includes("no encontrada") || msg.includes("cerrada") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
