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

export const NEGOCIO = "CARIBEÑA";

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
 * Una comanda, como sección de papel térmico.
 *
 * `ultima` marca la que no lleva corte después: en un papel continuo, cortar
 * detrás de la última tira un pedazo en blanco cada vez.
 */
export function seccionComanda(c: ComandaCard, ultima: boolean): { section: string; title: string } {
  // Pizzería = COPIA COMPLETA con precios (igualita al ticket cliente, solo cambia
  // el encabezado). Plancha y legacy = comanda de producción sin precios.
  // Un aviso no es un pedido: no lleva precios ni ítems, y el encabezado tiene
  // que gritar qué pasó para que nadie lo confunda con comida por preparar.
  const esAviso = c.tipo === "modificacion" || c.tipo === "cancelacion";
  const conPrecios = !esAviso && c.sector === "pizzeria";
  const banner = esAviso
    ? (c.tipo === "cancelacion" ? "*** CANCELACIÓN ***" : "*** MODIFICACIÓN ***")
    : c.sector === "pizzeria" ? "COPIA PIZZERÍA"
    : c.sector === "plancha" ? "COMANDA PLANCHA"
    : `COMANDA #${c.numero}`;
  const metaSector =
    c.sector === "pizzeria" ? "PIZZERÍA" : c.sector === "plancha" ? "PLANCHA" : "COCINA";

  // Cuerpo del aviso: qué había antes y qué hay ahora, en ese orden.
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
      const mitad = esMitad
        ? `<tr class="sub"><td></td><td colspan="2">½ ${escapeHtml(saborCorto(it.mitad_1_nombre))} + ½ ${escapeHtml(saborCorto(it.mitad_2_nombre))}</td></tr>` : "";
      const obs = (it.observacion ? `<tr class="sub"><td></td><td colspan="2">&gt;&gt; ${escapeHtml(it.observacion)}</td></tr>` : "") + mitad;

      // La medida es lo primero que necesita el pizzero: define el disco que
      // saca del freezer. En una mitad y mitad no está en el nombre del ítem
      // ("Pizza mitad y mitad"), sino en el de cada sabor. Los ítems cargados
      // antes de que el nombre la incluyera se resuelven leyéndola de la mitad.
      const nombre = esMitad && porcionesDeNombre(it.producto_nombre) == null
        ? `${it.producto_nombre} ${etiquetaPorciones(porcionesDeNombre(it.mitad_1_nombre))}`.trim()
        : it.producto_nombre;

      if (conPrecios) {
        return `
          <tr><td class="qty"><strong>${it.cantidad}×</strong></td><td class="name">${escapeHtml(nombre)}</td><td class="amt">${formatGs(it.total)}</td></tr>
          <tr class="sub"><td></td><td colspan="2">${it.cantidad} × ${formatGs(it.precio_unitario)}</td></tr>${obs}`;
      }
      return `
        <tr><td class="qty"><strong>${it.cantidad}×</strong></td><td class="name" colspan="2"><strong>${escapeHtml(nombre)}</strong></td></tr>${obs}`;
    })
    .join("");

  const totalGs = vigentes.reduce((s, it) => s + it.total, 0);
  const totalHtml = conPrecios
    ? `<hr><table class="totales"><tbody><tr class="total-row"><td class="lbl">TOTAL</td><td class="val">${formatGs(totalGs)}</td></tr></tbody></table>`
    : "";
  const footer = conPrecios ? "Copia pizzería — uso interno" : "Comanda interna — no es comprobante";

  const esParaLlevar = c.sesion_tipo === "para_llevar";
  const numeroPl = c.numero_pl != null ? `PL-${String(c.numero_pl).padStart(3, "0")}` : "PL";
  // La nota del pedido va en grande y en su propia línea: es lo que le dice a
  // cocina si esto es delivery o retiro, y de eso depende que avisen a tiempo
  // para llamar al repartidor. Perdida entre el resto del encabezado, no la ven.
  const notaPedido = (c.sesion_observacion ?? "").trim();
  const notaHtml = notaPedido
    ? `<div class="nota-pedido">${escapeHtml(notaPedido)}</div>`
    : "";

  const encabezadoPedido = esParaLlevar
    ? `<div><strong>PARA LLEVAR · ${escapeHtml(numeroPl)}</strong></div>${c.nombre_cliente ? `<div>Cliente: ${escapeHtml(c.nombre_cliente)}</div>` : ""}${notaHtml}`
    : `<div><strong>Mesa ${c.mesa_numero ?? "—"}</strong></div>${notaHtml}`;

  const section = `<section class="paper${ultima ? " last" : ""}">
    <div class="sector-banner">${banner}</div>
    <h1>${NEGOCIO}</h1>
    <div class="meta">${metaSector} · ${formatFecha(c.created_at)}</div>
    <hr>
    <div class="pedido">
      ${encabezadoPedido}
      <div>Mozo: ${escapeHtml(c.mozo_nombre ?? "—")}</div>
    </div>
    <hr>
    <table><tbody>${itemsHtml || '<tr><td colspan="2">(sin ítems)</td></tr>'}</tbody></table>
    ${totalHtml}
    <hr>
    <div class="footer">${footer}</div>
  </section>`;

  const title = c.sector === "pizzeria" ? "Copia pizzería" : c.sector === "plancha" ? "Comanda plancha" : `Comanda N°${c.numero}`;
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
