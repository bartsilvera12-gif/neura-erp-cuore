/**
 * KuDE (representación gráfica de la factura electrónica) en formato TICKET
 * térmico (58/80mm). Alternativa al PDF A4 para negocios que solo tienen
 * impresora de tickets. Incluye TODOS los datos exigidos por SIFEN para la
 * representación gráfica: emisor, timbrado, número, fecha, receptor, ítems,
 * totales con IVA, CDC, QR de ekuatia y la leyenda de verificación.
 *
 * Solo apariencia: no toca XML/firma/SET/CDC. Se construye a partir de lo ya
 * parseado del XML firmado (`KudeParsedFromXml`), igual que el KuDE PDF.
 */
import QRCode from "qrcode";
import type { KudeParsedFromXml } from "@/lib/sifen/parse-kude-from-signed-xml";
import type { MembreteMarca } from "@/lib/documentos/membrete";

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function gs(v: unknown, moneda: string): string {
  const n = Math.round(Number(v) || 0);
  return (moneda === "USD" ? "USD " : "Gs. ") + n.toLocaleString("es-PY");
}
function num(v: unknown): string {
  const n = Number(v) || 0;
  return n.toLocaleString("es-PY", { maximumFractionDigits: 4 });
}
function fh(iso: unknown): string {
  const s = String(iso ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T?(\d{2}:\d{2})?/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}${m[4] ? " " + m[4] : ""}`;
}

export async function buildKudeTicketHtml(input: {
  parsed: KudeParsedFromXml;
  numeroFactura: string;
  dProtAut: string | null;
  qrUrl: string;
  widthMm: 58 | 80;
  emisorTelefonoOverride?: string | null;
  emisorEmailOverride?: string | null;
  /** Logo de la configuración, embebido como data URL. null = sin logo. */
  logoUrl?: string | null;
  /** Branding de la sucursal (logo/teléfono/dirección) para el encabezado. */
  marca?: MembreteMarca;
  auto?: boolean;
}): Promise<string> {
  const { parsed, dProtAut, qrUrl, widthMm, auto, marca } = input;
  const fontPx = widthMm === 58 ? 11 : 12;
  const moneda = parsed.monedaCodigo || "PYG";
  const t = parsed.timbrado;
  const e = parsed.emisor;
  const r = parsed.receptor;
  const to = parsed.totales;
  // Encabezado: branding de la sucursal si existe (logo + tel/dirección de la
  // sucursal), manteniendo el NOMBRE legal y el RUC del emisor (dato fiscal).
  const logoUrl =
    (input.logoUrl && input.logoUrl.trim()) || (marca?.logoUrl && marca.logoUrl.trim()) || "";
  const email = (input.emisorEmailOverride && input.emisorEmailOverride.trim()) || e.dEmailE || "";
  const tel = (marca?.telefono && marca.telefono.trim())
    || (input.emisorTelefonoOverride && input.emisorTelefonoOverride.trim())
    || e.dTelEmi;
  const dirLineas = marca?.direccion && marca.direccion.length
    ? marca.direccion
    : (e.dDirEmi ? [e.dDirEmi] : []);
  const condicionVenta = parsed.operacion?.condicionVenta ?? "";
  const numeroDoc = `${t.dEst}-${t.dPunExp}-${t.dNumDoc}`;
  const tipoDoc = parsed.iTiDE === "5" ? "NOTA DE CRÉDITO ELECTRÓNICA" : "FACTURA ELECTRÓNICA";

  const qrDataUri = await QRCode.toDataURL(qrUrl, { margin: 0, scale: widthMm === 58 ? 3 : 4 });

  const itemsHtml = parsed.items.map((it) => `
    <tr><td class="d" colspan="2">${esc(it.descripcion)}</td></tr>
    <tr class="sub">
      <td>${num(it.cantidad)} ${esc(it.unidadMedida || "UNI")} x ${gs(it.precioUnit, moneda)}</td>
      <td class="a">${gs(it.totalLinea, moneda)}</td>
    </tr>`).join("");

  const fila = (label: string, val: string) =>
    `<div class="row"><span>${label}</span><span class="a">${val}</span></div>`;

  const totExe = Number(to.dSubExe) || 0;
  const tot5 = Number(to.dSub5) || 0;
  const tot10 = Number(to.dSub10) || 0;
  const iva5 = Number(to.dIVA5) || 0;
  const iva10 = Number(to.dIVA10) || 0;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tipoDoc)} ${esc(numeroDoc)}</title>
<style>
  :root{color-scheme:light} *{box-sizing:border-box}
  body{font-family:ui-monospace,"Courier New",monospace;font-size:${fontPx}px;color:#000;background:#f1f1f1;margin:0;padding:20px}
  .paper{background:#fff;width:${widthMm}mm;margin:0 auto;padding:6mm 4mm;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  hr{border:none;border-top:1px dashed #000;margin:2mm 0}
  .c{text-align:center}
  .b{font-weight:700}
  .emis{text-align:center;margin-bottom:1mm}
  /* Al imprimir el margen es de 2mm por lado: en 80mm quedan 76mm utiles,
     asi que 62mm de logo deja aire a los costados sin desperdiciar el ancho. */
  .emis .logo{max-width:${widthMm === 58 ? 46 : 62}mm;max-height:${widthMm === 58 ? 24 : 32}mm;width:auto;height:auto;object-fit:contain;display:inline-block;margin:0 auto 2mm}
  .emis .nom{font-weight:700;font-size:${fontPx + 1}px}
  .tit{text-align:center;font-weight:700;font-size:${fontPx + 1}px;letter-spacing:.03em;margin:1mm 0}
  .small{font-size:${fontPx - 1}px}
  .row{display:flex;justify-content:space-between;gap:6px;margin:.4mm 0}
  .a{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;margin-top:1mm}
  td{vertical-align:top;padding:.3mm 0}
  td.d{font-weight:600} td.a{text-align:right;white-space:nowrap}
  tr.sub td{color:#333;font-size:${fontPx - 1}px;padding-bottom:1mm}
  .tot .row{font-size:${fontPx}px}
  .total{display:flex;justify-content:space-between;font-weight:700;font-size:${fontPx + 3}px;border-top:1px solid #000;margin-top:1mm;padding-top:1mm}
  .cdc{word-break:break-all;font-size:${fontPx - 2}px;text-align:center;margin-top:1mm}
  .qr{text-align:center;margin:2mm 0}
  .qr img{width:${widthMm === 58 ? 34 : 42}mm;height:${widthMm === 58 ? 34 : 42}mm}
  .leg{font-size:${fontPx - 2}px;text-align:center;margin-top:1mm}
  .actions{max-width:${widthMm}mm;margin:8mm auto 0;text-align:center}
  .actions button{padding:8px 16px;font-size:13px;cursor:pointer;border:1px solid #333;background:#fff;border-radius:6px}
  @media print{body{background:#fff;padding:0}.paper{width:${widthMm}mm;box-shadow:none;padding:2mm;margin:0}.actions{display:none}@page{margin:0;size:${widthMm}mm auto}}
</style></head><body>
  <div class="paper">
    <div class="emis">
      ${logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="${esc(e.dNomEmi)}" />` : ""}
      <div class="nom">${esc(e.dNomEmi)}</div>
      <div class="small">RUC: ${esc(e.dRucEm)}-${esc(e.dDVEmi)}</div>
      ${dirLineas.map((l) => `<div class="small">${esc(l)}</div>`).join("")}
      ${tel ? `<div class="small">Teléfono: ${esc(tel)}</div>` : ""}
      ${email ? `<div class="small">${esc(email)}</div>` : ""}
    </div>
    <hr>
    <div class="tit">${esc(tipoDoc)}</div>
    <div class="row"><span>Timbrado</span><span class="a">${esc(t.dNumTim)}</span></div>
    <div class="row"><span>Inicio vig.</span><span class="a">${fh(t.dFeIniT)}</span></div>
    <div class="row"><span>N°</span><span class="a b">${esc(numeroDoc)}</span></div>
    <div class="row"><span>Fecha emisión</span><span class="a">${fh(parsed.dFeEmiDE)}</span></div>
    <div class="row"><span>Condición</span><span class="a">${esc(condicionVenta || "—")}</span></div>
    <hr>
    <div class="small b">Cliente</div>
    <div class="small">${esc(r.nombre || "Sin nombre")}</div>
    ${r.docValue ? `<div class="small">${esc(r.docLabel || "Doc")}: ${esc(r.docValue)}</div>` : ""}
    <hr>
    <table><tbody>${itemsHtml}</tbody></table>
    <hr>
    <div class="tot">
      ${totExe > 0 ? fila("Exentas", gs(totExe, moneda)) : ""}
      ${tot5 > 0 ? fila("Gravadas 5%", gs(tot5, moneda)) : ""}
      ${tot10 > 0 ? fila("Gravadas 10%", gs(tot10, moneda)) : ""}
      ${iva5 > 0 ? fila("IVA 5%", gs(iva5, moneda)) : ""}
      ${iva10 > 0 ? fila("IVA 10%", gs(iva10, moneda)) : ""}
      ${fila("Total IVA", gs(to.dTotIVA, moneda))}
    </div>
    <div class="total"><span>TOTAL</span><span>${gs(to.dTotGralOpe, moneda)}</span></div>
    <hr>
    <div class="small c">CDC</div>
    <div class="cdc">${esc(parsed.cdc)}</div>
    ${dProtAut ? `<div class="small c">N° Autorización (dProtAut): ${esc(dProtAut)}</div>` : ""}
    <div class="qr"><img src="${qrDataUri}" alt="QR e-kuatia" /></div>
    <div class="leg">Consulte la validez de este documento en<br>https://ekuatia.set.gov.py</div>
    <div class="leg">Información de carácter no fiscal impresa en papel térmico.</div>
  </div>
  <div class="actions">
    <button type="button" onclick="window.print()">Imprimir</button>
    <a href="?formato=ticket&w=${widthMm === 80 ? 58 : 80}" style="margin-left:12px;font-size:13px;color:#444">Cambiar a ${widthMm === 80 ? 58 : 80}mm</a>
    <a href="?formato=a4" style="margin-left:12px;font-size:13px;color:#444">Ver A4</a>
  </div>
  <script>try{ if (${auto ? "true" : "false"}) setTimeout(function(){window.print();},250);}catch(e){}</script>
</body></html>`;
}
