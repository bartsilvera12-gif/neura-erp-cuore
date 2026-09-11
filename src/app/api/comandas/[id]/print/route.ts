import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getComandaDetallePg } from "@/lib/comandas/server/comandas-pg";
import { documentoComandas } from "@/lib/comandas/server/ticket-comanda";

/**
 * GET /api/comandas/[id]/print?w=58|80 — ticket de cocina imprimible (HTML).
 *
 * Usa el MISMO layout térmico base que el ticket de Caja (wrapTicketDocument):
 * 80mm por defecto, ?w=58 soportado, mismas tipografías/márgenes/clases. Imprime
 * SOLO los ítems de ESTA comanda (comanda_id), SIN precios ni total. NO registra
 * la impresión (eso lo hace el botón vía POST /imprimir|/reimprimir): recargar
 * esta vista no infla print_count.
 *
 * Para varias comandas en un solo papel: /api/comandas/print?ids=a,b,c
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireModule(request, "comandas");
  if (!gate.ok) return new NextResponse("No autorizado", { status: gate.status });
  const { id } = await ctx.params;
  const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
  const c = await getComandaDetallePg(schema, gate.auth.empresa_id, id);
  if (!c) return new NextResponse("Comanda no encontrada", { status: 404 });

  const widthMm = new URL(request.url).searchParams.get("w") === "58" ? 58 : 80;
  const html = documentoComandas([c], widthMm);
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
