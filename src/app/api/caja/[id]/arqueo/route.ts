import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getResumenCajaPg } from "@/lib/caja/server/caja-pg";
import { wrapTicketDocument } from "@/lib/printing/thermal-ticket";
import { errorResponse } from "@/lib/api/response";

/**
 * GET /api/caja/[id]/arqueo
 *
 * Arqueo del turno para imprimir en la tickeadora. Es el papel que se firma y
 * se guarda con el dinero: por eso lleva quién abrió y quién cerró, el desglose
 * por forma de pago y la diferencia, y no sólo el total.
 *
 * Query: `w=58|80` ancho del papel, `auto=0` para no lanzar la impresión sola.
 */
function formatGs(v: number): string {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

/** Fecha y hora en horario de Paraguay (UTC-3 fijo; ver zona-paraguay.ts). */
function formatFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const l = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(l.getUTCDate())}/${p(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fila(label: string, valor: string, fuerte = false): string {
  const cls = fuerte ? ' class="fuerte"' : "";
  return `<tr${cls}><td class="lbl">${escapeHtml(label)}</td><td class="val">${escapeHtml(valor)}</td></tr>`;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;

    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const r = await getResumenCajaPg(schema, auth.empresa_id, id);
    if (!r) return NextResponse.json(errorResponse("Caja no encontrada."), { status: 404 });

    const c = r.caja;
    const wParam = request.nextUrl.searchParams.get("w");
    const widthMm: 58 | 80 = wParam === "58" ? 58 : 80;
    const auto = request.nextUrl.searchParams.get("auto") !== "0";

    const cerrada = c.estado !== "abierta";
    const contado = c.monto_cierre_contado ?? 0;
    const esperado = c.monto_esperado_efectivo ?? r.efectivo_esperado;
    const diferencia = c.diferencia ?? contado - esperado;
    const electronico = r.total_transferencia + r.total_tarjeta + r.total_qr;

    // Neto de movimientos manuales, que es lo que explica por qué el efectivo
    // esperado no es simplemente apertura + ventas en efectivo.
    const manual =
      r.ingresos_efectivo - r.egresos_efectivo - r.retiros_efectivo + r.ajustes_efectivo;

    const seccion = `<section class="paper last">
    <h1>ARQUEO DE CAJA</h1>
    <div class="meta">Caja N° ${c.numero_caja} · ${cerrada ? "CERRADA" : "ABIERTA"}</div>
    <hr>
    <div class="pedido">
      <div>Apertura: ${escapeHtml(formatFecha(c.fecha_apertura))}</div>
      <div>Por: ${escapeHtml(r.abierta_por_nombre ?? "—")}</div>
      ${cerrada ? `<div>Cierre: ${escapeHtml(formatFecha(c.fecha_cierre))}</div><div>Por: ${escapeHtml(r.cerrada_por_nombre ?? "—")}</div>` : ""}
    </div>
    <hr>
    <table class="totales"><tbody>
      ${fila("Ventas del turno", String(r.cantidad_ventas))}
      ${fila("Efectivo", formatGs(r.total_efectivo))}
      ${fila("Transferencia", formatGs(r.total_transferencia))}
      ${fila("Tarjeta", formatGs(r.total_tarjeta))}
      ${fila("QR", formatGs(r.total_qr))}
      ${fila("TOTAL VENDIDO", formatGs(r.total_vendido), true)}
    </tbody></table>
    <hr>
    <table class="totales"><tbody>
      ${fila("Monto de apertura", formatGs(c.monto_apertura))}
      ${fila("+ Ventas en efectivo", formatGs(r.total_efectivo))}
      ${r.ingresos_efectivo ? fila("+ Ingresos", formatGs(r.ingresos_efectivo)) : ""}
      ${r.egresos_efectivo ? fila("- Egresos", formatGs(r.egresos_efectivo)) : ""}
      ${r.retiros_efectivo ? fila("- Retiros", formatGs(r.retiros_efectivo)) : ""}
      ${r.ajustes_efectivo ? fila("Ajustes", formatGs(r.ajustes_efectivo)) : ""}
      ${fila("EFECTIVO ESPERADO", formatGs(esperado), true)}
    </tbody></table>
    ${
      cerrada
        ? `<hr>
    <table class="totales"><tbody>
      ${fila("Efectivo contado", formatGs(contado))}
      ${fila(diferencia === 0 ? "SIN DIFERENCIA" : diferencia > 0 ? "SOBRANTE" : "FALTANTE", formatGs(Math.abs(diferencia)), true)}
    </tbody></table>`
        : ""
    }
    <hr>
    <table class="totales"><tbody>
      ${fila("Cobrado por otros medios", formatGs(electronico))}
      ${fila("CIERRE TOTAL DEL TURNO", formatGs(esperado + electronico), true)}
    </tbody></table>
    ${manual !== 0 ? `<div class="pedido">Movimientos manuales: ${escapeHtml(formatGs(manual))}</div>` : ""}
    ${c.observacion_cierre ? `<hr><div class="pedido">Obs: ${escapeHtml(c.observacion_cierre)}</div>` : ""}
    <hr>
    <div class="firmas">
      <div>Entrega: ____________________</div>
      <div>Recibe: _____________________</div>
    </div>
    <div class="footer">Arqueo interno — no es comprobante fiscal</div>
  </section>`;

    const html = wrapTicketDocument(seccion, {
      widthMm,
      title: `Arqueo caja N° ${c.numero_caja}`,
      autoPrint: auto,
    });

    return new NextResponse(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo generar el arqueo.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
