import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { calcularLineaVenta } from "@/lib/ventas/iva";
import { repartirDescuento } from "@/lib/ventas/descuento";

export interface CreateVentaItemInput {
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad: number;
  precio_venta_original: number;
  precio_venta: number;
  tipo_iva: "EXENTA" | "5%" | "10%";
  subtotal: number;
  monto_iva: number;
  total_linea: number;
  /** Pizza mitad y mitad (metadata; precio ya viene como max de ambos sabores). */
  es_mitad_mitad?: boolean;
  mitad_1_producto_id?: string | null;
  mitad_2_producto_id?: string | null;
  mitad_1_nombre?: string | null;
  mitad_2_nombre?: string | null;
  item_display_name?: string | null;
}

export interface CreateVentaPedidoCocinaInput {
  modalidad: "local" | "delivery" | "carry_out";
  mesa: string | null;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  direccion_entrega: string | null;
  observacion: string | null;
  /**
   * Costo de delivery informado al cliente (guaraníes). Pass-through: NO se
   * suma a `ventas.total`, ni al cobro, ni al IVA, ni al arqueo. Se guarda junto
   * al pedido (proyectos) sólo como dato informativo. Se espera 0 salvo en
   * modalidad "delivery" (el route ya lo fuerza a 0 en el resto).
   */
  costo_delivery: number;
}

export interface CreateVentaPgParams {
  schema: string;
  empresaId: string;
  clienteId: string | null;
  observaciones: string | null;
  moneda: "GS" | "USD";
  tipoCambio: number;
  tipoVenta: "CONTADO" | "CREDITO";
  plazoDias: number | null;
  /** Método predominante. Se deriva de `pagos` cuando el cobro va repartido. */
  metodoPago: "efectivo" | "tarjeta" | "transferencia" | "qr" | null;
  /**
   * Cómo se cobró la venta. Una fila por forma de pago: 60.000 en efectivo y
   * 40.000 por transferencia son dos líneas. Si viene vacío se arma una sola
   * línea con `metodoPago` por el total, así toda venta tiene su detalle y el
   * arqueo no depende de dos caminos distintos.
   */
  pagos?: CreateVentaPagoInput[];
  items: CreateVentaItemInput[];
  subtotalDeclarado: number;
  montoIvaDeclarado: number;
  totalDeclarado: number;
  pedidoCocina?: CreateVentaPedidoCocinaInput | null;
  /** Caja (turno) a la que se asocia la venta. Obligatoria en Cucina del Cuore. */
  cajaId: string;
  /**
   * Descuento ya autorizado, en guaraníes sobre el total.
   *
   * Llega después de validar la clave: acá no se vuelve a preguntar, pero sí se
   * reparte entre las líneas y se recalculan los totales. Los totales que
   * declara la pantalla son SIN descuento, y se validan como siempre — el
   * descuento lo aplica el servidor, que es el único que decide cuánto se cobra.
   */
  descuento?: { monto: number; motivo: string | null; autorizadoPor: string | null } | null;
}

export interface CreateVentaPagoInput {
  metodo_pago: "efectivo" | "tarjeta" | "transferencia" | "qr";
  monto: number;
  cuenta_bancaria_id?: string | null;
  referencia?: string | null;
}

/**
 * Arma las líneas de cobro que se van a guardar.
 *
 * Si no se detalló nada, el cobro es una sola línea por el total con el método
 * elegido. Se descartan las líneas en cero: son filas que no dicen nada y la
 * base las rechaza.
 */
function armarPagos(
  pagos: CreateVentaPagoInput[] | undefined,
  metodoPago: "efectivo" | "tarjeta" | "transferencia" | "qr" | null,
  total: number
): CreateVentaPagoInput[] {
  const limpias = (pagos ?? []).filter((p) => Number(p.monto) > 0);
  if (limpias.length > 0) return limpias;
  if (total <= 0) return [];
  return [{ metodo_pago: metodoPago ?? "efectivo", monto: total }];
}

/** Método que más plata aportó: es el que se guarda en la venta. */
function metodoPredominante(
  pagos: CreateVentaPagoInput[],
  fallback: "efectivo" | "tarjeta" | "transferencia" | "qr" | null
): "efectivo" | "tarjeta" | "transferencia" | "qr" | null {
  if (pagos.length === 0) return fallback;
  const porMetodo = new Map<string, number>();
  for (const p of pagos) {
    porMetodo.set(p.metodo_pago, (porMetodo.get(p.metodo_pago) ?? 0) + Number(p.monto));
  }
  let mejor = pagos[0].metodo_pago;
  let mejorMonto = -1;
  for (const [m, monto] of porMetodo) {
    if (monto > mejorMonto) { mejor = m as CreateVentaPagoInput["metodo_pago"]; mejorMonto = monto; }
  }
  return mejor;
}

function recalcTotals(items: CreateVentaItemInput[]) {
  let subtotal = 0;
  let montoIva = 0;
  let total = 0;
  for (const it of items) {
    subtotal += it.subtotal;
    montoIva += it.monto_iva;
    total += it.total_linea;
  }
  return { subtotal, montoIva, total };
}

const TOL = 2;

/**
 * Crea venta + ítems + movimientos + descuenta stock vía PostgREST/service-role.
 * Sin pool PG directo → compatible con Hostinger Node.js App.
 *
 * Atomicidad: PostgREST no expone transacciones multi-statement. Se hace best-effort:
 * si algún paso post-venta falla, se intenta rollback eliminando venta+items creados.
 * Para una instancia gastronómica de bajo volumen es aceptable.
 *
 * Regla `controla_stock`:
 *  - true (Reventa): descuenta stock y genera movimiento. Si no alcanza, la
 *    venta se hace igual y el stock queda en negativo (ver punto 3).
 *  - false (Menú): se inserta en ventas_items igual, NO descuenta, NO movimiento.
 */
export async function createVentaTransaccionalPg(
  params: CreateVentaPgParams
): Promise<{ ventaId: string; numeroControl: string; fechaIso: string }> {
  if (!params.items.length) {
    throw new Error("La venta debe tener al menos un ítem.");
  }

  // El servidor es la fuente de verdad: recalcula el desglose de IVA de cada
  // línea como IVA INCLUIDO (precio × cantidad = total; el IVA se deduce, no se
  // suma). Así un frontend desactualizado nunca puede inflar el total con IVA.
  const items: CreateVentaItemInput[] = params.items.map((it) => {
    const desglose = calcularLineaVenta(it.precio_venta, it.cantidad, it.tipo_iva);
    return {
      ...it,
      subtotal: desglose.subtotal,
      monto_iva: desglose.monto_iva,
      total_linea: desglose.total_linea,
    };
  });

  const calcSinDescuento = recalcTotals(items);
  if (
    Math.abs(calcSinDescuento.subtotal - params.subtotalDeclarado) > TOL ||
    Math.abs(calcSinDescuento.montoIva - params.montoIvaDeclarado) > TOL ||
    Math.abs(calcSinDescuento.total - params.totalDeclarado) > TOL
  ) {
    throw new Error("Los totales no coinciden con los ítems; revisá el carrito.");
  }

  // Descuento: baja el precio de cada línea en vez de restarse al final. Así el
  // IVA se sigue calculando línea por línea y la factura electrónica —que copia
  // esas líneas— cierra sola. Un descuento sólo en la cabecera haría que la
  // suma de los ítems no diera el total, y el SET rechaza el documento por eso.
  const descuentoPedido = Math.round(Number(params.descuento?.monto) || 0);
  const descuentoAplicado =
    descuentoPedido > 0 && descuentoPedido < calcSinDescuento.total ? descuentoPedido : 0;

  const itemsFinales: CreateVentaItemInput[] =
    descuentoAplicado > 0
      ? repartirDescuento(items, descuentoAplicado).map(({ linea, precioFinal }) => {
          const d = calcularLineaVenta(precioFinal, linea.cantidad, linea.tipo_iva);
          return {
            ...linea,
            precio_venta: precioFinal,
            subtotal: d.subtotal,
            monto_iva: d.monto_iva,
            total_linea: d.total_linea,
          };
        })
      : items;

  const calc = recalcTotals(itemsFinales);

  const qtyByProduct = new Map<string, number>();
  for (const it of itemsFinales) {
    qtyByProduct.set(it.producto_id, (qtyByProduct.get(it.producto_id) ?? 0) + it.cantidad);
  }

  const sb = createServiceRoleClientWithDbSchema(params.schema);

  // 1) Cliente
  if (params.clienteId) {
    const ck = await sb.from("clientes").select("id").eq("id", params.clienteId).eq("empresa_id", params.empresaId).maybeSingle();
    if (ck.error) throw new Error(ck.error.message);
    if (!ck.data) throw new Error("Cliente no encontrado en esta empresa.");
  }

  // 2) Cargar productos del carrito — TODOS los que existan y pertenezcan a la empresa, sin filtrar controla_stock ni stock>0.
  const ids = [...qtyByProduct.keys()];
  const prodQ = await sb
    .from("productos")
    .select("id, stock_actual, costo_promedio, nombre, sku, controla_stock")
    .eq("empresa_id", params.empresaId)
    .in("id", ids);
  if (prodQ.error) throw new Error(prodQ.error.message);
  const prodRows = (prodQ.data ?? []) as unknown as Array<{
    id: string;
    stock_actual: number | string;
    costo_promedio: number | string;
    nombre: string;
    sku: string;
    controla_stock: boolean | null;
  }>;

  if (prodRows.length !== ids.length) {
    const found = new Set(prodRows.map((r) => r.id));
    const faltantes = ids.filter((id) => !found.has(id));
    throw new Error(
      `Uno o más productos no existen o no pertenecen a esta empresa. IDs no encontrados: ${faltantes.join(", ")}`
    );
  }

  type ProdMeta = { stock: number; costo: number; nombre: string; sku: string; controlaStock: boolean };
  const stockMap = new Map<string, ProdMeta>();
  for (const r of prodRows) {
    stockMap.set(r.id, {
      stock: Number(r.stock_actual),
      costo: Number(r.costo_promedio),
      nombre: r.nombre,
      sku: r.sku,
      controlaStock: r.controla_stock !== false,
    });
  }

  // 3) Falta de stock: se avisa, no se bloquea.
  //
  // Antes esto cortaba la venta. En el mostrador eso es peor que el problema
  // que evita: el cliente ya tiene la cerveza en la mano y el sistema se niega
  // a cobrarla porque el conteo dice cero. El conteo se desfasa solo — una
  // botella que salió sin registrarse, una compra que todavía no se cargó — y
  // la caja no puede quedar rehén de eso.
  //
  // El stock queda en negativo a propósito. Un negativo es la marca visible de
  // que el conteo está mal, y se corrige solo cuando se carga la compra que
  // faltaba. Recortarlo a cero perdería esa información y dejaría el faltante
  // invisible para siempre.
  const faltantes: string[] = [];
  for (const [pid, need] of qtyByProduct) {
    const p = stockMap.get(pid)!;
    if (!p.controlaStock) continue;
    if (p.stock < need) {
      faltantes.push(`${p.nombre} (había ${p.stock}, se vendieron ${need})`);
    }
  }
  if (faltantes.length > 0) {
    console.warn("[venta] se vendió sin stock suficiente", {
      empresa_id: params.empresaId,
      productos: faltantes,
    });
  }

  // 4) Numero control VTA-XXXXXX (best-effort: race posible en entorno multi-usuario).
  const maxQ = await sb
    .from("ventas")
    .select("numero_control")
    .eq("empresa_id", params.empresaId)
    .like("numero_control", "VTA-%")
    .order("numero_control", { ascending: false })
    .limit(1);
  if (maxQ.error) throw new Error(maxQ.error.message);
  let nextNum = 1;
  const lastNum = (maxQ.data?.[0] as { numero_control?: string } | undefined)?.numero_control;
  if (lastNum) {
    const m = lastNum.match(/^VTA-(\d+)$/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }
  const numeroControl = `VTA-${String(nextNum).padStart(6, "0")}`;
  const fechaIso = new Date().toISOString();

  // 5) Insertar venta
  const insVenta = await sb
    .from("ventas")
    .insert({
      empresa_id: params.empresaId,
      cliente_id: params.clienteId,
      numero_control: numeroControl,
      moneda: params.moneda,
      tipo_cambio: params.tipoCambio,
      subtotal: calc.subtotal,
      monto_iva: calc.montoIva,
      total: calc.total,
      // Queda registrado cuánto se descontó y por qué: sin esto el arqueo no
      // cuadra y no hay forma de distinguir un descuento de un faltante.
      descuento: descuentoAplicado,
      descuento_motivo: descuentoAplicado > 0 ? params.descuento?.motivo ?? null : null,
      descuento_autorizado_por: descuentoAplicado > 0 ? params.descuento?.autorizadoPor ?? null : null,
      estado: "completada",
      tipo_venta: params.tipoVenta,
      plazo_dias: params.plazoDias,
      metodo_pago: metodoPredominante(
        armarPagos(params.pagos, params.metodoPago, calc.total),
        params.metodoPago
      ),
      caja_id: params.cajaId,
      fecha: fechaIso,
      observaciones: params.observaciones,
    })
    .select("id")
    .single();
  if (insVenta.error) throw new Error(insVenta.error.message);
  const ventaId = String((insVenta.data as { id: string }).id);

  // Detalle del cobro. Va antes que los ítems para que, si falla, el rollback
  // se lleve una venta que todavía no movió stock. Toda venta guarda su
  // detalle — con una sola forma de pago es una fila — así el cierre de caja
  // tiene una única fuente de verdad para repartir el efectivo.
  const pagosVenta = armarPagos(params.pagos, params.metodoPago, calc.total);
  if (pagosVenta.length > 0) {
    const insPagos = await sb.from("ventas_pagos_detalle").insert(
      pagosVenta.map((p) => ({
        empresa_id: params.empresaId,
        venta_id: ventaId,
        metodo_pago: p.metodo_pago,
        monto: p.monto,
        cuenta_bancaria_id: p.cuenta_bancaria_id ?? null,
        referencia: p.referencia ?? null,
        fecha_pago: fechaIso,
      }))
    );
    if (insPagos.error) {
      try {
        await sb.from("ventas").delete().eq("id", ventaId).eq("empresa_id", params.empresaId);
      } catch {}
      throw new Error(`No se pudo registrar el cobro de la venta: ${insPagos.error.message}`);
    }
  }

  // Helper de rollback best-effort
  const rollback = async () => {
    try {
      await sb.from("movimientos_inventario").delete().eq("venta_id", ventaId).eq("empresa_id", params.empresaId);
    } catch {}
    try {
      await sb.from("ventas_items").delete().eq("venta_id", ventaId).eq("empresa_id", params.empresaId);
    } catch {}
    try {
      await sb.from("ventas").delete().eq("id", ventaId).eq("empresa_id", params.empresaId);
    } catch {}
  };

  try {
    // 6) Insertar items (bulk)
    const itemsRows = itemsFinales.map((line) => ({
      empresa_id: params.empresaId,
      venta_id: ventaId,
      producto_id: line.producto_id,
      producto_nombre: line.producto_nombre,
      sku: line.sku,
      cantidad: line.cantidad,
      precio_venta_original: line.precio_venta_original,
      precio_venta: line.precio_venta,
      tipo_iva: line.tipo_iva,
      subtotal: line.subtotal,
      monto_iva: line.monto_iva,
      total_linea: line.total_linea,
      es_mitad_mitad: line.es_mitad_mitad === true,
      mitad_1_producto_id: line.mitad_1_producto_id ?? null,
      mitad_2_producto_id: line.mitad_2_producto_id ?? null,
      mitad_1_nombre: line.mitad_1_nombre ?? null,
      mitad_2_nombre: line.mitad_2_nombre ?? null,
      item_display_name: line.item_display_name ?? null,
    }));
    const insItems = await sb.from("ventas_items").insert(itemsRows);
    if (insItems.error) throw new Error(insItems.error.message);

    // 7) Descuento de stock + movimientos solo para productos con controla_stock=true.
    for (const line of itemsFinales) {
      const p = stockMap.get(line.producto_id)!;
      if (!p.controlaStock) continue;
      const nuevoStock = p.stock - line.cantidad;
      const upd = await sb
        .from("productos")
        .update({ stock_actual: nuevoStock })
        .eq("id", line.producto_id)
        .eq("empresa_id", params.empresaId);
      if (upd.error) throw new Error(upd.error.message);
      p.stock = nuevoStock;

      const mov = await sb.from("movimientos_inventario").insert({
        empresa_id: params.empresaId,
        producto_id: line.producto_id,
        producto_nombre: line.producto_nombre,
        producto_sku: line.sku,
        tipo: "SALIDA",
        cantidad: line.cantidad,
        costo_unitario: p.costo,
        origen: "venta",
        referencia: numeroControl,
        fecha: fechaIso,
        venta_id: ventaId,
      });
      if (mov.error) throw new Error(mov.error.message);
    }

    // 8) Pedido cocina (tarjeta en proyectos)
    if (params.pedidoCocina) {
      const tipoQ = await sb
        .from("proyecto_tipos")
        .select("id")
        .eq("empresa_id", params.empresaId)
        .eq("codigo", "pedido")
        .eq("activo", true)
        .limit(1)
        .maybeSingle();
      if (tipoQ.error) throw new Error(tipoQ.error.message);
      if (!tipoQ.data) throw new Error("Tipo de proyecto 'pedido' no configurado para esta empresa.");
      const tipoId = (tipoQ.data as { id: string }).id;

      const estadoQ = await sb
        .from("proyecto_estados")
        .select("id")
        .eq("empresa_id", params.empresaId)
        .eq("codigo", "nuevo")
        .eq("activo", true)
        .limit(1)
        .maybeSingle();
      if (estadoQ.error) throw new Error(estadoQ.error.message);
      if (!estadoQ.data) throw new Error("Estado 'nuevo' no configurado para esta empresa.");
      const estadoId = (estadoQ.data as { id: string }).id;

      const itemsSnapshot = itemsFinales.map((it) => ({
        producto_id: it.producto_id,
        producto_nombre: it.producto_nombre,
        sku: it.sku,
        cantidad: it.cantidad,
        precio_venta: it.precio_venta,
        total_linea: it.total_linea,
      }));
      // Sólo delivery lleva costo; en local/retiro se ignora y queda en 0 aunque
      // el cliente lo haya tecleado antes de cambiar de modalidad.
      const costoDelivery =
        params.pedidoCocina.modalidad === "delivery"
          ? Math.max(0, Math.round(Number(params.pedidoCocina.costo_delivery) || 0))
          : 0;
      const briefData = {
        modalidad: params.pedidoCocina.modalidad,
        mesa: params.pedidoCocina.mesa,
        cliente_nombre: params.pedidoCocina.cliente_nombre,
        cliente_telefono: params.pedidoCocina.cliente_telefono,
        direccion_entrega: params.pedidoCocina.direccion_entrega,
        observacion: params.pedidoCocina.observacion,
        // Informativo: NO es ingreso. Va en el pedido, nunca en ventas.total.
        costo_delivery: costoDelivery,
        items: itemsSnapshot,
        venta_id: ventaId,
        numero_control: numeroControl,
        fecha_iso: fechaIso,
      };
      const metadata = {
        source: "venta",
        venta_id: ventaId,
        numero_control: numeroControl,
        modalidad: params.pedidoCocina.modalidad,
      };
      const tituloModalidad =
        params.pedidoCocina.modalidad === "local" ? "Local"
        : params.pedidoCocina.modalidad === "delivery" ? "Delivery"
        : "Retiro";
      const detalle =
        params.pedidoCocina.modalidad === "local" && params.pedidoCocina.mesa
          ? ` · Mesa ${params.pedidoCocina.mesa}`
          : params.pedidoCocina.modalidad === "delivery" && params.pedidoCocina.cliente_nombre
          ? ` · ${params.pedidoCocina.cliente_nombre}`
          : "";
      const titulo = `Venta ${numeroControl} · ${tituloModalidad}${detalle}`.slice(0, 200);

      const insProy = await sb.from("proyectos").insert({
        empresa_id: params.empresaId,
        cliente_id: params.clienteId,
        tipo_id: tipoId,
        estado_id: estadoId,
        titulo,
        prioridad: "normal",
        monto_vendido: params.totalDeclarado,
        fecha_ingreso: fechaIso,
        // El costo de delivery viaja dentro de brief_data (es un dato del
        // pedido, informativo). NO se guarda en `ventas` ni en una columna
        // aparte: no es ingreso del negocio. Los pedidos históricos sin la
        // clave se leen como 0.
        brief_data: briefData,
        metadata,
      });
      if (insProy.error) throw new Error(insProy.error.message);
    }

    return { ventaId, numeroControl, fechaIso };
  } catch (err) {
    await rollback();
    throw err;
  }
}
