import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import {
  estadoClaveDescuentoPg,
  verificarClaveDescuentoPg,
} from "@/lib/ventas/server/descuento-clave-pg";

/**
 * GET /api/ventas/descuento/autorizar
 * ¿Se puede descontar? Devuelve si hay clave cargada y el tope permitido, para
 * que la pantalla no ofrezca un botón que después no va a funcionar.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const estado = await estadoClaveDescuentoPg(schema, gate.auth.empresa_id);
    return NextResponse.json(successResponse(estado));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/**
 * POST /api/ventas/descuento/autorizar
 * Body: { clave }. Responde sólo sí o no.
 *
 * La clave se compara en el servidor y no vuelve nunca al navegador, ni siquiera
 * hasheada: lo único que viaja de vuelta es la autorización.
 *
 * Exige el módulo `ventas`: un mozo no puede autorizar descuentos aunque tenga
 * la clave, porque tampoco puede cobrar.
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });

    const body = (await request.json().catch(() => ({}))) as { clave?: unknown };
    const clave = typeof body.clave === "string" ? body.clave : "";

    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const estado = await estadoClaveDescuentoPg(schema, gate.auth.empresa_id);
    if (!estado.configurada) {
      return NextResponse.json(
        errorResponse("No hay clave de descuentos cargada. Configurala antes de descontar."),
        { status: 409 }
      );
    }

    const ok = await verificarClaveDescuentoPg(schema, gate.auth.empresa_id, clave);
    if (!ok) {
      // 401 y un mensaje corto: no se dice si la clave existe, ni cuánto le
      // faltó. Tampoco se registra el intento con la clave escrita.
      return NextResponse.json(errorResponse("Clave incorrecta."), { status: 401 });
    }

    return NextResponse.json(
      successResponse({ autorizado: true, maxPorcentaje: estado.maxPorcentaje })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
