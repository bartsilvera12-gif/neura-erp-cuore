import { wrapTicketDocument } from "@/lib/printing/thermal-ticket";
import { etiquetaPorciones, porcionesDeNombre, saborCorto } from "@/lib/ventas/pizza-porciones";
import type { ComandaCard } from "@/lib/comandas/types";

/**
 * Armado del ticket de cocina, compartido por la impresión de una comanda y la
 * de varias en un solo papel.
 *
 * Vive acá y no dentro de la ruta porque un pedido genera una comanda por
 * sector: cuando salían de a una, la cocina tenía que imprimir por separado
 * cada sector del mismo pedido, y dos `window.print()` seguidos en el mismo
 * navegador se pisan y alguno se pierde.
 */

export const NEGOCIO = "CUCINA DEL COURE";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function formatGs(v: number): string {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

export function formatFecha(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Paraguay usa UTC-3 fija desde 2024 (abolición del horario de verano).
    // El tzdata del contenedor de Coolify puede estar desactualizado y aplicar
    // UTC-4 en invierno → hardcodeamos el offset para que siempre coincida.
    const shifted = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(shifted.getUTCDate())}/${p(shifted.getUTCMonth() + 1)}/${shifted.getUTCFullYear()} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
  } catch { return iso; }
}

/**
 * Detecta si el pedido es delivery a partir de la nota libre de la sesión.
 * La nota es texto libre que el mozo escribe al abrir el pedido para llevar:
 * si contiene la palabra "delivery", asumimos que hay que llevarlo a domicilio.
 */
function esDelivery(c: ComandaCard): boolean {
  const nota = (c.sesion_observacion ?? "").toLowerCase();
  return /\bdelivery\b/.test(nota);
}

/**
 * Extrae la dirección de entrega de la nota. La convención es que el mozo
 * escribe algo como "delivery: Avda. España 742" o "delivery a Avda. España
 * 742"; también aceptamos que la dirección venga en una segunda línea. Si no
 * podemos identificar una dirección, devolvemos la nota tal cual (sin la
 * palabra "delivery") para no perder información.
 */
function direccionEntrega(c: ComandaCard): string {
  const raw = (c.sesion_observacion ?? "").trim();
  if (!raw) return "";
  // Quitar prefijos comunes: "delivery:", "delivery a", "delivery -", …
  const sin = raw.replace(/^\s*delivery\s*[:\-–—]?\s*(a\s+)?/i, "").trim();
  return sin || raw;
}

/**
 * Una comanda, como sección de papel térmico.
 *
 * Layout minimal Cucina del Cuore: NEGOCIO grande, título del sector
 * ("COMANDA - HORNO" o "COMANDA - DELIVERY"), lista de ítems con la
 * personalización debajo (mitad-y-mitad, ingredientes agregados/quitados,
 * observación libre), y — sólo si es delivery — la dirección de entrega.
 *
 * `ultima` marca la que no lleva corte después: en un papel continuo, cortar
 * detrás de la última tira un pedazo en blanco cada vez.
 */
export function seccionComanda(c: ComandaCard, ultima: boolean): { section: string; title: string } {
  const esAviso = c.tipo === "modificacion" || c.tipo === "cancelacion";
  const delivery = !esAviso && esDelivery(c);

  const bannerTexto = esAviso
    ? (c.tipo === "cancelacion" ? "*** CANCELACIÓN ***" : "*** MODIFICACIÓN ***")
    : delivery
      ? "COMANDA - DELIVERY"
      : "COMANDA - HORNO";

  // Aviso (modificación/cancelación): igual que antes, sólo cambia el encabezado.
  const avisoHtml = (c.aviso ?? [])
    .map((l) => {
      const ahora = l.ahora
        ? `<tr><td class="qty"></td><td class="name" colspan="2"><strong>AHORA: ${escapeHtml(l.ahora)}</strong></td></tr>`
        : "";
      const obs = l.observacion
        ? `<tr class="sub"><td></td><td colspan="2">&gt;&gt; ${escapeHtml(l.observacion)}</td></tr>`
        : "";
      const etiquetaAntes = c.tipo === "cancelacion" ? "SE CANCELA" : "ANTES";
      return `
        <tr><td class="qty"></td><td class="name" colspan="2"><strong>${etiquetaAntes}: ${escapeHtml(l.antes)}</strong></td></tr>${ahora}${obs}
        <tr class="sub"><td colspan="3">&nbsp;</td></tr>`;
    })
    .join("");

  const vigentes = c.items.filter((it) => !it.cancelado);
  const itemsHtml = esAviso ? avisoHtml : vigentes
    .map((it) => {
      const esMitad = it.es_mitad_mitad && it.mitad_1_nombre && it.mitad_2_nombre;

      // En una mitad y mitad la medida no está en el nombre del ítem ("Pizza
      // mitad y mitad") sino en el de cada sabor; la leemos de ahí para que
      // aparezca en el nombre principal.
      const nombre = esMitad && porcionesDeNombre(it.producto_nombre) == null
        ? `${it.producto_nombre} ${etiquetaPorciones(porcionesDeNombre(it.mitad_1_nombre))}`.trim()
        : it.producto_nombre;

      // Sub-líneas de personalización, en el orden pensado para cocina:
      //   1º "Mitad X / Mitad Y" (define el disco y el reparto de sabores).
      //   2º "Sin …" (lo que hay que NO poner).
      //   3º "Agregar …" (lo que va adicional).
      //   4º observación libre.
      const subs: string[] = [];
      if (esMitad) {
        subs.push(`Mitad ${escapeHtml(saborCorto(it.mitad_1_nombre))} / Mitad ${escapeHtml(saborCorto(it.mitad_2_nombre))}`);
      }
      const quitar = (it.ingredientes_quitar ?? []).filter((x) => x && x.trim().length > 0);
      if (quitar.length) subs.push(`Sin ${quitar.map((x) => escapeHtml(x)).join(", ")}`);
      const agregar = (it.ingredientes_agregar ?? []).filter((x) => x && x.trim().length > 0);
      if (agregar.length) subs.push(`Agregar ${agregar.map((x) => escapeHtml(x)).join(", ")}`);
      if (it.observacion) subs.push(escapeHtml(it.observacion));

      const subsHtml = subs
        .map((s) => `<tr class="sub"><td></td><td colspan="2">${s}</td></tr>`)
        .join("");

      return `
        <tr><td class="qty"><strong>${it.cantidad}</strong></td><td class="name" colspan="2"><strong>${escapeHtml(nombre)}</strong></td></tr>${subsHtml}`;
    })
    .join("");

  // Dirección al pie sólo en delivery. Va sobre su propio bloque, sin cliente
  // ni teléfono: el mockup pide el mínimo indispensable para que cocina sepa
  // adónde va.
  const dir = delivery ? direccionEntrega(c) : "";
  const dirHtml = dir
    ? `<div class="pedido"><div>Dirección de entrega:</div><div><strong>${escapeHtml(dir)}</strong></div></div>`
    : "";

  const section = `<section class="paper${ultima ? " last" : ""}">
    <h1>${NEGOCIO}</h1>
    <div class="sector-banner">${bannerTexto}</div>
    <hr>
    <table><tbody>${itemsHtml || '<tr><td colspan="3">(sin ítems)</td></tr>'}</tbody></table>
    <hr>
    ${dirHtml}
  </section>`;

  const title = delivery
    ? `Comanda delivery N°${c.numero}`
    : `Comanda horno N°${c.numero}`;
  return { section, title };
}

/**
 * Documento listo para imprimir, con una comanda o con varias.
 *
 * Varias comandas van en UN solo documento y por lo tanto en un solo trabajo de
 * impresión: separadas por corte de página, salen una atrás de la otra sin que
 * nadie apriete nada entre medio.
 */
export function documentoComandas(comandas: ComandaCard[], widthMm: 58 | 80): string {
  const partes = comandas.map((c, i) => seccionComanda(c, i === comandas.length - 1));
  const title = partes.length === 1 ? partes[0].title : `${partes.length} comandas`;
  return wrapTicketDocument(partes.map((p) => p.section).join("\n"), {
    widthMm,
    title: `${title} — ${NEGOCIO}`,
    autoPrint: true,
  });
}
