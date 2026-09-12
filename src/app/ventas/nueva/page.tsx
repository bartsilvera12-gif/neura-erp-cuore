"use client";

import { AlertTriangle, Minus, Pizza, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import MontoInput from "@/components/ui/MontoInput";
import ProductPickerModal, { type ProductoPickerItem, type AgregarVentaPayload } from "@/components/inventario/ProductPickerModal";
import SmartSearchSelect, { type SmartOption } from "@/components/ui/SmartSearchSelect";
import MitadMitadPicker, { type MitadMitadResult } from "@/components/ventas/MitadMitadPicker";
import SelectorComprobante, {
  comprobanteListo,
  type TipoComprobante,
} from "@/components/ventas/SelectorComprobante";
import {
  RECEPTOR_VACIO,
  receptorAPayload,
  validarReceptor,
  type DatosReceptor,
} from "@/components/ventas/ReceptorFactura";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import CobroRepartido, {
  cobroValido,
  montoDeLinea,
  totalCobrado,
  type LineaCobro,
} from "@/components/ventas/CobroRepartido";
import { saveVenta } from "@/lib/ventas/storage";
import { getCajaAbierta } from "@/lib/caja/storage";
import { calcularLineaVenta } from "@/lib/ventas/iva";
import { sectoresParaTicket } from "@/lib/ventas/sector-tickets";
import { getProductos } from "@/lib/inventario/storage";
import type { TipoIvaVenta, TipoVenta, MonedaVenta, LineaVenta, MetodoPago } from "@/lib/ventas/types";
import type { Producto } from "@/lib/inventario/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

// IVA INCLUIDO: el precio ya contiene el impuesto. El desglose vive en
// `@/lib/ventas/iva` (misma fórmula que usa el backend autoritativo).

// ── Estilos ────────────────────────────────────────────────────────────────────

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";

// ── Sub-componentes ───────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
      {children}
    </p>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function NuevaVentaPage() {
  const router = useRouter();

  // ── Estado global ──────────────────────────────────────────────────────────
  const [productos, setProductos]   = useState<Producto[]>([]);
  const [items, setItems]           = useState<LineaVenta[]>([]);
  const [errorLinea, setErrorLinea] = useState<string | null>(null);
  /**
   * Falta de stock. Avisa, no frena: el conteo se desfasa solo y la caja no
   * puede quedar rehén de eso. Va aparte del error justamente para que se lea
   * distinto — esto no impide cobrar.
   */
  const [avisoStock, setAvisoStock] = useState<string | null>(null);
  const [errorVenta, setErrorVenta] = useState<string | null>(null);
  // Caja por turno: sin caja abierta no se puede confirmar la venta.
  const [sinCaja, setSinCaja] = useState(false);

  // ── Condiciones de la venta (fijas para Cucina del Cuore) ────────────────────
  // Instancia dedicada: siempre Guaraníes + Contado.
  const moneda: MonedaVenta = "GS";
  const tipoVenta: TipoVenta = "CONTADO";

  // Pedidos (gastronomía): modalidad obligatoria en instancia Cucina del Cuore
  type Modalidad = "local" | "delivery" | "carry_out";
  const [modalidad, setModalidad] = useState<Modalidad | "">("");
  const [comprobante, setComprobante] = useState<TipoComprobante>("ticket");
  const [receptor, setReceptor] = useState<DatosReceptor>(RECEPTOR_VACIO);
  const [pedidoMesa, setPedidoMesa] = useState("");
  const [pedidoClienteNombre, setPedidoClienteNombre] = useState("");
  const [pedidoClienteTelefono, setPedidoClienteTelefono] = useState("");
  const [pedidoDireccion, setPedidoDireccion] = useState("");
  const [pedidoObservacion, setPedidoObservacion] = useState("");
  /**
   * Costo de delivery informado al cliente. Pass-through: NO es ingreso del
   * negocio, así que no se suma al TOTAL contable ni al cobro. Sólo se muestra
   * y se guarda cuando la modalidad es delivery.
   */
  const [costoDelivery, setCostoDelivery] = useState(0);

  // ── Cobro (solo CONTADO, no se persiste — solo ayuda al cajero) ───────────
  const [montoRecibido, setMontoRecibido] = useState("");
  /**
   * Formas de pago del cobro. Arranca en una sola —efectivo— porque así se
   * cobra casi siempre; el monto de esa única línea lo cubre el total.
   */
  const [lineasCobro, setLineasCobro] = useState<LineaCobro[]>([
    { key: "p0", metodo: "efectivo", monto: "" },
  ]);
  const metodoPago: MetodoPago = lineasCobro[0]?.metodo ?? "efectivo";

  // ── IVA por defecto de las líneas nuevas ──────────────────────────────────
  // Ya no hay "línea en construcción": el producto se agrega al carrito apenas
  // se lo elige en el buscador, y cantidad, precio e IVA se ajustan sobre la
  // fila. Un paso menos por producto, que en caja se nota.
  const lineaIva: TipoIvaVenta = "10%";

  // ── Buscador de producto ──────────────────────────────────────────────────
  // Señal para que el buscador tome el foco al entrar a la pantalla. Después de
  // cada alta el propio buscador se queda con el foco, así que no hace falta
  // volver a emitirla.
  const focoBuscador = 1;

  // ── Modal buscador avanzado (catálogo con imagen y filtros) ───────────────
  // Ya no arranca abierto: el buscador inline toma el foco al entrar, así el
  // cajero puede tipear de una sin que un modal le tape la pantalla. El modal
  // queda como alternativa, detrás del botón "Buscar".
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mitadOpen, setMitadOpen] = useState(false);

  /** Agrega una pizza mitad y mitad como una línea (precio = max de ambos sabores). */
  function handleAgregarMitad(r: MitadMitadResult) {
    const { subtotal, monto_iva: montoIva, total_linea: totalLinea } = calcularLineaVenta(r.precio_unitario, 1, "10%");
    setItems((prev) => [
      ...prev,
      {
        producto_id: r.producto_id,
        producto_nombre: r.display_name,
        sku: r.sku,
        cantidad: 1,
        precio_venta_original: r.precio_unitario,
        precio_venta: r.precio_unitario,
        tipo_iva: "10%",
        subtotal,
        monto_iva: montoIva,
        total_linea: totalLinea,
        sector_produccion: "pizzeria",
        es_mitad_mitad: true,
        mitad_1_producto_id: r.mitad.producto1_id,
        mitad_2_producto_id: r.mitad.producto2_id,
        mitad_1_nombre: r.mitad.nombre1,
        mitad_2_nombre: r.mitad.nombre2,
        item_display_name: r.display_name,
      },
    ]);
    setErrorVenta(null);
    setMitadOpen(false);
  }

  function pickerToProducto(p: ProductoPickerItem): Producto {
    return {
      id: p.id,
      nombre: p.nombre,
      sku: p.sku,
      precio_venta: p.precio_venta,
      stock_actual: p.stock_actual,
      unidad_medida: p.unidad_medida,
      costo_promedio: 0,
      stock_minimo: 0,
      metodo_valuacion: "CPP",
      codigo_barras: p.codigo_barras,
      codigo_barras_interno: p.codigo_barras_interno,
      imagen_path: null,
      imagen_url: p.imagen_url,
    };
  }

  /**
   * Agregado directo desde el modal: arma la LineaVenta usando la misma
   * logica que handleAgregarLinea pero con datos del modal, sin pasar
   * por el form inline. Mantiene el modal abierto si todo OK.
   */
  function handleAgregarDesdePicker(payload: AgregarVentaPayload): boolean {
    const { producto: p, cantidad, precio_input, iva } = payload;
    const precioPyg = precio_input;
    // Verificar stock vs lo ya cargado SOLO si el producto controla stock.
    // Productos del Menú (controla_stock=false) no validan stock.
    const ctrlStock = (p as { controla_stock?: boolean }).controla_stock !== false;
    if (ctrlStock) {
      const yaEnCarrito = items.filter((i) => i.producto_id === p.id).reduce((s, i) => s + i.cantidad, 0);
      const disp = p.stock_actual - yaEnCarrito;
      if (cantidad > disp) {
        return false;
      }
    }
    // IVA incluido: total = precio × cantidad; el IVA se deduce, no se suma.
    const { subtotal, monto_iva: montoIva, total_linea: totalLinea } =
      calcularLineaVenta(precioPyg, cantidad, iva);

    // Asegurar que el producto este en el array local (para que stock_actual
    // se conozca en validaciones posteriores del form inline).
    const prodLocal = pickerToProducto(p);
    setProductos((prev) => (prev.find((x) => x.id === prodLocal.id) ? prev : [...prev, prodLocal]));

    setItems((prev) => [
      ...prev,
      {
        producto_id: p.id,
        producto_nombre: p.nombre,
        sku: p.sku,
        cantidad,
        precio_venta_original: precio_input,
        precio_venta: precioPyg,
        tipo_iva: iva,
        subtotal,
        monto_iva: montoIva,
        total_linea: totalLinea,
      },
    ]);
    setErrorVenta(null);
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    getProductos().then((data) => {
      if (!cancelled) setProductos(data);
    });
    return () => { cancelled = true; };
  }, []);

  // Verificar que haya una caja abierta; si no, bloquear y avisar.
  useEffect(() => {
    let cancelled = false;
    getCajaAbierta().then((c) => {
      if (!cancelled) setSinCaja(!c);
    });
    return () => { cancelled = true; };
  }, []);

  // El costo de delivery sólo existe en modalidad delivery. Si el cajero cargó
  // un monto y después pasa a Local o Retiro, se limpia para que no viaje al
  // servidor ni se muestre en el resumen.
  useEffect(() => {
    if (modalidad !== "delivery") setCostoDelivery(0);
  }, [modalidad]);

  // ── Cálculos ───────────────────────────────────────────────────────────────
  const tipoCambioNum = 1;


  const totalSubtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const totalIva      = items.reduce((s, i) => s + i.monto_iva, 0);
  const totalGeneral  = items.reduce((s, i) => s + i.total_linea, 0);
  // Solo la modalidad es obligatoria; los datos de cada modalidad (mesa,
  // teléfono, dirección, etc.) son opcionales para no frenar el cobro en caja.
  /**
   * Qué se le entrega al cliente. Ticket es el default porque en el mostrador
   * la enorme mayoría de las ventas no lleva factura; la factura se emite sólo
   * cuando la piden, con los datos del receptor que exige el SET.
   */
  const comprobanteValido = comprobanteListo(comprobante, receptor);
  const pedidoValido = modalidad !== "" && comprobanteValido;
  const cobroCierra = tipoVenta !== "CONTADO" || cobroValido(lineasCobro, totalGeneral);
  const ventaValida   = items.length > 0 && pedidoValido && !sinCaja && cobroCierra;

  // Vuelto (solo informativo, no se persiste)
  const montoRecibidoNum = parseFloat(montoRecibido) || 0;
  /** Parte del cobro que se paga en efectivo: es contra eso que se da vuelto. */
  const aPagarEnEfectivo =
    lineasCobro.length > 1
      ? totalCobrado(lineasCobro.filter((l) => l.metodo === "efectivo"))
      : totalGeneral;
  const vuelto           = montoRecibidoNum - aPagarEnEfectivo;

  // ── Opciones del buscador ─────────────────────────────────────────────────
  // Solo vendibles (Reventa + Menú). Excluye materia prima / insumos.
  //
  // El filtrado ya no se hace acá: SmartSearchSelect busca por varios términos
  // sin orden y sin acentos, en nombre y SKU. Antes era un `includes` de un solo
  // término, así que "coca 500" no encontraba "COCA COLA 500ML".
  const productosVendibles = productos.filter((p) => p.es_vendible !== false);

  const opcionesProducto: SmartOption[] = productosVendibles.map((p) => {
    const enCarro = items.filter((i) => i.producto_id === p.id).reduce((s, i) => s + i.cantidad, 0);
    const controla = p.controla_stock !== false;
    const disponible = p.stock_actual - enCarro;
    const sinStock = controla && disponible <= 0;
    // Sin stock se puede elegir igual: el conteo del sistema se atrasa y no
    // puede impedir cobrar algo que está en la heladera. Se avisa en el
    // subtítulo, que es lo que el cajero lee al elegir.
    return {
      id: String(p.id),
      label: p.nombre,
      sub: controla
        ? `${p.sku} · ${sinStock ? `sin stock (${disponible} u.)` : `${disponible} u. disp.`}`
        : `${p.sku} · Menú`,
      keywords: p.sku,
      trailing: formatGs(p.precio_venta),
    };
  });

  /**
   * Elegir en el buscador ya agrega el producto a la venta, con cantidad 1 y su
   * precio de lista. Si ya estaba en el carrito suma una unidad en vez de
   * repetir la fila, que es lo que espera cualquiera que escanea o busca dos
   * veces el mismo ítem.
   */
  function agregarProductoPorId(id: string) {
    const p = productosVendibles.find((x) => String(x.id) === id);
    if (!p) return;
    setErrorLinea(null);

    const yaIdx = items.findIndex((i) => i.producto_id === p.id && !i.es_mitad_mitad);
    const yaEnCarrito = items
      .filter((i) => i.producto_id === p.id)
      .reduce((s, i) => s + i.cantidad, 0);

    // El Menú (controla_stock=false) se vende sin restricción: se produce al momento.
    // La Reventa sin stock también se vende, pero avisando.
    if (p.controla_stock !== false && yaEnCarrito + 1 > p.stock_actual) {
      setAvisoStock(
        `"${p.nombre}" figura con ${p.stock_actual} u. en el sistema. Se vende igual y el stock queda en negativo.`
      );
    } else {
      setAvisoStock(null);
    }

    if (yaIdx >= 0) {
      cambiarCantidad(yaIdx, 1);
      return;
    }

    const d = calcularLineaVenta(p.precio_venta, 1, lineaIva);
    setItems((prev) => [
      ...prev,
      {
        producto_id: p.id,
        producto_nombre: p.nombre,
        sku: p.sku,
        cantidad: 1,
        precio_venta_original: p.precio_venta,
        precio_venta: p.precio_venta,
        tipo_iva: lineaIva,
        subtotal: d.subtotal,
        monto_iva: d.monto_iva,
        total_linea: d.total_linea,
      },
    ]);
    setErrorVenta(null);
  }

  /** Recalcula el desglose de una fila después de tocarle cantidad, precio o IVA. */
  function actualizarLinea(idx: number, patch: { cantidad?: number; precio_venta?: number; tipo_iva?: TipoIvaVenta }) {
    setItems((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const cantidad = patch.cantidad ?? l.cantidad;
        const precio = patch.precio_venta ?? l.precio_venta;
        const iva = patch.tipo_iva ?? l.tipo_iva;
        const d = calcularLineaVenta(precio, cantidad, iva);
        return {
          ...l,
          cantidad,
          precio_venta: precio,
          precio_venta_original: precio,
          tipo_iva: iva,
          subtotal: d.subtotal,
          monto_iva: d.monto_iva,
          total_linea: d.total_linea,
        };
      })
    );
  }

  /**
   * Suma o resta unidades. Corta contra el stock disponible salvo para el Menú,
   * y en 1 por abajo: para sacar la línea está el botón de borrar.
   */
  function cambiarCantidad(idx: number, delta: number) {
    const l = items[idx];
    if (!l) return;
    const destino = l.cantidad + delta;
    if (destino < 1) return;

    const prod = productos.find((x) => x.id === l.producto_id);
    const controla = prod ? prod.controla_stock !== false : false;
    if (controla && prod && delta > 0) {
      const otras = items
        .filter((_, i) => i !== idx)
        .filter((i) => i.producto_id === l.producto_id)
        .reduce((s, i) => s + i.cantidad, 0);
      if (otras + destino > prod.stock_actual) {
        setAvisoStock(
          `"${l.producto_nombre}" figura con ${prod.stock_actual} u. en el sistema. Se vende igual y el stock queda en negativo.`
        );
      } else {
        setAvisoStock(null);
      }
    }
    setErrorLinea(null);
    actualizarLinea(idx, { cantidad: destino });
  }


  function handleEliminarLinea(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorVenta(null);
    if (!ventaValida) return;

    // Pre-abrimos una pestaña en blanco por cada copia (Cliente / Pizzería /
    // Plancha) ANTES del await, mientras todavía hay gesto del usuario: así el
    // navegador no bloquea la apertura de varias pestañas. Luego las redirigimos.
    // Con factura el cliente se lleva el KUDE, no un ticket: se abren sólo las
    // copias de cocina, que hacen falta igual.
    const copiasTicket = sectoresParaTicket(items, comprobante !== "factura");
    const ventanasTicket = copiasTicket.map(() => {
      try { return window.open("about:blank", "_blank"); } catch { return null; }
    });

    const resultado = await saveVenta(
      {
        items,
        moneda,
        tipo_cambio:  tipoCambioNum,
        subtotal:     totalSubtotal,
        monto_iva:    totalIva,
        total:        totalGeneral,
        tipo_venta:   tipoVenta,
        metodo_pago:  metodoPago,
        pagos:
          lineasCobro.length > 1
            ? lineasCobro
                .filter((l) => montoDeLinea(l) > 0)
                .map((l) => ({ metodo_pago: l.metodo, monto: montoDeLinea(l) }))
            : [],
      },
      {
        // ventaValida garantiza modalidad !== "" en este punto.
        modalidad,
        mesa: modalidad === "local" ? pedidoMesa.trim() || null : null,
        cliente_nombre: pedidoClienteNombre.trim() || null,
        cliente_telefono: pedidoClienteTelefono.trim() || null,
        direccion_entrega: pedidoDireccion.trim() || null,
        observacion: pedidoObservacion.trim() || null,
        // Sólo delivery lleva costo; en el resto va 0 (el server lo revalida).
        costo_delivery: modalidad === "delivery" ? costoDelivery : 0,
      }
    );

    if (!resultado.success) {
      // Cerramos las pestañas que abrimos optimistamente si la venta no se guardó.
      ventanasTicket.forEach((w) => { try { w?.close(); } catch {} });
      setErrorVenta(resultado.error);
      return;
    }
    // Apuntar cada pestaña pre-abierta a su copia, con auto-impresión.
    const ventaId = resultado.venta.id;
    copiasTicket.forEach((copia, i) => {
      const href = `/api/ventas/${ventaId}/ticket?copia=${copia}&auto=1`;
      const w = ventanasTicket[i];
      try {
        if (w) w.location.href = href;
        else window.open(href, "_blank", "noopener"); // fallback si el pre-open falló
      } catch {}
    });

    // La factura se emite después de la venta y no junto con ella: si algo
    // falla emitiendo, la venta ya está cobrada y la comida ya salió a cocina.
    // El cajero puede reintentar desde el listado sin perder nada.
    if (comprobante === "factura") {
      try {
        const res = await fetchWithSupabaseSession(`/api/ventas/${ventaId}/facturar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(receptorAPayload(receptor)),
        });
        const body = await res.json();
        if (res.ok && body?.success !== false && body?.data?.facturaId) {
          // El comprobante de una factura es el KUDE: la pantalla lo abre sola
          // apenas el documento queda aprobado por el SET.
          //
          // `auto=1` encola el trámite en el servidor en vez de hacerlo desde
          // el navegador paso a paso. Antes el cajero tenía que apretar
          // "Generar y enviar" y quedarse mirando unos 20 segundos; ahora el
          // worker lo resuelve solo y la pantalla se entera sola. El tiempo del
          // SET sigue siendo el que es, pero deja de ser cola en el mostrador.
          router.push(`/facturas/${body.data.facturaId}?kude=1&auto=1`);
          return;
        }
        setErrorVenta(
          `La venta ${resultado.venta.numero_control} se registró, pero no se pudo emitir la factura: ${
            body?.error ?? "error desconocido"
          }. Emitila desde el listado de ventas.`
        );
        return;
      } catch {
        setErrorVenta(
          `La venta ${resultado.venta.numero_control} se registró, pero no se pudo emitir la factura. Emitila desde el listado de ventas.`
        );
        return;
      }
    }

    router.push("/ventas");
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">

      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">Nueva venta</h1>
        <p className="text-gray-600">
          Agregá productos del menú o reventa. Al confirmar se registra la venta y se genera el pedido.
        </p>
      </div>

      {sinCaja && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">
            <AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> No hay caja abierta. Para vender primero tenés que abrir caja.
          </p>
          <button
            type="button"
            onClick={() => router.push("/ventas")}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
          >
            Ir a abrir caja
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 max-w-7xl">

        {/* ── Datos del pedido ─────────────────────────────────────────────
            Va primero y en su propia tarjeta porque define el resto: sin
            modalidad no se puede confirmar, y de ella dependen mesa, dirección
            o nombre de retiro. Antes vivía al final del carrito, después de los
            totales, donde era fácil pasarla por alto. */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6">
          <SectionTitle>Datos del pedido</SectionTitle>
          <div>
            <div>
              <p className="text-sm font-semibold text-slate-800 mb-3">
                Modalidad del pedido <span className="text-red-500">*</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([
                  { v: "local",     label: "En local" },
                  { v: "delivery",  label: "Delivery" },
                  { v: "carry_out", label: "Retiro / Carry out" },
                ] as Array<{ v: Modalidad; label: string }>).map((opt) => (
                  <label
                    key={opt.v}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer transition ${
                      modalidad === opt.v
                        ? "border-amber-500 bg-white text-amber-700 font-medium"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="modalidad"
                      value={opt.v}
                      checked={modalidad === opt.v}
                      onChange={() => setModalidad(opt.v)}
                      className="h-4 w-4 text-amber-600 focus:ring-amber-500"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
  
              {modalidad === "local" && (
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Número de mesa</label>
                    <input
                      type="text"
                      value={pedidoMesa}
                      onChange={(e) => setPedidoMesa(e.target.value)}
                      placeholder="Opcional — ej: 3"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Observación</label>
                    <input
                      type="text"
                      value={pedidoObservacion}
                      onChange={(e) => setPedidoObservacion(e.target.value)}
                      placeholder='Ej: "sin cebolla"'
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
  
              {modalidad === "delivery" && (
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Nombre cliente</label>
                    <input
                      type="text"
                      value={pedidoClienteNombre}
                      onChange={(e) => setPedidoClienteNombre(e.target.value)}
                      placeholder="Opcional"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Teléfono
                    </label>
                    <input
                      type="text"
                      value={pedidoClienteTelefono}
                      onChange={(e) => setPedidoClienteTelefono(e.target.value)}
                      placeholder="09xx xxx xxx"
                      className={inputClass}
                    />
                  </div>
                  <div className="lg:col-span-2">
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Dirección de entrega
                    </label>
                    <input
                      type="text"
                      value={pedidoDireccion}
                      onChange={(e) => setPedidoDireccion(e.target.value)}
                      placeholder="Calle, número, referencia"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Costo de delivery (Gs.)
                    </label>
                    <MontoInput
                      value={costoDelivery === 0 ? "" : costoDelivery}
                      onChange={(n) => setCostoDelivery(Math.max(0, Math.round(n)))}
                      placeholder="Ej: 15.000"
                      className={inputClass}
                      decimals={false}
                    />
                    <p className="mt-1 text-[11px] text-slate-400">
                      No es ingreso del negocio: se le informa al cliente pero no
                      entra en el total de la venta.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Observación</label>
                    <input
                      type="text"
                      value={pedidoObservacion}
                      onChange={(e) => setPedidoObservacion(e.target.value)}
                      placeholder="Notas para el repartidor o la cocina"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
  
              {modalidad === "carry_out" && (
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Nombre cliente</label>
                    <input
                      type="text"
                      value={pedidoClienteNombre}
                      onChange={(e) => setPedidoClienteNombre(e.target.value)}
                      placeholder="Opcional"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Teléfono</label>
                    <input
                      type="text"
                      value={pedidoClienteTelefono}
                      onChange={(e) => setPedidoClienteTelefono(e.target.value)}
                      placeholder="Opcional"
                      className={inputClass}
                    />
                  </div>
                  <div className="lg:col-span-2">
                    <label className="block text-xs font-medium text-slate-600 mb-1">Observación</label>
                    <input
                      type="text"
                      value={pedidoObservacion}
                      onChange={(e) => setPedidoObservacion(e.target.value)}
                      placeholder='Ej: "pasa en 20 min"'
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
  
              {modalidad === "" && (
                <p className="mt-2 text-xs text-amber-700">
                  Elegí una modalidad antes de confirmar la venta.
                </p>
              )}
            </div>

            {/* Selector de comprobante ocultado a pedido del cliente
                (Cucina del Cuore usa sólo ticket por ahora). El estado
                `comprobante` sigue arrancando en "ticket" (default), así
                que la venta se sigue registrando con ese tipo.
                Descomentar el bloque de abajo cuando quieran habilitar
                Factura.

            <div className="mt-6 border-t border-slate-100 pt-5">
              <p className="mb-3 text-sm font-semibold text-slate-800">
                Comprobante <span className="text-red-500">*</span>
              </p>
              <SelectorComprobante
                valor={comprobante}
                onChange={setComprobante}
                receptor={receptor}
                onReceptorChange={setReceptor}
              />
            </div>
            */}
          </div>
        </div>

        {/* ── Carrito: buscar, ajustar, cobrar ────────────────────────────── */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 [&>p]:mb-0">
            <SectionTitle>Productos en esta venta</SectionTitle>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setMitadOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                title="Armar una pizza con dos sabores"
              >
                <Pizza className="h-4 w-4" aria-hidden />
                Pizza mitad y mitad
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-[#4FAEB2] hover:text-[#3F8E91]"
                title="Buscador avanzado: catálogo con imágenes y filtros"
              >
                Buscador avanzado
              </button>
            </div>
          </div>

          {/* El buscador es la acción principal de la pantalla: elegir un producto
              lo agrega al instante y deja el foco listo para el siguiente. */}
          <SmartSearchSelect
            variant="buscador"
            options={opcionesProducto}
            value=""
            onChange={agregarProductoPorId}
            placeholder="Buscar producto por nombre o SKU…"
            emptyText="Ningún producto coincide"
            focusSignal={focoBuscador}
          />

          {errorLinea && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              <span className="font-medium">{errorLinea}</span>
            </div>
          )}

          {avisoStock && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
              <span>
                <span className="font-medium">{avisoStock}</span>{" "}
                Revisá el conteo o cargá la compra que falte.
              </span>
            </div>
          )}

          {items.length === 0 ? (
            <div className="mt-4 rounded-xl border-2 border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
              Buscá un producto arriba y se agrega solo a la venta.
            </div>
          ) : (
            <>
              {/* min-w fuerza scroll horizontal en mobile (9 columnas).
                  Columnas secundarias (SKU, Subtotal, IVA Gs) se ocultan
                  progresivamente: en mobile solo Producto/Cant/Precio/Total/eliminar. */}
              <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="bg-slate-50">
                    <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-3">Producto</th>
                      <th className="hidden px-3 py-3 lg:table-cell">SKU</th>
                      <th className="px-3 py-3 text-center">Cant.</th>
                      <th className="px-3 py-3 text-right">Precio unit.</th>
                      <th className="hidden px-3 py-3 text-center lg:table-cell">IVA</th>
                      <th className="hidden px-3 py-3 text-right lg:table-cell">Gravada</th>
                      <th className="hidden px-3 py-3 text-right lg:table-cell">IVA Gs.</th>
                      <th className="px-3 py-3 text-right">Total</th>
                      <th className="px-3 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((item, idx) => (
                      <tr key={idx} className="transition-colors hover:bg-slate-50/70">
                        <td className="px-3 py-3 font-medium text-slate-800">
                          {item.producto_nombre}
                          {item.es_mitad_mitad && item.mitad_1_nombre && item.mitad_2_nombre && (
                            <span className="block text-xs font-normal text-amber-700">½ {item.mitad_1_nombre} + ½ {item.mitad_2_nombre}</span>
                          )}
                        </td>
                        <td className="hidden px-3 py-3 font-mono text-xs text-slate-500 lg:table-cell">
                          {item.sku}
                        </td>
                        {/* Cantidad: se ajusta acá, no antes de agregar. */}
                        <td className="px-3 py-3">
                          <div className="mx-auto inline-flex items-center rounded-lg border border-slate-200 bg-white">
                            <button
                              type="button"
                              onClick={() => cambiarCantidad(idx, -1)}
                              disabled={item.cantidad <= 1}
                              className="flex h-8 w-8 items-center justify-center rounded-l-lg text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-40"
                              aria-label="Quitar una unidad"
                            >
                              <Minus className="h-3.5 w-3.5" aria-hidden />
                            </button>
                            <span className="w-10 text-center text-sm font-semibold tabular-nums text-slate-800">
                              {item.cantidad}
                            </span>
                            <button
                              type="button"
                              onClick={() => cambiarCantidad(idx, 1)}
                              className="flex h-8 w-8 items-center justify-center rounded-r-lg text-slate-500 transition-colors hover:bg-slate-100"
                              aria-label="Agregar una unidad"
                            >
                              <Plus className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <MontoInput
                            value={String(item.precio_venta)}
                            onChange={(n) => actualizarLinea(idx, { precio_venta: Number(n) || 0 })}
                            className="w-28 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-right text-sm tabular-nums outline-none transition-colors focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                          />
                        </td>
                        <td className="hidden px-3 py-3 text-center lg:table-cell">
                          <select
                            value={item.tipo_iva}
                            onChange={(e) => actualizarLinea(idx, { tipo_iva: e.target.value as TipoIvaVenta })}
                            aria-label={`IVA de ${item.producto_nombre}`}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-600 outline-none transition-colors focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                          >
                            <option value="EXENTA">Exenta</option>
                            <option value="5%">5%</option>
                            <option value="10%">10%</option>
                          </select>
                        </td>
                        <td className="hidden px-3 py-3 text-right text-xs tabular-nums text-slate-600 lg:table-cell">
                          {formatGs(item.subtotal)}
                        </td>
                        <td className="hidden px-3 py-3 text-right text-xs tabular-nums text-slate-500 lg:table-cell">
                          {item.monto_iva > 0 ? formatGs(item.monto_iva) : "—"}
                        </td>
                        <td className="px-3 py-3 text-right font-semibold tabular-nums text-slate-800">
                          {formatGs(item.total_linea)}
                        </td>
                        <td className="px-3 py-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleEliminarLinea(idx)}
                            className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] text-red-400 hover:text-red-700 transition-colors rounded hover:bg-red-50"
                            title="Eliminar producto"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                              <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totales + Cobro (vuelto) */}
              <div className="mt-5 flex justify-end">
                <div className="w-full space-y-3 lg:w-80">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>Subtotal</span>
                      <span className="tabular-nums font-medium">{formatGs(totalSubtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>IVA</span>
                      <span className="tabular-nums font-medium">
                        {totalIva > 0 ? formatGs(totalIva) : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between text-base font-bold text-gray-900 pt-2 border-t border-gray-200">
                      <span>TOTAL</span>
                      <span className="tabular-nums">{formatGs(totalGeneral)}</span>
                    </div>
                    {/* Delivery: informativo. El TOTAL de arriba es la venta real
                        del negocio (lo que va a caja/IVA/reportes); esto es lo que
                        se le cobra de más al cliente por el envío. */}
                    {modalidad === "delivery" && (
                      <>
                        <div className="flex justify-between text-sm text-gray-600 pt-2">
                          <span>Delivery</span>
                          <span className="tabular-nums font-medium">{formatGs(costoDelivery)}</span>
                        </div>
                        <div className="flex justify-between text-base font-bold text-amber-700 pt-2 border-t border-gray-200">
                          <span>Total a cobrar al cliente</span>
                          <span className="tabular-nums">{formatGs(totalGeneral + costoDelivery)}</span>
                        </div>
                      </>
                    )}
                  </div>

                  {tipoVenta === "CONTADO" && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                        Cobro
                      </p>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Método de pago</label>
                        <CobroRepartido
                          lineas={lineasCobro}
                          onChange={setLineasCobro}
                          total={totalGeneral}
                          inputClass={inputClass}
                        />
                      </div>
                      <div className={lineasCobro.some((l) => l.metodo === "efectivo") ? "" : "hidden"}>
                        <label className="block text-xs text-gray-600 mb-1">
                          {lineasCobro.length > 1 ? "Efectivo recibido (Gs.)" : "Monto recibido (Gs.)"}
                        </label>
                        <MontoInput
                          value={montoRecibido}
                          onChange={(n) => setMontoRecibido(String(n))}
                          placeholder="Ej: 100.000"
                          className={inputClass}
                          decimals={false}
                        />
                      </div>
                      {montoRecibidoNum > 0 && (
                        <div className="flex justify-between text-sm pt-2 border-t border-slate-200">
                          {vuelto >= 0 ? (
                            <>
                              <span className="text-gray-600">Vuelto</span>
                              <span className="font-bold text-emerald-600 tabular-nums">
                                {formatGs(vuelto)}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-gray-600">Falta</span>
                              <span className="font-bold text-red-600 tabular-nums">
                                {formatGs(Math.abs(vuelto))}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                      <p className="text-[11px] text-gray-400 leading-snug">
                        Cálculo solo informativo — no se guarda en la venta.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Error confirmar */}
          {errorVenta && (
            <div className="mt-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700">
              <span className="text-base leading-none mt-0.5"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /></span>
              <span className="font-medium">{errorVenta}</span>
            </div>
          )}

          {/* Acciones — stack vertical full-width en mobile (mas facil de tappear),
              fila en sm+. Confirmar en orden visual primero (primary). */}
          <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => router.push("/ventas")}
              className="min-h-[48px] w-full rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 sm:w-auto"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!ventaValida}
              className="min-h-[48px] w-full rounded-xl bg-[#4FAEB2] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#3F8E91] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
            >
              Confirmar venta
            </button>
          </div>

        </div>

      </form>

      <ProductPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAgregar={handleAgregarDesdePicker}
        excludeIds={items.map((i) => i.producto_id)}
        moneda={moneda}
        tipoCambio={tipoCambioNum}
        ivaDefault={lineaIva}
      />

      <MitadMitadPicker open={mitadOpen} onClose={() => setMitadOpen(false)} onConfirm={handleAgregarMitad} />
    </div>
  );
}
