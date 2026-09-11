import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { downloadSifenObject } from "@/lib/sifen/sifen-storage";
import {
  normalizeComandaData,
  buildComandaTicketText,
  buildComandaEscPosPayload,
  type ComandaInput,
  type TicketCopia,
} from "@/lib/printing/thermal-ticket";

/**
 * GET /api/ventas/[id]/ticket?w=58|80&mode=comandas&copia=cliente|pizzeria|plancha|cocina&auto=1
 *
 * HTML imprimible NO FISCAL. Soporta tres modos + salida texto/ESC-POS:
 *
 * - `copia=cliente|pizzeria|plancha|cocina`: UNA sola copia del tipo pedido. Lo usa el
 *   frontend para abrir una pestaña de impresión independiente por sector
 *   (Cliente / Pizzería / Plancha). `cocina` = comanda genérica (sin precios) para
 *   ventas sin sector clasificado (ej. sólo bebidas).
 * - `showTotal=1`: en copias de cocina, muestra el TOTAL (por defecto cocina va sin total).
 * - `format=text` | `format=escpos` (o `escpos=1`): payload de texto plano monoespaciado
 *   (base impresora térmica autocortante). `escpos` añade INIT + corte parcial.
 * - `mode=comandas`: genera múltiples copias en una sola página HTML separadas por
 *   page-break-after, calculadas automáticamente según las categorías/SKUs de los
 *   productos de la venta (se mantiene por compatibilidad):
 *     · Siempre: copia CLIENTE (con precios, total, método de pago, leyenda no fiscal).
 *     · Si hay pizzas/lompizzas: copia COMANDA PIZZERÍA (sin precios).
 *     · Si hay hamburguesas/lomitos/lomitos árabes/panchos/papas/especiales: copia COMANDA PLANCHA.
 * - Default (sin `mode` ni `copia`): una sola copia tipo CLIENTE.
 *
 * No toca SIFEN, no genera XML, no usa timbrado.
 */

const NEGOCIO = "CARIBEÑA";

// ── Clasificación PIZZERÍA / PLANCHA ───────────────────────────────────────
// Primary: categoría hija del producto. Fallback: prefijo de SKU.

const CAT_SLUGS_PIZZERIA = new Set(["pizzas", "lompizzas"]);
const CAT_SLUGS_PLANCHA = new Set([
  "hamburguesas",
  "lomitos",
  "lomitos_arabes",
  "panchos",
  "papas_fritas",
  "especiales",
]);
const CAT_NOMBRES_PIZZERIA = new Set(["PIZZAS", "LOMPIZZAS"]);
const CAT_NOMBRES_PLANCHA = new Set([
  "HAMBURGUESAS",
  "LOMITOS",
  "LOMITOS ARABES",
  "LOMITOS ÁRABES",
  "PANCHOS",
  "PAPAS FRITAS",
  "ESPECIALES",
]);

type Sector = "pizzeria" | "plancha" | null;

function classifyBySku(sku: string): Sector {
  const s = (sku || "").toUpperCase();
  if (s.startsWith("PIZ-")) return "pizzeria";
  if (s.startsWith("ESP-")) return "plancha";
  if (s.startsWith("HAM-") || s.startsWith("LOM-") || s.startsWith("PAN-") || s.startsWith("PAP-")) return "plancha";
  return null;
}

function classifyByCategoria(slug: string | null, nombre: string | null): Sector {
  const sl = (slug || "").toLowerCase();
  const nm = (nombre || "").toUpperCase();
  if (sl && CAT_SLUGS_PIZZERIA.has(sl)) return "pizzeria";
  if (sl && CAT_SLUGS_PLANCHA.has(sl)) return "plancha";
  if (nm && CAT_NOMBRES_PIZZERIA.has(nm)) return "pizzeria";
  if (nm && CAT_NOMBRES_PLANCHA.has(nm)) return "plancha";
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatGs(v: number): string {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

function formatFecha(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Paraguay usa UTC-3 fija desde 2024 (abolición del horario de verano).
    // Server corre en UTC — hardcodeamos el offset para que la hora coincida
    // con la del sistema (el tzdata del contenedor puede estar desactualizado).
    const shifted = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(shifted.getUTCDate())}/${p(shifted.getUTCMonth() + 1)}/${shifted.getUTCFullYear()} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
  } catch {
    return iso;
  }
}

function modalidadLabel(m: string | null | undefined): string {
  if (m === "local") return "Local";
  if (m === "delivery") return "Delivery";
  if (m === "carry_out") return "Retiro";
  return "";
}

function metodoPagoLabel(m: string | null | undefined): string {
  if (m === "tarjeta") return "Tarjeta";
  if (m === "transferencia") return "Transferencia";
  if (m === "efectivo") return "Efectivo";
  return "—";
}

// ── Types ──────────────────────────────────────────────────────────────────

interface VentaRow {
  id: string;
  numero_control: string;
  fecha: string;
  subtotal: number | string;
  monto_iva: number | string;
  total: number | string;
  observaciones: string | null;
  metodo_pago: string | null;
}

interface ItemRow {
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad: number | string;
  precio_venta: number | string;
  total_linea: number | string;
  es_mitad_mitad?: boolean;
  mitad_1_nombre?: string | null;
  mitad_2_nombre?: string | null;
}

type EnrichedItem = ItemRow & { sector: Sector };

interface PedidoBrief {
  modalidad?: "local" | "delivery" | "carry_out";
  mesa?: string | null;
  cliente_nombre?: string | null;
  cliente_telefono?: string | null;
  direccion_entrega?: string | null;
  observacion?: string | null;
  /** Costo de delivery informado al cliente (pass-through, no es venta.total). */
  costo_delivery?: number | null;
}

// ── Render de cada copia ───────────────────────────────────────────────────

function renderCopia(opts: {
  tipo: "cliente" | "pizzeria" | "plancha" | "cocina";
  venta: VentaRow;
  items: EnrichedItem[];
  brief: PedidoBrief | null;
  fontPx: number;
  isLast: boolean;
  showTotalCocina?: boolean;
  /** Logo del local en data URI. Null cuando no hay ninguno configurado. */
  logoUrl?: string | null;
}): string {
  const { tipo, venta, items, brief, fontPx, isLast } = opts;
  // Cliente y COPIA PIZZERÍA llevan precios (la pizzería es copia completa, "igualita").
  // Plancha y cocina son comandas de producción sin precios.
  const showPrices = tipo === "cliente" || tipo === "pizzeria";
  const showTotalCocina = opts.showTotalCocina === true && !showPrices;
  const sectorBadge =
    tipo === "pizzeria" ? "COPIA PIZZERÍA"
    : tipo === "plancha" ? "COMANDA PLANCHA"
    : tipo === "cocina" ? "COMANDA COCINA"
    : "";
  const modalidad = modalidadLabel(brief?.modalidad);

  // Qué ítems entran en esta copia:
  //  · plancha → SOLO los ítems de plancha (sin bebidas ni pizzería).
  //  · cliente / pizzería / cocina → el pedido COMPLETO.
  const itemsCopia = tipo === "plancha" ? items.filter((it) => it.sector === "plancha") : items;

  const itemsHtml = itemsCopia
    .map((it) => {
      const cant = Number(it.cantidad);
      const punit = Number(it.precio_venta);
      const sub = Number(it.total_linea);
      const mitad = it.es_mitad_mitad && it.mitad_1_nombre && it.mitad_2_nombre
        ? `<tr class="sub"><td></td><td colspan="2">½ ${escapeHtml(it.mitad_1_nombre)} + ½ ${escapeHtml(it.mitad_2_nombre)}</td></tr>` : "";
      const main = showPrices
        ? `<tr>
             <td class="qty"><strong>${cant}×</strong></td>
             <td class="name">${escapeHtml(it.producto_nombre)}</td>
             <td class="amt">${formatGs(sub)}</td>
           </tr>
           <tr class="sub"><td></td><td colspan="2">${cant} × ${formatGs(punit)}</td></tr>${mitad}`
        : `<tr>
             <td class="qty"><strong>${cant}×</strong></td>
             <td class="name" colspan="2"><strong>${escapeHtml(it.producto_nombre)}</strong></td>
           </tr>${mitad}`;
      return main;
    })
    .join("");

  const subtotal = Number(venta.subtotal);
  const ivaTotal = Number(venta.monto_iva);
  const total = Number(venta.total);
  // Delivery: sólo informativo. `total` (venta.total) sigue siendo la venta real
  // del negocio; al cliente se le muestra Productos + Delivery = TOTAL a cobrar.
  const costoDelivery = Number(brief?.costo_delivery) || 0;
  const esDelivery = brief?.modalidad === "delivery" && costoDelivery > 0;

  const datosPedido: string[] = [];
  if (modalidad) {
    datosPedido.push(
      `<div><strong>${modalidad}</strong>${brief?.mesa ? ` · Mesa ${escapeHtml(brief.mesa)}` : ""}</div>`
    );
  }
  if (brief?.cliente_nombre) datosPedido.push(`<div>Cliente: ${escapeHtml(brief.cliente_nombre)}</div>`);
  if (brief?.cliente_telefono) datosPedido.push(`<div>Tel: ${escapeHtml(brief.cliente_telefono)}</div>`);
  if (brief?.direccion_entrega) datosPedido.push(`<div>Dir: ${escapeHtml(brief.direccion_entrega)}</div>`);
  const obs = brief?.observacion || venta.observaciones || "";

  const headerCocina = sectorBadge
    ? `<div class="sector-banner">${sectorBadge}</div>`
    : "";
  const totalesHtml = showPrices
    ? `<hr>
       <table class="totales">
         <tbody>
           <tr><td class="lbl">Subtotal</td><td class="val">${formatGs(subtotal)}</td></tr>
           ${ivaTotal > 0 ? `<tr><td class="lbl">IVA</td><td class="val">${formatGs(ivaTotal)}</td></tr>` : ""}
           ${esDelivery
             ? `<tr><td class="lbl">Productos</td><td class="val">${formatGs(total)}</td></tr>
                <tr><td class="lbl">Delivery</td><td class="val">${formatGs(costoDelivery)}</td></tr>
                <tr class="total-row"><td class="lbl">TOTAL</td><td class="val">${formatGs(total + costoDelivery)}</td></tr>`
             : `<tr class="total-row"><td class="lbl">TOTAL</td><td class="val">${formatGs(total)}</td></tr>`}
           <tr><td class="lbl">Pago</td><td class="val">${metodoPagoLabel(venta.metodo_pago)}</td></tr>
         </tbody>
       </table>`
    : showTotalCocina
    ? `<hr>
       <table class="totales">
         <tbody>
           <tr class="total-row"><td class="lbl">TOTAL</td><td class="val">${formatGs(total)}</td></tr>
         </tbody>
       </table>`
    : "";
  const footerHtml = showPrices
    ? `<hr>
       <div class="footer">
         ¡Gracias por tu compra!<br>
         Comprobante interno — no válido como factura legal.
       </div>`
    : `<div class="footer-cocina">${formatFecha(venta.fecha)}</div>`;

  return `<section class="paper ${isLast ? "last" : ""}">
    ${headerCocina || (opts.logoUrl ? `<div class="logo"><img src="${opts.logoUrl}" alt="${NEGOCIO}"></div>` : `<h1>${NEGOCIO}</h1>`)}
    <div class="meta">
      ${escapeHtml(venta.numero_control)}<br>
      ${formatFecha(venta.fecha)}
    </div>
    ${datosPedido.length > 0 ? `<hr><div class="pedido">${datosPedido.join("")}</div>` : ""}
    <hr>
    <table>
      <tbody>${itemsHtml}</tbody>
    </table>
    ${totalesHtml}
    ${obs ? `<hr><div class="obs"><strong>Obs:</strong> ${escapeHtml(obs)}</div>` : ""}
    ${footerHtml}
  </section>`;
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  const { id } = await ctxParams.params;
  const url = new URL(request.url);
  const wParam = url.searchParams.get("w");
  const widthMm = wParam === "58" ? 58 : 80;
  const fontPx = widthMm === 58 ? 11 : 12;
  const modeComandas = url.searchParams.get("mode") === "comandas";
  const copiaParam = url.searchParams.get("copia");
  const copiaUnica: "cliente" | "pizzeria" | "plancha" | "cocina" | null =
    copiaParam === "cliente" || copiaParam === "pizzeria" || copiaParam === "plancha" || copiaParam === "cocina"
      ? copiaParam
      : null;
  // showTotal=1 → la copia de cocina muestra el TOTAL (por defecto sin precios ni total).
  const showTotalCocina = url.searchParams.get("showTotal") === "1";
  // format=text|escpos → payload plano monoespaciado (base ESC/POS). escpos añade INIT+corte.
  const format = url.searchParams.get("format");
  const wantsText = format === "text" || format === "escpos";
  const wantsEscpos = format === "escpos" || url.searchParams.get("escpos") === "1";

  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return new NextResponse("No autorizado", { status: 401 });
  const empresaId = ctx.auth.empresa_id;

  // Venta
  const vQ = await ctx.supabase
    .from("ventas")
    .select("id, numero_control, fecha, subtotal, monto_iva, total, observaciones, metodo_pago")
    .eq("id", id)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (vQ.error) return new NextResponse(`Error: ${vQ.error.message}`, { status: 500 });
  if (!vQ.data) return new NextResponse("Venta no encontrada", { status: 404 });
  const venta = vQ.data as unknown as VentaRow;

  // Items
  const iQ = await ctx.supabase
    .from("ventas_items")
    .select("producto_id, producto_nombre, sku, cantidad, precio_venta, total_linea, es_mitad_mitad, mitad_1_nombre, mitad_2_nombre")
    .eq("venta_id", id)
    .eq("empresa_id", empresaId);
  if (iQ.error) return new NextResponse(`Error items: ${iQ.error.message}`, { status: 500 });
  const itemsRaw = (iQ.data ?? []) as unknown as ItemRow[];

  // Pedido cocina (opcional) — busca card de Pedidos vinculada a esta venta.
  let brief: PedidoBrief | null = null;
  try {
    const pQ = await ctx.supabase
      .from("proyectos")
      .select("brief_data")
      .eq("empresa_id", empresaId)
      .filter("metadata->>venta_id", "eq", id)
      .limit(1)
      .maybeSingle();
    if (!pQ.error && pQ.data) {
      brief = (pQ.data as { brief_data: PedidoBrief }).brief_data ?? null;
    }
  } catch {
    brief = null;
  }

  // Clasificación por categoría (primary) + SKU (fallback)
  const productoIds = [...new Set(itemsRaw.map((i) => i.producto_id))];
  const sectorByProd = new Map<string, Sector>();
  if (productoIds.length > 0) {
    try {
      // producto_categorias[principal] -> categorias_productos(slug, nombre)
      const pcQ = await ctx.supabase
        .from("producto_categorias")
        .select("producto_id, categoria_id, es_principal")
        .eq("empresa_id", empresaId)
        .in("producto_id", productoIds);
      const pcRows = (pcQ.data ?? []) as Array<{
        producto_id: string;
        categoria_id: string;
        es_principal: boolean | null;
      }>;
      const catIds = [...new Set(pcRows.map((r) => r.categoria_id))];
      const catMap = new Map<string, { slug: string | null; nombre: string | null }>();
      if (catIds.length > 0) {
        const cQ = await ctx.supabase
          .from("categorias_productos")
          .select("id, slug, nombre")
          .eq("empresa_id", empresaId)
          .in("id", catIds);
        for (const c of (cQ.data ?? []) as Array<{ id: string; slug: string | null; nombre: string | null }>) {
          catMap.set(c.id, { slug: c.slug ?? null, nombre: c.nombre ?? null });
        }
      }
      // Priorizamos la categoría es_principal=true; si no, la primera que matchee.
      for (const pid of productoIds) {
        const myCats = pcRows.filter((r) => r.producto_id === pid);
        const order = [...myCats].sort((a, b) => (a.es_principal ? -1 : 1) - (b.es_principal ? -1 : 1));
        let s: Sector = null;
        for (const r of order) {
          const meta = catMap.get(r.categoria_id);
          s = classifyByCategoria(meta?.slug ?? null, meta?.nombre ?? null);
          if (s) break;
        }
        sectorByProd.set(pid, s);
      }
    } catch {
      // ignoramos errores de categorías; cae al fallback por SKU.
    }
  }

  // Sector PRIMARIO: productos.sector_produccion (configurable desde la UI).
  // Fallback: categoría (sectorByProd) y luego SKU. Así un producto reconfigurado
  // manualmente manda sobre la convención de categoría/SKU.
  const sectorProdMap = new Map<string, Sector>();
  if (productoIds.length > 0) {
    try {
      const spQ = await ctx.supabase
        .from("productos")
        .select("id, sector_produccion")
        .eq("empresa_id", empresaId)
        .in("id", productoIds);
      for (const r of (spQ.data ?? []) as Array<{ id: string; sector_produccion: string | null }>) {
        const s = r.sector_produccion;
        sectorProdMap.set(r.id, s === "pizzeria" || s === "plancha" ? s : null);
      }
    } catch { /* fallback a categoría/SKU */ }
  }

  const items: EnrichedItem[] = itemsRaw.map((it) => {
    const fromConfig = sectorProdMap.get(it.producto_id) ?? null;
    const fromCat = sectorByProd.get(it.producto_id) ?? null;
    const sector: Sector = fromConfig ?? fromCat ?? classifyBySku(it.sku);
    return { ...it, sector };
  });

  // Decidir qué copias imprimir
  const hayPizzeria = items.some((i) => i.sector === "pizzeria");
  const hayPlancha = items.some((i) => i.sector === "plancha");

  let copias: Array<"cliente" | "pizzeria" | "plancha" | "cocina">;
  if (copiaUnica) {
    // Una sola copia pedida explícitamente (una pestaña por sector).
    copias = [copiaUnica];
  } else if (modeComandas) {
    copias = ["cliente"];
    if (hayPizzeria) copias.push("pizzeria");
    if (hayPlancha) copias.push("plancha");
  } else {
    copias = ["cliente"];
  }

  // ── Salida texto plano / ESC-POS (preparación impresora térmica autocortante) ──
  if (wantsText) {
    const comandaInput: ComandaInput = {
      negocio: NEGOCIO,
      numero: venta.numero_control,
      fechaIso: venta.fecha,
      modalidad: brief?.modalidad ?? null,
      mesa: brief?.mesa ?? null,
      cliente_nombre: brief?.cliente_nombre ?? null,
      cliente_telefono: brief?.cliente_telefono ?? null,
      direccion_entrega: brief?.direccion_entrega ?? null,
      observacion_general: brief?.observacion ?? venta.observaciones ?? null,
      estado: null,
      metodo_pago: venta.metodo_pago,
      subtotal: Number(venta.subtotal),
      monto_iva: Number(venta.monto_iva),
      total: Number(venta.total),
      costo_delivery: Number(brief?.costo_delivery) || 0,
      items: items.map((it) => ({
        cantidad: Number(it.cantidad),
        nombre: it.producto_nombre,
        precio_unitario: Number(it.precio_venta),
        total_linea: Number(it.total_linea),
        sector: it.sector,
      })),
    };
    const normalized = normalizeComandaData(comandaInput);
    const widthChars = widthMm === 58 ? 32 : 48;
    const builder = wantsEscpos ? buildComandaEscPosPayload : buildComandaTicketText;
    const payload = (copias as TicketCopia[])
      .map((copia) => builder(normalized, { copia, widthChars, showTotal: showTotalCocina }))
      .join(wantsEscpos ? "" : `\n${"-".repeat(widthChars)}\n\n`);
    return new NextResponse(payload, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // Logo del local, el mismo que ya usa el KUDE. Si no hay o falla la descarga,
  // el ticket sale con el nombre en texto como toda la vida: el comprobante no
  // puede depender de una imagen.
  let logoUrl: string | null = null;
  try {
    const { data: cfgLogo } = await ctx.supabase
      .from("empresa_sifen_config")
      .select("kude_logo_path")
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const path = String((cfgLogo as { kude_logo_path?: string | null } | null)?.kude_logo_path ?? "").trim();
    if (path) {
      const dl = await downloadSifenObject(ctx.supabase, path);
      if (dl.ok) logoUrl = `data:image/png;base64,${dl.data.toString("base64")}`;
    }
  } catch {
    /* sin logo: el encabezado cae al nombre en texto */
  }

  const seccionesHtml = copias
    .map((tipo, idx) =>
      renderCopia({
        tipo,
        venta,
        items,
        brief,
        fontPx,
        isLast: idx === copias.length - 1,
        showTotalCocina,
        logoUrl,
      })
    )
    .join("");

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Ticket ${escapeHtml(venta.numero_control)} — ${NEGOCIO}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* Térmica: todo negro puro y en negrita para que no salga borroso. */
  body { font-family: ui-monospace, "Courier New", monospace; font-size: ${fontPx}px; color: #000; font-weight: 700; background: #f1f1f1; margin: 0; padding: 20px; }
  .paper { background: #fff; width: ${widthMm}mm; margin: 0 auto 12mm; padding: 6mm 4mm; box-shadow: 0 1px 4px rgba(0,0,0,0.1); page-break-after: always; break-after: page; }
  .paper.last { page-break-after: auto; break-after: auto; margin-bottom: 0; }
  h1 { font-size: ${fontPx + 4}px; text-align: center; margin: 0 0 2mm; letter-spacing: 1px; }
  /* El logo reemplaza al nombre en texto. Se limita en alto para no comerse
     el papel: en una tickeadora cada milímetro es plata. */
  .logo { text-align: center; margin: 0 0 2mm; }
  .logo img { max-width: ${widthMm === 58 ? 44 : 58}mm; max-height: ${widthMm === 58 ? 18 : 24}mm; object-fit: contain; }
  .sector-banner { font-size: ${fontPx + 6}px; font-weight: 800; text-align: center; padding: 2mm; border: 2px solid #000; margin: 0 0 3mm; letter-spacing: 1px; }
  .meta { font-size: ${fontPx - 1}px; text-align: center; margin: 1mm 0 2mm; }
  hr { border: none; border-top: 1px dashed #000; margin: 2mm 0; }
  .pedido { font-size: ${fontPx}px; margin: 1mm 0 2mm; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 0.5mm 0; }
  td.qty { width: 9mm; }
  td.amt { width: 22mm; text-align: right; white-space: nowrap; }
  tr.sub td { color: #000; font-size: ${fontPx - 1}px; font-weight: 700; padding-bottom: 1mm; }
  tr.muted td { color: #000; font-style: italic; }
  tr.match td { background: #fffbcc; }
  .totales td { padding: 0.7mm 0; }
  .totales .lbl { text-align: left; }
  .totales .val { text-align: right; white-space: nowrap; }
  .total-row { font-weight: bold; font-size: ${fontPx + 2}px; border-top: 1px solid #000; }
  .obs { font-size: ${fontPx - 1}px; margin: 2mm 0; }
  .footer { font-size: ${fontPx - 1}px; text-align: center; margin-top: 3mm; font-style: italic; color: #000; }
  .footer-cocina { font-size: ${fontPx - 1}px; text-align: center; margin-top: 3mm; font-weight: 800; color: #000; }
  .actions { max-width: ${widthMm}mm; margin: 8mm auto 0; text-align: center; }
  .actions button { padding: 8px 16px; font-size: 13px; cursor: pointer; border: 1px solid #333; background: #fff; border-radius: 6px; }
  .actions button:hover { background: #f5f5f5; }
  .actions a { margin-left: 12px; font-size: 13px; color: #444; }
  @media print {
    body { background: #fff; padding: 0; color: #000; font-weight: 700; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .paper { width: ${widthMm}mm; box-shadow: none; padding: 2mm; margin: 0; }
    .actions { display: none; }
    @page { margin: 0; size: ${widthMm}mm auto; }
  }
</style>
</head>
<body>
  ${seccionesHtml}
  <div class="actions">
    <button type="button" onclick="window.print()">Imprimir</button>
    <a href="?${copiaUnica ? `copia=${copiaUnica}&` : modeComandas ? "mode=comandas&" : ""}w=${widthMm === 80 ? 58 : 80}">Cambiar a ${widthMm === 80 ? 58 : 80}mm</a>
  </div>
  <script>
    try {
      var u = new URL(location.href);
      if (u.searchParams.get('auto') === '1') {
        setTimeout(function(){ window.print(); }, 250);
      }
    } catch (e) {}
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
