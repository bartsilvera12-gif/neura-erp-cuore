import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { downloadSifenObject } from "@/lib/sifen/sifen-storage";
import { buildKudePdfBuffer, type KudeBranding } from "@/lib/sifen/kude-pdf";
import { buildKudeTicketHtml } from "@/lib/sifen/kude-ticket-html";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import {
  kudeFallbackQrUrl,
  parseKudeFromSignedRdeXml,
} from "@/lib/sifen/parse-kude-from-signed-xml";
import type { SifenConsultaLoteUltimaPersistida } from "@/lib/sifen/types";
import type { AppSupabaseClient } from "@/lib/supabase/schema";


function filasDetalleConsulta(
  consulta: SifenConsultaLoteUltimaPersistida | Record<string, unknown> | null | undefined
): { cdc: string; dProtAut: string | null }[] {
  if (!consulta || typeof consulta !== "object") return [];
  const o = consulta as Record<string, unknown>;
  const raw = o.detallePorCdc ?? o.detalle_por_cdc;
  if (!Array.isArray(raw)) return [];
  return raw as { cdc: string; dProtAut: string | null }[];
}

function dProtAutDesdeConsulta(
  cdc: string,
  consulta: SifenConsultaLoteUltimaPersistida | Record<string, unknown> | null | undefined
): string | null {
  const rows = filasDetalleConsulta(consulta);
  if (rows.length === 0) return null;
  const hit = rows.find((d) => d.cdc === cdc);
  const v = hit?.dProtAut;
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

function nombreArchivoKude(numeroFactura: string, cdc: string): string {
  const safe = numeroFactura.replace(/[^\w.-]+/g, "_").slice(0, 40);
  const tail = cdc.slice(-8);
  return `KuDE-${safe || "factura"}-${tail}.pdf`;
}

/**
 * Carga branding KuDE/PDF desde `empresa_sifen_config` para la empresa.
 * Devuelve null cuando no hay nada configurado o cuando la lectura no pudo
 * resolverse: en ese caso el renderer usa el diseño Neura por defecto.
 * Solo afecta el PDF; no interactúa con XML/firma/SET/CDC.
 */
async function loadKudeBranding(
  supabase: AppSupabaseClient,
  empresaId: string
): Promise<KudeBranding | null> {
  const { data, error } = await supabase
    .from("empresa_sifen_config")
    .select("kude_logo_path, kude_color_primario, kude_color_primario_fill")
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as {
    kude_logo_path: string | null;
    kude_color_primario: string | null;
    kude_color_primario_fill: string | null;
  };

  const colorPrimario =
    row.kude_color_primario == null || String(row.kude_color_primario).trim() === ""
      ? null
      : String(row.kude_color_primario).trim();
  const colorPrimarioFill =
    row.kude_color_primario_fill == null ||
    String(row.kude_color_primario_fill).trim() === ""
      ? null
      : String(row.kude_color_primario_fill).trim();

  let logoBytes: Uint8Array | null = null;
  const logoPath =
    row.kude_logo_path == null || String(row.kude_logo_path).trim() === ""
      ? null
      : String(row.kude_logo_path).trim();
  if (logoPath) {
    const dl = await downloadSifenObject(supabase, logoPath);
    if (dl.ok) {
      logoBytes = new Uint8Array(dl.data);
    } else {
      console.warn("[kude] logo download failed, falling back to default", {
        empresa_id: empresaId,
        path: logoPath,
        message: dl.message,
      });
    }
  }

  if (!logoBytes && !colorPrimario && !colorPrimarioFill) return null;
  return { logoBytes, colorPrimario, colorPrimarioFill };
}

/**
 * GET /api/facturas/[id]/sifen/kude
 * PDF KuDE a partir del XML firmado. Solo si `estado_sifen` = aprobado.
 * Query: `download=1` → Content-Disposition attachment.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getFacturasSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const { id: facturaId } = await params;
    if (!facturaId?.trim()) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    const download = request.nextUrl.searchParams.get("download") === "1";
    const fid = facturaId.trim();

    const { data: fac, error: errFac } = await supabase
      .from("facturas")
      .select("id, numero_factura")
      .eq("id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errFac) {
      return NextResponse.json(errorResponse(errFac.message), { status: 400 });
    }
    if (!fac) {
      return NextResponse.json(errorResponse("Factura no encontrada."), { status: 404 });
    }

    const { data: feRow, error: errFe } = await supabase
      .from("factura_electronica")
      .select("estado_sifen, xml_firmado_path, cdc, sifen_ultima_respuesta_consulta_lote")
      .eq("factura_id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errFe) {
      return NextResponse.json(errorResponse(errFe.message), { status: 400 });
    }
    if (!feRow) {
      return NextResponse.json(errorResponse("No hay documento electrónico para esta factura."), {
        status: 404,
      });
    }

    if (String(feRow.estado_sifen) !== "aprobado") {
      return NextResponse.json(
        errorResponse("El KuDE solo está disponible con SIFEN en estado «aprobado»."),
        { status: 403 }
      );
    }

    const xmlPath =
      feRow.xml_firmado_path == null ? "" : String(feRow.xml_firmado_path).trim();
    if (!xmlPath) {
      return NextResponse.json(errorResponse("No hay XML firmado en storage."), { status: 400 });
    }

    const dl = await downloadSifenObject(supabase, xmlPath);
    if (!dl.ok) {
      return NextResponse.json(
        errorResponse(`No se pudo descargar el XML firmado: ${dl.message}`),
        { status: 500 }
      );
    }

    let parsed;
    try {
      parsed = parseKudeFromSignedRdeXml(dl.data.toString("utf8"));
    } catch (e) {
      const m = e instanceof Error ? e.message : "Error al leer el XML";
      return NextResponse.json(errorResponse(`XML firmado inválido: ${m}`), { status: 500 });
    }

    const cdcBd = feRow.cdc == null ? "" : String(feRow.cdc).trim();
    if (cdcBd && cdcBd !== parsed.cdc) {
      return NextResponse.json(
        errorResponse("Inconsistencia CDC: re-genere y firme el XML o contacte soporte."),
        { status: 409 }
      );
    }

    const consultaRaw = feRow.sifen_ultima_respuesta_consulta_lote as
      | SifenConsultaLoteUltimaPersistida
      | Record<string, unknown>
      | null
      | undefined;
    const dProtAut = dProtAutDesdeConsulta(parsed.cdc, consultaRaw ?? null);

    const qrUrl = parsed.dCarQR ?? kudeFallbackQrUrl(parsed.cdc);

    /**
     * Branding opcional KuDE/PDF por empresa. SOLO afecta apariencia visual.
     * No participa de XML/firma/SET/CDC. Si la empresa no configuró nada o
     * la descarga del logo falla, se cae silenciosamente al diseño Neura.
     */
    const branding = await loadKudeBranding(
      supabase,
      auth.empresa_id
    ).catch((e) => {
      console.warn("[kude] branding load failed, using default", {
        empresa_id: auth.empresa_id,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    });

    // Códigos de barras por item, alineados posicionalmente con parsed.items.
    // El XML no lleva SKU (dCodInt hardcodeado como "L1","L2"...), así que
    // no se puede matchear por SKU. Path: factura → origen_venta_id →
    // ventas_items (ordered) → productos → codigo_barras. Match por posición
    // con parsed.items (el XML preserva el mismo orden que factura_items /
    // ventas_items al momento de emitir).
    let codigosBarrasPorItem: (string | null)[] | undefined;
    try {
      const { data: facMeta } = await supabase
        .from("facturas")
        .select("origen_venta_id")
        .eq("id", fid)
        .eq("empresa_id", auth.empresa_id)
        .maybeSingle();
      const origenVentaId = (facMeta as { origen_venta_id?: string | null } | null)?.origen_venta_id ?? null;
      if (origenVentaId) {
        const { data: viRows, error: errVi } = await supabase
          .from("ventas_items")
          .select("producto_id, sku, created_at")
          .eq("empresa_id", auth.empresa_id)
          .eq("venta_id", origenVentaId)
          .order("created_at", { ascending: true });
        if (errVi) {
          console.warn("[kude] no se pudieron cargar ventas_items para codigos_barras", {
            message: errVi.message,
          });
        } else {
          const items = (viRows ?? []) as Array<{ producto_id: string | null; sku: string | null }>;
          const productoIds = Array.from(
            new Set(items.map((it) => it.producto_id).filter((v): v is string => !!v))
          );
          // Match por NOMBRE del producto (= descripción del ítem en el XML), NO
          // por posición. El match posicional se desalineaba cuando ventas_items
          // se insertaba en batch (todos con el mismo created_at → `ORDER BY
          // created_at` no determinístico ≠ orden del XML), y el código de barras
          // terminaba pegado al producto de al lado.
          const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");
          const codigoByNombre = new Map<string, string | null>();
          if (productoIds.length > 0) {
            const { data: prods, error: errProds } = await supabase
              .from("productos")
              .select("id, nombre, codigo_barras")
              .eq("empresa_id", auth.empresa_id)
              .in("id", productoIds);
            if (errProds) {
              console.warn("[kude] no se pudo cargar codigo_barras de productos", {
                message: errProds.message,
              });
            } else {
              for (const p of (prods ?? []) as Array<{ id: string; nombre?: string | null; codigo_barras?: string | null }>) {
                const nombre = norm(String(p.nombre ?? ""));
                if (!nombre) continue;
                const cb = (p.codigo_barras ?? "").trim() || null;
                // Nombre ambiguo (dos productos, códigos distintos): no arriesgar
                // un código equivocado → se deja null (no se muestra código).
                if (codigoByNombre.has(nombre) && codigoByNombre.get(nombre) !== cb) {
                  codigoByNombre.set(nombre, null);
                } else {
                  codigoByNombre.set(nombre, cb);
                }
              }
            }
          }
          // La descripción del ítem del XML (dDesProSer) es el nombre del producto.
          codigosBarrasPorItem = parsed.items.map((it) => codigoByNombre.get(norm(String(it.descripcion ?? ""))) ?? null);
        }
      }
    } catch (e) {
      console.warn("[kude] excepción cargando codigos_barras (se omite)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Cargar contacto emisor actual de empresa_sifen_config para overrides
    // retroactivos del KUDE (fix visual de facturas viejas que llevan valores
    // hardcodeados en el XML firmado). No modifica el XML.
    let emisorTelefonoOverride: string | null = null;
    let emisorEmailOverride: string | null = null;
    try {
      const { data: cfgRow } = await supabase
        .from("empresa_sifen_config")
        .select("emisor_telefono, emisor_email")
        .eq("empresa_id", auth.empresa_id)
        .maybeSingle();
      const row = cfgRow as { emisor_telefono?: string | null; emisor_email?: string | null } | null;
      const tel = (row?.emisor_telefono ?? "").trim();
      const em = (row?.emisor_email ?? "").trim();
      if (tel) emisorTelefonoOverride = tel;
      if (em) emisorEmailOverride = em;
    } catch (e) {
      console.warn("[kude] no se pudo cargar contacto emisor override", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const numeroFactura = fac.numero_factura == null ? "" : String(fac.numero_factura);

    // Formato de impresión (representación gráfica). Orden de prioridad:
    //   1) query param (?formato=ticket|a4, ?w=58|80) — override manual;
    //   2) formato de la SUCURSAL de la factura (sucursales.kude_formato) —
    //      p. ej. Reserva Market en ticket, Casa Matriz en A4;
    //   3) config de la empresa (empresa_facturacion_modo.impresion_tipo_default);
    //   4) default A4.
    const formatoParam = request.nextUrl.searchParams.get("formato");
    const wParam = request.nextUrl.searchParams.get("w");

    // El formato sale de la configuración de facturación de la empresa
    // (pdf_a4 | ticket_58mm | ticket_80mm). Acá no hay sucursales.
    let formatoBase = "";
    {
      try {
        const { data: modoRow } = await supabase
          .from("empresa_facturacion_modo")
          .select("impresion_tipo_default")
          .eq("empresa_id", auth.empresa_id)
          .maybeSingle();
        formatoBase = String((modoRow as { impresion_tipo_default?: string } | null)?.impresion_tipo_default ?? "").trim();
      } catch { /* cae a A4 */ }
    }

    let esTicket = formatoBase === "ticket_58mm" || formatoBase === "ticket_80mm";
    let widthMm: 58 | 80 = formatoBase === "ticket_58mm" ? 58 : 80;
    if (formatoParam === "ticket") esTicket = true;
    else if (formatoParam === "a4") esTicket = false;
    if (wParam === "58") widthMm = 58;
    else if (wParam === "80") widthMm = 80;

    if (esTicket) {
      // El encabezado sale del XML firmado (nombre, RUC, dirección) más el
      // teléfono y el email de la config: no hay branding por sucursal porque
      // Cucina del Cuore es un solo local.
      const html = await buildKudeTicketHtml({
        parsed,
        numeroFactura,
        dProtAut,
        qrUrl,
        widthMm,
        emisorTelefonoOverride,
        emisorEmailOverride,
        logoUrl: branding?.logoBytes
          ? `data:image/png;base64,${Buffer.from(branding.logoBytes).toString("base64")}`
          : null,
        auto: request.nextUrl.searchParams.get("auto") !== "0",
      });
      return new NextResponse(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
      });
    }

    let pdf: Buffer;
    try {
      pdf = await buildKudePdfBuffer({
        parsed,
        numeroFactura,
        dProtAut,
        qrUrl,
        branding,
        codigosBarrasPorItem,
        emisorTelefonoOverride,
        emisorEmailOverride,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : "Error al generar PDF";
      return NextResponse.json(errorResponse(m), { status: 500 });
    }

    const fname = nombreArchivoKude(numeroFactura, parsed.cdc);
    const disp = download ? `attachment; filename="${fname}"` : `inline; filename="${fname}"`;

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": disp,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
