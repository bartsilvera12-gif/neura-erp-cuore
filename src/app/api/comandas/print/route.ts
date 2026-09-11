import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getComandaDetallePg } from "@/lib/comandas/server/comandas-pg";
import { documentoComandas } from "@/lib/comandas/server/ticket-comanda";

/**
 * GET /api/comandas/print?ids=a,b,c&w=58|80 — VARIAS comandas en un solo papel.
 *
 * Un pedido con pizza y hamburguesa genera dos comandas, una por sector. Con
 * una sola por documento, cocina tenía que imprimirlas por separado y, en modo
 * automático, dos `window.print()` seguidos se pisaban y alguno se perdía. Acá
 * salen en un único trabajo de impresión, separadas por corte de página.
 *
 * No registra la impresión: eso lo hace POST /imprimir por cada comanda, para
 * que recargar esta vista no infle print_count.
 */
const MAX = 20;

export async function GET(request: NextRequest) {
  const gate = await requireModule(request, "comandas");
  if (!gate.ok) return new NextResponse("No autorizado", { status: gate.status });

  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX);
  if (ids.length === 0) return new NextResponse("Faltan ids", { status: 400 });

  const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
  const detalles = await Promise.all(
    ids.map((id) => getComandaDetallePg(schema, gate.auth.empresa_id, id))
  );
  // Si alguna no existe se imprimen las demás: dejar sin papel a toda la cocina
  // porque una comanda se canceló entre medio es peor que imprimir de menos.
  const comandas = detalles.filter((c): c is NonNullable<typeof c> => c != null);
  if (comandas.length === 0) return new NextResponse("Comandas no encontradas", { status: 404 });

  const widthMm = url.searchParams.get("w") === "58" ? 58 : 80;
  const html = documentoComandas(comandas, widthMm);
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
