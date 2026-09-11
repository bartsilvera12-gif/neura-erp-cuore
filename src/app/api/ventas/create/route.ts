import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { createVentaTransaccionalPg } from "@/lib/ventas/server/create-venta-pg";
import type { CreateVentaItemInput } from "@/lib/ventas/server/create-venta-pg";
import { calcularLineaVenta } from "@/lib/ventas/iva";
import { getCajaAbiertaPg } from "@/lib/caja/server/caja-pg";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import type { Venta, LineaVenta } from "@/lib/ventas/types";

function asItems(body: unknown): CreateVentaItemInput[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { items?: unknown }).items;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: CreateVentaItemInput[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    const tipoIva = r.tipo_iva;
    if (tipoIva !== "EXENTA" && tipoIva !== "5%" && tipoIva !== "10%") return null;
    const cantidad = Number(r.cantidad);
    const precioVenta = Number(r.precio_venta);
    // IVA INCLUIDO: el desglose se recalcula en el servidor a partir de
    // precio × cantidad; nunca se confía en subtotal/iva/total del cliente.
    const desglose = calcularLineaVenta(precioVenta, cantidad, tipoIva);
    out.push({
      producto_id: String(r.producto_id ?? ""),
      producto_nombre: String(r.producto_nombre ?? ""),
      sku: String(r.sku ?? ""),
      cantidad,
      precio_venta_original: Number(r.precio_venta_original),
      precio_venta: precioVenta,
      tipo_iva: tipoIva,
      subtotal: desglose.subtotal,
      monto_iva: desglose.monto_iva,
      total_linea: desglose.total_linea,
      es_mitad_mitad: r.es_mitad_mitad === true,
      mitad_1_producto_id: r.mitad_1_producto_id ? String(r.mitad_1_producto_id) : null,
      mitad_2_producto_id: r.mitad_2_producto_id ? String(r.mitad_2_producto_id) : null,
      mitad_1_nombre: r.mitad_1_nombre ? String(r.mitad_1_nombre) : null,
      mitad_2_nombre: r.mitad_2_nombre ? String(r.mitad_2_nombre) : null,
      item_display_name: r.item_display_name ? String(r.item_display_name) : null,
    });
  }
  if (out.some((i) => !i.producto_id || !(i.cantidad > 0))) return null;
  return out;
}

function toVentaResponse(
  items: CreateVentaItemInput[],
  meta: {
    id: string;
    numero_control: string;
    fechaIso: string;
    moneda: Venta["moneda"];
    tipo_cambio: number;
    tipo_venta: Venta["tipo_venta"];
    plazo_dias?: number;
    metodo_pago?: Venta["metodo_pago"];
    subtotal: number;
    monto_iva: number;
    total: number;
  }
): Venta {
  const lineas: LineaVenta[] = items.map((i) => ({
    producto_id: i.producto_id,
    producto_nombre: i.producto_nombre,
    sku: i.sku,
    cantidad: i.cantidad,
    precio_venta_original: i.precio_venta_original,
    precio_venta: i.precio_venta,
    tipo_iva: i.tipo_iva,
    subtotal: i.subtotal,
    monto_iva: i.monto_iva,
    total_linea: i.total_linea,
  }));
  return {
    id: meta.id,
    numero_control: meta.numero_control,
    items: lineas,
    moneda: meta.moneda,
    tipo_cambio: meta.tipo_cambio,
    subtotal: meta.subtotal,
    monto_iva: meta.monto_iva,
    total: meta.total,
    tipo_venta: meta.tipo_venta,
    plazo_dias: meta.plazo_dias,
    metodo_pago: meta.metodo_pago,
    fecha: meta.fechaIso,
  };
}

/**
 * POST /api/ventas/create — venta + ítems + stock + movimientos (una transacción Postgres).
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const items = asItems(body);
    if (!items) {
      return NextResponse.json(errorResponse("Payload inválido: items requeridos."), { status: 400 });
    }

    const o = body as Record<string, unknown>;
    const moneda = o.moneda === "USD" ? "USD" : "GS";
    const tipoCambio = Number(o.tipo_cambio) || 1;
    const tipoVenta = o.tipo_venta === "CREDITO" ? "CREDITO" : "CONTADO";
    const plazoDias =
      tipoVenta === "CREDITO" && o.plazo_dias != null && String(o.plazo_dias).trim() !== ""
        ? parseInt(String(o.plazo_dias), 10)
        : null;
    const metodoPago: "efectivo" | "tarjeta" | "transferencia" | "qr" =
      o.metodo_pago === "tarjeta" || o.metodo_pago === "transferencia" || o.metodo_pago === "qr"
        ? o.metodo_pago
        : "efectivo";

    // Cobro repartido: una línea por forma de pago. Si no viene, más abajo se
    // arma una sola línea con `metodoPago` por el total de la venta.
    const METODOS = ["efectivo", "tarjeta", "transferencia", "qr"] as const;
    const pagos = Array.isArray((o as { pagos?: unknown }).pagos)
      ? ((o as { pagos: unknown[] }).pagos
          .map((raw) => {
            const p = raw as Record<string, unknown>;
            const metodo = String(p.metodo_pago ?? "");
            const monto = Number(p.monto) || 0;
            if (!(METODOS as readonly string[]).includes(metodo) || monto <= 0) return null;
            return {
              metodo_pago: metodo as (typeof METODOS)[number],
              monto,
              referencia:
                typeof p.referencia === "string" && p.referencia.trim() !== ""
                  ? p.referencia.trim().slice(0, 120)
                  : null,
            };
          })
          .filter((p): p is { metodo_pago: (typeof METODOS)[number]; monto: number; referencia: string | null } => p !== null))
      : [];

    // Lo cobrado tiene que dar el total. Se tolera una diferencia de 1 Gs por
    // el redondeo de los montos que teclea el cajero; más que eso es un error
    // de carga y el arqueo lo arrastraría hasta el cierre.
    if (pagos.length > 0) {
      const sumaPagos = pagos.reduce((acc, p) => acc + p.monto, 0);
      const totalVenta = Number(o.total) || 0;
      if (Math.abs(sumaPagos - totalVenta) > 1) {
        return NextResponse.json(
          errorResponse(
            `El cobro suma ${Math.round(sumaPagos).toLocaleString("es-PY")} y la venta es de ${Math.round(totalVenta).toLocaleString("es-PY")}.`
          ),
          { status: 400 }
        );
      }
    }
    const clienteRaw = o.cliente_id;
    const clienteId =
      clienteRaw === null || clienteRaw === undefined || clienteRaw === ""
        ? null
        : String(clienteRaw);
    const observaciones =
      o.observaciones === null || o.observaciones === undefined
        ? null
        : String(o.observaciones).slice(0, 4000);

    // Pedido de cocina (modalidad obligatoria en instancia Cucina del Cuore)
    const pedidoRaw = (o.pedido_cocina ?? null) as Record<string, unknown> | null;
    type PedidoCocinaParsed = {
      modalidad: "local" | "delivery" | "carry_out";
      mesa: string | null;
      cliente_nombre: string | null;
      cliente_telefono: string | null;
      direccion_entrega: string | null;
      observacion: string | null;
      costo_delivery: number;
    };
    let pedidoCocina: PedidoCocinaParsed | null = null;
    if (pedidoRaw && typeof pedidoRaw === "object") {
      const m = pedidoRaw.modalidad;
      if (m !== "local" && m !== "delivery" && m !== "carry_out") {
        return NextResponse.json(
          errorResponse("Modalidad de pedido inválida (local | delivery | carry_out)."),
          { status: 400 }
        );
      }
      const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const mesa = trim(pedidoRaw.mesa);
      const cliNombre = trim(pedidoRaw.cliente_nombre);
      const cliTel = trim(pedidoRaw.cliente_telefono);
      const direccion = trim(pedidoRaw.direccion_entrega);
      const obs = trim(pedidoRaw.observacion);
      // Costo de delivery: sólo se acepta (>= 0) en modalidad delivery. En
      // local/retiro se descarta, así nunca se persiste un monto de una
      // modalidad que el cajero cambió después. Es informativo: no toca el
      // total de la venta ni el cobro.
      const costoDeliveryRaw = Number(pedidoRaw.costo_delivery);
      const costoDelivery =
        m === "delivery" && Number.isFinite(costoDeliveryRaw) && costoDeliveryRaw > 0
          ? Math.round(costoDeliveryRaw)
          : 0;
      // Datos de modalidad opcionales: no se rechaza la venta si faltan
      // teléfono/dirección en Delivery (la caja no debe frenarse por eso).
      pedidoCocina = {
        modalidad: m,
        mesa: mesa || null,
        cliente_nombre: cliNombre || null,
        cliente_telefono: cliTel || null,
        direccion_entrega: direccion || null,
        observacion: obs || null,
        costo_delivery: costoDelivery,
      };
    }

    // Totales derivados de los ítems YA recalculados en el servidor (IVA incluido).
    // No se confía en los totales del cliente: la cabecera es autoritativa server-side.
    let subtotalDeclarado = 0;
    let montoIvaDeclarado = 0;
    let totalDeclarado = 0;
    for (const it of items) {
      subtotalDeclarado += it.subtotal;
      montoIvaDeclarado += it.monto_iva;
      totalDeclarado += it.total_linea;
    }

    if (moneda === "USD" && tipoCambio <= 0) {
      return NextResponse.json(errorResponse("Tipo de cambio inválido para USD."), { status: 400 });
    }

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);

    // La venta debe asociarse a la caja abierta. Sin caja abierta no se vende.
    const cajaAbierta = await getCajaAbiertaPg(schema, auth.empresa_id);
    if (!cajaAbierta) {
      return NextResponse.json(
        errorResponse("Para vender primero tenés que abrir caja."),
        { status: 409 }
      );
    }

    const { ventaId, numeroControl, fechaIso } = await createVentaTransaccionalPg({
      schema,
      empresaId: auth.empresa_id,
      clienteId,
      observaciones,
      moneda,
      tipoCambio,
      tipoVenta,
      plazoDias: Number.isFinite(plazoDias as number) ? plazoDias : null,
      metodoPago,
      pagos,
      items,
      subtotalDeclarado,
      montoIvaDeclarado,
      totalDeclarado,
      pedidoCocina,
      cajaId: cajaAbierta.id,
    });

    let sub = 0;
    let iv = 0;
    let tot = 0;
    for (const it of items) {
      sub += it.subtotal;
      iv += it.monto_iva;
      tot += it.total_linea;
    }

    const venta = toVentaResponse(items, {
      id: ventaId,
      numero_control: numeroControl,
      fechaIso,
      moneda,
      tipo_cambio: tipoCambio,
      tipo_venta: tipoVenta,
      plazo_dias: tipoVenta === "CREDITO" ? plazoDias ?? undefined : undefined,
      metodo_pago: metodoPago,
      subtotal: sub,
      monto_iva: iv,
      total: tot,
    });

    return NextResponse.json(successResponse({ venta }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error al crear la venta.";
    const status =
      msg.includes("no existen") ||
      msg.includes("Cliente no encontrado") ||
      msg.includes("Totales no coinciden") ||
      msg.includes("al menos un")
        ? 400
        : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
