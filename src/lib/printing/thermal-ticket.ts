/**
 * Utilitario de tickets térmicos 80mm — Cucina del Cuore (schema cucinaerp).
 *
 * Fuente única para construir comandas / tickets de cocina y caja en formato
 * térmico, preparado para:
 *   - Vista previa imprimible HTML 80/58mm desde el navegador (Chrome).
 *   - Futuro envío directo a impresora ESC/POS autocortante via texto plano + corte.
 *
 * No es un comprobante fiscal: no toca SIFEN, timbrado ni XML.
 *
 * Funciones públicas:
 *   - normalizeComandaData(input)         → normaliza datos crudos de venta/pedido.
 *   - buildComandaTicketHtml(data, opts)  → HTML 80/58mm para imprimir desde el navegador.
 *   - buildComandaTicketText(data, opts)  → texto plano monoespaciado (base ESC/POS).
 *   - buildComandaEscPosPayload(data,opts)→ texto + comandos de corte (abstracción ESC/POS).
 *
 * Conexión con impresora física: ver bloque "ESC/POS" más abajo y el README de impresión.
 */

// ── Tipos ────────────────────────────────────────────────────────────────────

export type TicketSector = "pizzeria" | "plancha" | null;
export type TicketCopia = "cliente" | "pizzeria" | "plancha" | "cocina";
export type TicketModalidad = "local" | "delivery" | "carry_out" | "mostrador" | null;

export interface ComandaItemInput {
  cantidad: number;
  nombre: string;
  precio_unitario?: number | null;
  total_linea?: number | null;
  sector?: TicketSector;
  /** Observaciones puntuales del ítem (ej. "sin cebolla"). */
  observacion?: string | null;
  /** Variantes/elecciones del ítem (ej. ["grande", "extra queso"]). */
  variantes?: string[] | null;
}

export interface ComandaInput {
  negocio?: string;
  /** N° de pedido o venta (numero_control). */
  numero: string;
  fechaIso: string;
  modalidad?: TicketModalidad;
  mesa?: string | null;
  cliente_nombre?: string | null;
  cliente_telefono?: string | null;
  direccion_entrega?: string | null;
  observacion_general?: string | null;
  estado?: string | null;
  metodo_pago?: string | null;
  subtotal?: number | null;
  monto_iva?: number | null;
  total?: number | null;
  /**
   * Costo de delivery informado al cliente. Pass-through: NO forma parte de
   * `total` (la venta real del negocio). Sólo se imprime como línea aparte en
   * la copia cliente de un pedido delivery.
   */
  costo_delivery?: number | null;
  items: ComandaItemInput[];
}

export interface NormalizedComandaItem {
  cantidad: number;
  nombre: string;
  precioUnitario: number;
  totalLinea: number;
  sector: TicketSector;
  observacion: string | null;
  variantes: string[];
}

export interface NormalizedComanda {
  negocio: string;
  numero: string;
  fechaTexto: string;
  modalidadLabel: string;
  mesa: string | null;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  direccionEntrega: string | null;
  observacionGeneral: string | null;
  estado: string | null;
  metodoPagoLabel: string;
  subtotal: number;
  montoIva: number;
  total: number;
  /** Costo de delivery informado al cliente (no está incluido en `total`). */
  costoDelivery: number;
  /** true sólo si es delivery con costo > 0: dispara la línea de delivery. */
  esDelivery: boolean;
  items: NormalizedComandaItem[];
  haySector: { pizzeria: boolean; plancha: boolean };
}

export interface TextOptions {
  copia?: TicketCopia;
  /** Caracteres por línea: 80mm fuente A ≈ 48, 58mm ≈ 32. */
  widthChars?: number;
  /** Mostrar precios/totales (true por defecto en copia cliente). */
  showPrices?: boolean;
  /** En copia de cocina: mostrar sólo el TOTAL (sin precios por ítem). */
  showTotal?: boolean;
}

export interface HtmlOptions {
  copia?: TicketCopia;
  widthMm?: 58 | 80;
  fontPx?: number;
  showPrices?: boolean;
  /** En copia de cocina: mostrar sólo el TOTAL. */
  showTotal?: boolean;
  isLast?: boolean;
}

const NEGOCIO_DEFAULT = "CARIBEÑA";
const PIE = "Preparado desde Neura ERP";

// ── ESC/POS — abstracción de comandos (sin dependencia de marca) ──────────────
//
// Comandos de bytes estándar ESC/POS. NO se ejecutan aquí: se exponen como
// strings para que un agente local / servicio de impresión (QZ Tray, WebUSB,
// node-escpos, etc.) los envíe al dispositivo cuando se defina la impresora.

export const ESC_POS = {
  /** Inicializa la impresora (ESC @). */
  INIT: "\x1B\x40",
  /** Alimenta y corta total (GS V 0). */
  CUT_FULL: "\x1D\x56\x00",
  /** Alimenta y corte parcial (GS V 1) — autocorte típico 80mm. */
  CUT_PARTIAL: "\x1D\x56\x01",
  /** Alimenta n líneas antes de cortar (placeholder, n se concatena aparte). */
  FEED_3: "\n\n\n",
  /** Negrita on/off (ESC E). */
  BOLD_ON: "\x1B\x45\x01",
  BOLD_OFF: "\x1B\x45\x00",
  /** Alineación. */
  ALIGN_LEFT: "\x1B\x61\x00",
  ALIGN_CENTER: "\x1B\x61\x01",
} as const;

/**
 * Comando lógico de corte como abstracción. `partial=true` => corte parcial
 * (autocorte 80mm habitual). Devuelve los bytes ESC/POS; si en el futuro se usa
 * una librería específica, reemplazar sólo esta función.
 */
export function escposCutCommand(partial = true): string {
  return ESC_POS.FEED_3 + (partial ? ESC_POS.CUT_PARTIAL : ESC_POS.CUT_FULL);
}

// ── Helpers de formato ────────────────────────────────────────────────────────

function formatGs(v: number): string {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

function formatFecha(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Paraguay usa UTC-3 fija desde 2024 (abolición del horario de verano).
    // El tzdata del contenedor de Coolify puede estar desactualizado y aplicar
    // UTC-4 en invierno → hardcodeamos el offset para que siempre coincida.
    const shifted = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(shifted.getUTCDate())}/${p(shifted.getUTCMonth() + 1)}/${shifted.getUTCFullYear()} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
  } catch {
    return iso;
  }
}

export function modalidadLabel(m: TicketModalidad | string | null | undefined): string {
  switch (m) {
    case "local": return "Local / Mesa";
    case "delivery": return "Delivery";
    case "carry_out": return "Retiro";
    case "mostrador": return "Mostrador";
    default: return "";
  }
}

function metodoPagoLabel(m: string | null | undefined): string {
  switch (m) {
    case "tarjeta": return "Tarjeta";
    case "transferencia": return "Transferencia";
    case "efectivo": return "Efectivo";
    default: return "—";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── normalizeComandaData ──────────────────────────────────────────────────────

export function normalizeComandaData(input: ComandaInput): NormalizedComanda {
  const items: NormalizedComandaItem[] = (input.items ?? []).map((it) => {
    const cantidad = Number(it.cantidad) || 0;
    const precioUnitario = Number(it.precio_unitario ?? 0) || 0;
    const totalLinea =
      it.total_linea != null ? Number(it.total_linea) || 0 : precioUnitario * cantidad;
    return {
      cantidad,
      nombre: String(it.nombre ?? "").trim(),
      precioUnitario,
      totalLinea,
      sector: it.sector ?? null,
      observacion: it.observacion?.toString().trim() || null,
      variantes: (it.variantes ?? []).map((v) => String(v).trim()).filter(Boolean),
    };
  });

  return {
    negocio: (input.negocio || NEGOCIO_DEFAULT).toUpperCase(),
    numero: String(input.numero ?? "").trim(),
    fechaTexto: formatFecha(input.fechaIso),
    modalidadLabel: modalidadLabel(input.modalidad),
    mesa: input.mesa?.toString().trim() || null,
    clienteNombre: input.cliente_nombre?.toString().trim() || null,
    clienteTelefono: input.cliente_telefono?.toString().trim() || null,
    direccionEntrega: input.direccion_entrega?.toString().trim() || null,
    observacionGeneral: input.observacion_general?.toString().trim() || null,
    estado: input.estado?.toString().trim() || null,
    metodoPagoLabel: metodoPagoLabel(input.metodo_pago),
    subtotal: Number(input.subtotal ?? 0) || 0,
    montoIva: Number(input.monto_iva ?? 0) || 0,
    total: Number(input.total ?? 0) || 0,
    costoDelivery: Math.max(0, Number(input.costo_delivery ?? 0) || 0),
    esDelivery: input.modalidad === "delivery" && (Number(input.costo_delivery ?? 0) || 0) > 0,
    items,
    haySector: {
      pizzeria: items.some((i) => i.sector === "pizzeria"),
      plancha: items.some((i) => i.sector === "plancha"),
    },
  };
}

// ── buildComandaTicketText — texto plano monoespaciado (base ESC/POS) ──────────

function rule(width: number, ch = "-"): string {
  return ch.repeat(width);
}

function center(text: string, width: number): string {
  const t = text.slice(0, width);
  const pad = Math.max(0, Math.floor((width - t.length) / 2));
  return " ".repeat(pad) + t;
}

/** Dos columnas: etiqueta a la izquierda, valor a la derecha, ancho fijo. */
function lr(left: string, right: string, width: number): string {
  const space = Math.max(1, width - left.length - right.length);
  if (left.length + right.length >= width) {
    return (left + " " + right).slice(0, width);
  }
  return left + " ".repeat(space) + right;
}

/**
 * Construye el texto plano de UNA copia de comanda/ticket.
 * Apto para impresión monoespaciada y como base para payload ESC/POS.
 */
export function buildComandaTicketText(
  data: NormalizedComanda,
  opts: TextOptions = {}
): string {
  const width = opts.widthChars ?? 48;
  const copia: TicketCopia = opts.copia ?? "cliente";
  const showPrices = opts.showPrices ?? copia === "cliente";

  const L: string[] = [];
  const sectorBadge =
    copia === "pizzeria" ? "COMANDA PIZZERIA"
    : copia === "plancha" ? "COMANDA PLANCHA"
    : copia === "cocina" ? "COMANDA COCINA"
    : "";

  // Encabezado
  if (sectorBadge) {
    L.push(rule(width, "="));
    L.push(center(sectorBadge, width));
    L.push(rule(width, "="));
  } else {
    L.push(center(data.negocio, width));
    L.push(center("COMANDA / PEDIDO", width));
  }

  // Meta
  L.push(center(`N° ${data.numero}`, width));
  L.push(center(data.fechaTexto, width));
  L.push(rule(width));

  // Datos del pedido
  if (data.modalidadLabel) {
    L.push(lr(data.modalidadLabel, data.mesa ? `Mesa ${data.mesa}` : "", width));
  }
  if (data.clienteNombre) L.push(`Cliente: ${data.clienteNombre}`);
  if (data.clienteTelefono) L.push(`Tel: ${data.clienteTelefono}`);
  if (data.direccionEntrega) L.push(`Dir: ${data.direccionEntrega}`);
  if (data.modalidadLabel || data.clienteNombre) L.push(rule(width));

  // Ítems — para cocina se destaca el propio sector; el resto se atenúa con "·".
  for (const it of data.items) {
    const matchesSector =
      (copia === "pizzeria" && it.sector === "pizzeria") ||
      (copia === "plancha" && it.sector === "plancha");
    const otherSectorEnCocina = (copia === "pizzeria" || copia === "plancha") && !matchesSector;
    const marca = otherSectorEnCocina ? "· " : "";
    const cant = `${it.cantidad}x`;
    if (showPrices) {
      L.push(lr(`${cant} ${it.nombre}`, formatGs(it.totalLinea), width));
      if (it.precioUnitario > 0) {
        L.push(`     ${it.cantidad} x ${formatGs(it.precioUnitario)}`);
      }
    } else {
      L.push(`${marca}${cant} ${it.nombre}`.slice(0, width));
    }
    for (const v of it.variantes) L.push(`     - ${v}`.slice(0, width));
    if (it.observacion) L.push(`     >> ${it.observacion}`.slice(0, width));
  }

  // Totales: copia cliente = bloque completo; cocina = sólo TOTAL si showTotal.
  if (showPrices) {
    L.push(rule(width));
    L.push(lr("Subtotal", formatGs(data.subtotal), width));
    if (data.montoIva > 0) L.push(lr("IVA", formatGs(data.montoIva), width));
    if (data.esDelivery) {
      // Productos = venta real; Delivery aparte; TOTAL = lo que paga el cliente.
      L.push(lr("Productos", formatGs(data.total), width));
      L.push(lr("Delivery", formatGs(data.costoDelivery), width));
      L.push(lr("TOTAL", formatGs(data.total + data.costoDelivery), width));
    } else {
      L.push(lr("TOTAL", formatGs(data.total), width));
    }
    L.push(lr("Pago", data.metodoPagoLabel, width));
  } else if (opts.showTotal) {
    L.push(rule(width));
    L.push(lr("TOTAL", formatGs(data.total), width));
  }

  // Observación general
  if (data.observacionGeneral) {
    L.push(rule(width));
    L.push("Obs:");
    L.push(data.observacionGeneral);
  }

  // Estado
  if (data.estado) {
    L.push(rule(width));
    L.push(lr("Estado", data.estado, width));
  }

  // Pie
  L.push(rule(width));
  if (showPrices) {
    L.push(center("Comprobante interno - no fiscal", width));
  }
  L.push(center(PIE, width));

  return L.join("\n");
}

/**
 * Payload ESC/POS para impresora autocortante: INIT + texto + corte parcial.
 * Pensado para enviar a un agente local / WebUSB / QZ Tray cuando se defina la
 * impresora exacta. Devuelve un string con bytes de control embebidos.
 */
export function buildComandaEscPosPayload(
  data: NormalizedComanda,
  opts: TextOptions & { cut?: boolean } = {}
): string {
  const body = buildComandaTicketText(data, opts);
  const cut = opts.cut ?? true;
  return ESC_POS.INIT + body + (cut ? escposCutCommand(true) : "\n\n\n");
}

// ── buildComandaTicketHtml — vista 80/58mm imprimible desde el navegador ───────
//
// Devuelve sólo el <section> de UNA copia. El documento HTML completo (con
// <style> 80mm y @page) lo arma el caller; ver `wrapTicketDocument`.

export function buildComandaTicketHtml(
  data: NormalizedComanda,
  opts: HtmlOptions = {}
): string {
  const copia: TicketCopia = opts.copia ?? "cliente";
  const showPrices = opts.showPrices ?? copia === "cliente";
  const isLast = opts.isLast ?? true;
  const sectorBadge =
    copia === "pizzeria" ? "COMANDA PIZZERÍA"
    : copia === "plancha" ? "COMANDA PLANCHA"
    : copia === "cocina" ? "COMANDA COCINA"
    : "";

  const itemsHtml = data.items
    .map((it) => {
      const matchesSector =
        (copia === "pizzeria" && it.sector === "pizzeria") ||
        (copia === "plancha" && it.sector === "plancha");
      const cls = matchesSector ? "match" : copia === "cliente" ? "" : "muted";
      const extras = [
        ...it.variantes.map((v) => `<tr class="sub"><td></td><td colspan="2">- ${escapeHtml(v)}</td></tr>`),
        it.observacion ? `<tr class="sub"><td></td><td colspan="2">&gt;&gt; ${escapeHtml(it.observacion)}</td></tr>` : "",
      ].join("");
      if (showPrices) {
        return `<tr class="${cls}">
            <td class="qty"><strong>${it.cantidad}×</strong></td>
            <td class="name">${escapeHtml(it.nombre)}</td>
            <td class="amt">${formatGs(it.totalLinea)}</td>
          </tr>
          ${it.precioUnitario > 0 ? `<tr class="sub"><td></td><td colspan="2">${it.cantidad} × ${formatGs(it.precioUnitario)}</td></tr>` : ""}
          ${extras}`;
      }
      return `<tr class="${cls}">
          <td class="qty"><strong>${it.cantidad}×</strong></td>
          <td class="name" colspan="2"><strong>${escapeHtml(it.nombre)}</strong></td>
        </tr>${extras}`;
    })
    .join("");

  const datosPedido: string[] = [];
  if (data.modalidadLabel) {
    datosPedido.push(
      `<div><strong>${escapeHtml(data.modalidadLabel)}</strong>${data.mesa ? ` · Mesa ${escapeHtml(data.mesa)}` : ""}</div>`
    );
  }
  if (data.clienteNombre) datosPedido.push(`<div>Cliente: ${escapeHtml(data.clienteNombre)}</div>`);
  if (data.clienteTelefono) datosPedido.push(`<div>Tel: ${escapeHtml(data.clienteTelefono)}</div>`);
  if (data.direccionEntrega) datosPedido.push(`<div>Dir: ${escapeHtml(data.direccionEntrega)}</div>`);

  const totalesHtml = showPrices
    ? `<hr>
       <table class="totales"><tbody>
         <tr><td class="lbl">Subtotal</td><td class="val">${formatGs(data.subtotal)}</td></tr>
         ${data.montoIva > 0 ? `<tr><td class="lbl">IVA</td><td class="val">${formatGs(data.montoIva)}</td></tr>` : ""}
         ${data.esDelivery
           ? `<tr><td class="lbl">Productos</td><td class="val">${formatGs(data.total)}</td></tr>
              <tr><td class="lbl">Delivery</td><td class="val">${formatGs(data.costoDelivery)}</td></tr>
              <tr class="total-row"><td class="lbl">TOTAL</td><td class="val">${formatGs(data.total + data.costoDelivery)}</td></tr>`
           : `<tr class="total-row"><td class="lbl">TOTAL</td><td class="val">${formatGs(data.total)}</td></tr>`}
         <tr><td class="lbl">Pago</td><td class="val">${escapeHtml(data.metodoPagoLabel)}</td></tr>
       </tbody></table>`
    : opts.showTotal
    ? `<hr><table class="totales"><tbody>
         <tr class="total-row"><td class="lbl">TOTAL</td><td class="val">${formatGs(data.total)}</td></tr>
       </tbody></table>`
    : "";

  const estadoHtml = data.estado
    ? `<hr><div class="estado">Estado: <strong>${escapeHtml(data.estado)}</strong></div>`
    : "";

  const footerHtml = showPrices
    ? `<hr><div class="footer">Comprobante interno — no válido como factura legal.<br><span class="pie">${PIE}</span></div>`
    : `<div class="footer-cocina">${escapeHtml(data.fechaTexto)}<br><span class="pie">${PIE}</span></div>`;

  return `<section class="paper ${isLast ? "last" : ""}">
    ${sectorBadge ? `<div class="sector-banner">${sectorBadge}</div>` : `<h1>${escapeHtml(data.negocio)}</h1>`}
    <div class="meta">N° ${escapeHtml(data.numero)}<br>${escapeHtml(data.fechaTexto)}</div>
    ${datosPedido.length > 0 ? `<hr><div class="pedido">${datosPedido.join("")}</div>` : ""}
    <hr>
    <table><tbody>${itemsHtml}</tbody></table>
    ${totalesHtml}
    ${data.observacionGeneral ? `<hr><div class="obs"><strong>Obs:</strong> ${escapeHtml(data.observacionGeneral)}</div>` : ""}
    ${estadoHtml}
    ${footerHtml}
  </section>`;
}

/**
 * Envuelve una o más copias en un documento HTML 80/58mm imprimible desde Chrome.
 * CSS print con @page size 80mm auto, margin 0, fuente monoespaciada.
 */
export function wrapTicketDocument(
  seccionesHtml: string,
  opts: { widthMm?: 58 | 80; fontPx?: number; title?: string; autoPrint?: boolean; backHref?: string } = {}
): string {
  const widthMm = opts.widthMm ?? 80;
  const fontPx = opts.fontPx ?? (widthMm === 58 ? 11 : 12);
  const title = opts.title ?? NEGOCIO_DEFAULT;
  const otherWidth = widthMm === 80 ? 58 : 80;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* Térmica: todo negro puro y en negrita para que no salga borroso. */
  body { font-family: ui-monospace, "Courier New", monospace; font-size: ${fontPx}px; color: #000; font-weight: 700; background: #f1f1f1; margin: 0; padding: 20px; }
  .paper { background: #fff; width: ${widthMm}mm; margin: 0 auto 12mm; padding: 6mm 4mm; box-shadow: 0 1px 4px rgba(0,0,0,0.1); page-break-after: always; break-after: page; }
  .paper.last { page-break-after: auto; break-after: auto; margin-bottom: 0; }
  h1 { font-size: ${fontPx + 4}px; text-align: center; margin: 0 0 2mm; letter-spacing: 1px; }
  .sector-banner { font-size: ${fontPx + 6}px; font-weight: 800; text-align: center; padding: 2mm; border: 2px solid #000; margin: 0 0 3mm; letter-spacing: 1px; }
  .meta { font-size: ${fontPx - 1}px; text-align: center; margin: 1mm 0 2mm; }
  hr { border: none; border-top: 1px dashed #000; margin: 2mm 0; }
  .pedido { font-size: ${fontPx}px; margin: 1mm 0 2mm; }
  /* Nota del pedido (ej. "delivery"). Va destacada porque de eso depende que
     cocina avise a tiempo para llamar al repartidor. */
  .nota-pedido { font-size: ${fontPx + 3}px; font-weight: 800; text-transform: uppercase; border: 1.5px solid #000; padding: 1mm 2mm; margin: 1.5mm 0; text-align: center; }
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
  /* Renglón destacado del arqueo (total vendido, efectivo esperado, diferencia). */
  .fuerte td { font-weight: bold; font-size: ${fontPx + 1}px; border-top: 1px solid #000; padding-top: 1mm; }
  /* Firmas del arqueo: el papel se firma al entregar el turno. */
  .firmas { font-size: ${fontPx}px; margin: 4mm 0 2mm; line-height: 2.6; }
  .obs, .estado { font-size: ${fontPx - 1}px; margin: 2mm 0; }
  .footer { font-size: ${fontPx - 1}px; text-align: center; margin-top: 3mm; font-style: italic; color: #000; }
  .footer-cocina { font-size: ${fontPx - 1}px; text-align: center; margin-top: 3mm; font-weight: 800; color: #000; }
  .pie { display: inline-block; margin-top: 1mm; font-size: ${fontPx - 2}px; font-weight: 700; font-style: normal; color: #000; }
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
    <a href="?w=${otherWidth}">Cambiar a ${otherWidth}mm</a>
    ${opts.backHref ? `<a href="${escapeHtml(opts.backHref)}">Volver</a>` : ""}
  </div>
  ${opts.autoPrint ? `<script>try{var u=new URL(location.href);if(u.searchParams.get('auto')==='1'){setTimeout(function(){window.print();},250);}}catch(e){}</script>` : ""}
</body>
</html>`;
}
