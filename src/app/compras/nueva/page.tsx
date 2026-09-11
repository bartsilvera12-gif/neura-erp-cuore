"use client";

import SelectField from "@/components/ui/SelectField";
import SmartSearchSelect, { type SmartOption } from "@/components/ui/SmartSearchSelect";
import { AlertTriangle, Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import MontoInput from "@/components/ui/MontoInput";
import { saveCompraMultilinea, type CompraLinea } from "@/lib/compras/storage";
import { getProveedores, proveedorExiste, createProveedor } from "@/lib/proveedores/storage";
import {
  getProductos,
  productoExiste,
  saveProducto,
} from "@/lib/inventario/storage";
import type { TipoIva, TipoPago, Moneda } from "@/lib/compras/types";
import type { Proveedor } from "@/lib/proveedores/types";
import type { MetodoValuacion, Producto } from "@/lib/inventario/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatGs(valor: number) {
  return `Gs. ${valor.toLocaleString("es-PY")}`;
}

/**
 * Una línea del borrador. El costo se guarda en la moneda de la factura, no en
 * guaraníes: si después se corrige el tipo de cambio, todas las líneas ya
 * cargadas se recalculan solas en vez de quedar con el valor viejo.
 */
type LineaCompra = {
  key: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  costo_unitario_original: number;
  iva_tipo: TipoIva;
  precio_venta: number;
};

/** Números derivados de una línea, con el IVA incluido en el costo. */
function calcularLinea(l: LineaCompra, tipoCambio: number) {
  const costoPYG = l.costo_unitario_original * tipoCambio;
  const total = l.cantidad * costoPYG;
  const montoIva =
    l.iva_tipo === "exenta" ? 0 : l.iva_tipo === "5" ? total / 21 : total / 11;
  return {
    costoPYG,
    total,
    montoIva,
    subtotal: total - montoIva,
    margen:
      l.precio_venta > 0 && costoPYG > 0
        ? ((l.precio_venta - costoPYG) / l.precio_venta) * 100
        : 0,
  };
}

function margenColor(m: number) {
  if (m >= 40) return "text-green-600";
  if (m >= 20) return "text-yellow-600";
  return "text-red-600";
}

// ── Estilos ────────────────────────────────────────────────────────────────────

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const inputSmClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white text-sm";
const labelClass = "block text-sm font-medium text-slate-700 mb-2";
const labelSmClass = "block text-xs font-medium text-slate-600 mb-1.5";

// ── SegmentedControl ───────────────────────────────────────────────────────────

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  small = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className="flex border border-slate-200 rounded-lg overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 font-medium transition-colors ${
            small ? "py-2 text-xs" : "py-2.5 text-sm"
          } ${
            value === opt.value
              ? "bg-[#0EA5E9] text-white"
              : "bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function NuevaCompraPage() {
  const router = useRouter();

  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);

  // ── Formulario principal ─────────────────────────────────────────────────

  const [form, setForm] = useState({
    proveedor_id: "",
    producto_id: "",
    nro_timbrado: "",
    cantidad: "",
    moneda: "PYG" as Moneda,
    tipo_cambio: "",
    costo_unitario_input: "",
    iva_tipo: "10" as TipoIva,
    precio_venta: "",
    tipo_pago: "contado" as TipoPago,
    plazo_dias: "",
  });

  // ── Estado inline: PROVEEDOR ─────────────────────────────────────────────

  const [mostrarFormProveedor, setMostrarFormProveedor] = useState(false);
  const [formProveedor, setFormProveedor] = useState({
    nombre: "", ruc: "", telefono: "", email: "", contacto: "",
  });
  const [errorRuc, setErrorRuc] = useState<string | null>(null);
  const [proveedorCreado, setProveedorCreado] = useState<string | null>(null);

  // ── Estado inline: PRODUCTO ──────────────────────────────────────────────

  const [mostrarFormProducto, setMostrarFormProducto] = useState(false);
  /**
   * Tipo gastronómico del alta rápida, igual que en Inventario → Nuevo producto.
   * No es cosmético: define los flags con los que nace el producto.
   *   reventa → se vende tal cual y descuenta stock
   *   menu    → se vende preparado, NO descuenta stock (el costo sale de la receta)
   *   materia → insumo: no se vende, sólo alimenta recetas
   */
  type TipoGastro = "reventa" | "menu" | "materia";
  const FLAGS_TIPO: Record<TipoGastro, { es_vendible: boolean; es_insumo: boolean; controla_stock: boolean; unidad: string }> = {
    reventa: { es_vendible: true,  es_insumo: false, controla_stock: true,  unidad: "Unidad" },
    menu:    { es_vendible: true,  es_insumo: false, controla_stock: false, unidad: "Unidad" },
    materia: { es_vendible: false, es_insumo: true,  controla_stock: false, unidad: "Kg" },
  };

  const [formProducto, setFormProducto] = useState({
    nombre: "",
    sku: "",
    tipo_gastro: "reventa" as TipoGastro,
    unidad_medida: "Unidad",
    metodo_valuacion: "CPP" as MetodoValuacion,
    stock_minimo: "0",
    precio_venta_sugerido: "",
  });
  /** Productos ya cargados en esta factura. */
  const [lineas, setLineas] = useState<LineaCompra[]>([]);
  /** Error de la línea que se está cargando, separado del error de la compra. */
  const [errorLinea, setErrorLinea] = useState<string | null>(null);
  const [lineaSeq, setLineaSeq] = useState(0);

  const [errorSku, setErrorSku] = useState<string | null>(null);
  const [productoCreado, setProductoCreado] = useState<string | null>(null);
  const [errorSubmit, setErrorSubmit] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Carga inicial ────────────────────────────────────────────────────────

  async function recargarProveedores() {
    const data = await getProveedores();
    setProveedores(data.filter((p) => p.estado === "activo"));
  }

  function recargarProductos() {
    getProductos().then(setProductos);
  }

  useEffect(() => {
    recargarProveedores();
    recargarProductos();
  }, []);

  // ── Cálculos reactivos del formulario principal ──────────────────────────

  const cantidadNum = parseFloat(form.cantidad) || 0;
  const costoInputNum = parseFloat(form.costo_unitario_input) || 0;
  const tipoCambioNum = form.moneda === "USD"
    ? (parseFloat(form.tipo_cambio) || 0)
    : 1;
  const costoUnitarioPYG = costoInputNum * tipoCambioNum;
  const precioVentaNum = parseFloat(form.precio_venta) || 0;

  /**
   * IVA incluido, como se factura en Paraguay.
   *
   * El costo unitario que carga el usuario es el que figura en la factura del
   * proveedor, y ese precio YA tiene el IVA adentro. Por eso el impuesto no se
   * suma: se extrae del total.
   *
   *   total = cantidad × costo unitario   (lo que realmente se paga)
   *   IVA 10% → total / 11                (el 10% es 1/11 del precio final)
   *   IVA  5% → total / 21
   *   base gravada = total − IVA
   *
   * Antes se calculaba al revés (total = base + IVA), y una compra de 49 × 8.000
   * mostraba 431.200 cuando al proveedor se le pagan 392.000.
   */
  const total = cantidadNum > 0 && costoUnitarioPYG > 0
    ? cantidadNum * costoUnitarioPYG
    : 0;
  const montoIva =
    form.iva_tipo === "exenta" ? 0
    : form.iva_tipo === "5"    ? total / 21
    :                            total / 11;
  const subtotal = total - montoIva;

  const margenVenta =
    precioVentaNum > 0 && costoUnitarioPYG > 0
      ? ((precioVentaNum - costoUnitarioPYG) / precioVentaNum) * 100
      : null;

  const productoSeleccionado = productos.find((p) => p.id === form.producto_id);

  /** El borrador está completo y se puede sumar a la factura. */
  const borradorListo = !!form.producto_id && cantidadNum > 0 && costoUnitarioPYG > 0;

  const lineasCalculadas = useMemo(
    () => lineas.map((l) => ({ l, c: calcularLinea(l, tipoCambioNum) })),
    [lineas, tipoCambioNum]
  );

  const totalOrden = lineasCalculadas.reduce((acc, x) => acc + x.c.total, 0);
  const ivaOrden = lineasCalculadas.reduce((acc, x) => acc + x.c.montoIva, 0);
  const gravadaOrden = totalOrden - ivaOrden;

  /** Se puede guardar si ya hay líneas, o si el borrador alcanza para una. */
  const calculosListos = lineas.length > 0 || borradorListo;

  const opcionesProducto: SmartOption[] = useMemo(
    () =>
      productos.map((p) => ({
        id: p.id,
        label: p.nombre,
        sub: p.sku,
        trailing: `stock ${p.stock_actual}`,
      })),
    [productos]
  );

  /** Limpia sólo lo que es de la línea: proveedor, moneda y pago siguen. */
  function limpiarBorrador() {
    setForm((prev) => ({
      ...prev,
      producto_id: "",
      cantidad: "",
      costo_unitario_input: "",
      precio_venta: "",
    }));
    setProductoCreado(null);
    setErrorLinea(null);
  }

  /**
   * Suma el borrador a la factura. Devuelve la línea o null si no estaba
   * completa, para que el submit pueda reusarla sin duplicar validaciones.
   */
  function armarLineaBorrador(): LineaCompra | null {
    if (!borradorListo) return null;
    const prod = productos.find((x) => x.id === form.producto_id);
    if (!prod) return null;
    return {
      key: `l${lineaSeq}`,
      producto_id: prod.id,
      producto_nombre: prod.nombre,
      cantidad: cantidadNum,
      costo_unitario_original: costoInputNum,
      iva_tipo: form.iva_tipo,
      // 0 = no tocar el precio de venta del producto.
      precio_venta: precioVentaNum,
    };
  }

  function agregarLinea() {
    setErrorLinea(null);
    setErrorSubmit(null);
    if (!form.producto_id) return setErrorLinea("Elegí un producto.");
    if (cantidadNum <= 0) return setErrorLinea("La cantidad debe ser mayor a 0.");
    if (costoUnitarioPYG <= 0) return setErrorLinea("El costo unitario debe ser mayor a 0.");
    if (lineas.some((l) => l.producto_id === form.producto_id)) {
      return setErrorLinea(
        "Ese producto ya está en la compra. Quitalo o cambiale la cantidad en la lista."
      );
    }
    const linea = armarLineaBorrador();
    if (!linea) return;
    setLineas((prev) => [...prev, linea]);
    setLineaSeq((n) => n + 1);
    limpiarBorrador();
  }

  function quitarLinea(key: string) {
    setLineas((prev) => prev.filter((l) => l.key !== key));
  }

  // Margen preview dentro del formulario de nuevo producto
  const costoParaPreview = costoUnitarioPYG > 0 ? costoUnitarioPYG : 0;
  const precioSugeridoNum = parseFloat(formProducto.precio_venta_sugerido) || 0;
  const margenPreview =
    precioSugeridoNum > 0 && costoParaPreview > 0
      ? ((precioSugeridoNum - costoParaPreview) / precioSugeridoNum) * 100
      : null;

  // ── Handlers: formulario principal ──────────────────────────────────────

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleProductoSelectChange(id: string) {
    const p = productos.find((x) => x.id === id);
    setProductoCreado(null);
    setErrorLinea(null);
    setForm((prev) => ({
      ...prev,
      producto_id: id,
      costo_unitario_input: p ? String(p.costo_promedio) : "",
      precio_venta: p && p.precio_venta > 0 ? String(p.precio_venta) : "",
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorSubmit(null);

    if (!form.proveedor_id) return setErrorSubmit("Seleccioná o agregá un proveedor.");
    if (!form.nro_timbrado?.trim()) return setErrorSubmit("Ingresá el N° de timbrado.");
    if (form.moneda === "USD" && tipoCambioNum <= 0)
      return setErrorSubmit("Ingresá el tipo de cambio.");

    // Si quedó un producto cargado en el borrador sin apretar "Agregar", entra
    // igual: perder la última línea porque faltó un clic es un error caro.
    const pendiente = armarLineaBorrador();
    const duplicado =
      pendiente && lineas.some((l) => l.producto_id === pendiente.producto_id);
    if (duplicado) {
      return setErrorSubmit(
        "El producto del formulario ya está en la lista. Quitalo de arriba o de la lista."
      );
    }
    const todas = pendiente ? [...lineas, pendiente] : lineas;

    if (todas.length === 0) {
      return setErrorSubmit("Agregá al menos un producto a la compra.");
    }

    const proveedor = proveedores.find((p) => String(p.id) === form.proveedor_id);
    if (!proveedor) return setErrorSubmit("Proveedor no encontrado. Recargá e intentá de nuevo.");

    const items: CompraLinea[] = todas.map((l) => {
      const c = calcularLinea(l, tipoCambioNum);
      return {
        producto_id: l.producto_id,
        producto_nombre: l.producto_nombre,
        cantidad: l.cantidad,
        costo_unitario_original: l.costo_unitario_original,
        costo_unitario: c.costoPYG,
        iva_tipo: l.iva_tipo,
        subtotal: c.subtotal,
        monto_iva: c.montoIva,
        total: c.total,
        precio_venta: l.precio_venta,
        margen_venta: c.margen,
      };
    });

    setSubmitting(true);
    try {
      const res = await saveCompraMultilinea(
        {
          proveedor_id: String(proveedor.id),
          proveedor_nombre: proveedor.nombre,
          moneda: form.moneda,
          tipo_cambio: tipoCambioNum,
          tipo_pago: form.tipo_pago,
          plazo_dias:
            form.tipo_pago === "credito" && form.plazo_dias
              ? parseInt(form.plazo_dias)
              : undefined,
          nro_timbrado: form.nro_timbrado,
        },
        items
      );

      if (!res.success) {
        setErrorSubmit(res.error);
        return;
      }
      if (res.warning) alert(res.warning);
      router.push("/compras");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Handlers: inline PROVEEDOR ───────────────────────────────────────────

  function handleProveedorInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.name === "ruc") setErrorRuc(null);
    const { name, value } = e.target;
    const type = e.target.type;
    let normalized = value;
    if (name === "email" || type === "email") normalized = value.toLowerCase();
    else if (["nombre", "contacto"].includes(name)) normalized = value.toUpperCase();
    setFormProveedor((prev) => ({ ...prev, [name]: normalized }));
  }

  async function handleAgregarProveedor() {
    if (!formProveedor.nombre.trim() || !formProveedor.ruc.trim()) return;
    setErrorRuc(null);
    const dup = await proveedorExiste(formProveedor.ruc);
    if (dup) {
      setErrorRuc(`RUC ya registrado para "${dup.nombre}".`);
      return;
    }
    const resultado = await createProveedor({
      nombre: formProveedor.nombre.trim().toUpperCase(),
      ruc: formProveedor.ruc.trim(),
      telefono: formProveedor.telefono.trim(),
      email: formProveedor.email.trim(),
      contacto: formProveedor.contacto.trim().toUpperCase(),
      direccion: "",
      estado: "activo",
    });
    if (!resultado.ok) {
      setErrorRuc(resultado.error);
      return;
    }
    const creado = resultado.proveedor;
    await recargarProveedores();
    setForm((prev) => ({ ...prev, proveedor_id: String(creado.id) }));
    setProveedorCreado(creado.nombre);
    setMostrarFormProveedor(false);
    setFormProveedor({ nombre: "", ruc: "", telefono: "", email: "", contacto: "" });
  }

  function handleCancelarProveedor() {
    setMostrarFormProveedor(false);
    setFormProveedor({ nombre: "", ruc: "", telefono: "", email: "", contacto: "" });
    setErrorRuc(null);
  }

  // ── Handlers: inline PRODUCTO ────────────────────────────────────────────

  function handleProductoInputChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    if (e.target.name === "sku") setErrorSku(null);
    setFormProducto((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleAgregarProducto() {
    if (!formProducto.nombre.trim() || !formProducto.sku.trim()) return;
    setErrorSku(null);

    const dup = await productoExiste(formProducto.sku, formProducto.nombre);
    if (dup) {
      setErrorSku(
        `Ya existe un producto con ese SKU o nombre ("${dup.nombre}" — ${dup.sku}).`
      );
      return;
    }

    const flags = FLAGS_TIPO[formProducto.tipo_gastro];
    const creado = await saveProducto({
      nombre: formProducto.nombre.trim().toUpperCase(),
      sku: formProducto.sku.trim().toUpperCase(),
      unidad_medida: formProducto.unidad_medida.toUpperCase(),
      metodo_valuacion: formProducto.metodo_valuacion,
      es_vendible: flags.es_vendible,
      es_insumo: flags.es_insumo,
      controla_stock: flags.controla_stock,
      stock_actual: 0,   // la compra sumará el stock via ENTRADA
      stock_minimo: parseInt(formProducto.stock_minimo) || 0,
      costo_promedio: costoUnitarioPYG || 0,
      precio_venta: precioSugeridoNum || 0,
    });

    if (!creado) return;

    recargarProductos();
    setForm((prev) => ({
      ...prev,
      producto_id: creado.id,
      precio_venta: formProducto.precio_venta_sugerido || prev.precio_venta,
    }));
    setProductoCreado(creado.nombre);
    setMostrarFormProducto(false);
    setFormProducto({
      nombre: "", sku: "", tipo_gastro: "reventa", unidad_medida: "Unidad",
      metodo_valuacion: "CPP", stock_minimo: "0", precio_venta_sugerido: "",
    });
  }

  function handleCancelarProducto() {
    setMostrarFormProducto(false);
    setFormProducto({
      nombre: "", sku: "", tipo_gastro: "reventa", unidad_medida: "Unidad",
      metodo_valuacion: "CPP", stock_minimo: "0", precio_venta_sugerido: "",
    });
    setErrorSku(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">

      <div>
        <h1 className="text-3xl font-bold text-gray-800">Nueva compra</h1>
        <p className="text-gray-600">
          Una factura puede tener varios productos. Cada uno impacta el inventario al guardar.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-2xl">
        <form className="space-y-8" onSubmit={handleSubmit}>

          {/* ── 1. Comprobante ────────────────────────────────────────────── */}
          <section className="space-y-4">
            <SectionTitle>Comprobante</SectionTitle>
            <div>
              <label className={labelClass}>N° de timbrado</label>
              <input
                type="text"
                name="nro_timbrado"
                value={form.nro_timbrado}
                onChange={handleChange}
                placeholder="Ej: 001-001-0000001"
                className={inputClass}
              />
            </div>
          </section>

          {/* ── 2. Proveedor ──────────────────────────────────────────────── */}
          <section className="space-y-3">
            <SectionTitle>Proveedor</SectionTitle>

            <div>
              <label className={labelClass}>
                Proveedor <span className="text-red-500">*</span>
              </label>
              <SelectField
                name="proveedor_id"
                value={form.proveedor_id}
                onChange={(e) => { handleChange(e); setProveedorCreado(null); }}
                className={inputClass}
                required
              >
                <option value="">Seleccionar proveedor...</option>
                {proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre} — RUC {p.ruc}
                  </option>
                ))}
              </SelectField>

              {proveedorCreado && (
                <p className="mt-1.5 text-xs text-green-600">
                  <Check className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> Proveedor &quot;{proveedorCreado}&quot; creado y seleccionado.
                </p>
              )}

              {!mostrarFormProveedor ? (
                <button
                  type="button"
                  onClick={() => { setMostrarFormProveedor(true); setProveedorCreado(null); }}
                  className="mt-2 text-xs text-gray-400 hover:text-gray-700 underline transition-colors"
                >
                  ¿No encontrás el proveedor? Crear nuevo
                </button>
              ) : (
                <InlineFormBox titulo="Nuevo proveedor" onCancel={handleCancelarProveedor} onSave={handleAgregarProveedor}
                  saveDisabled={!formProveedor.nombre.trim() || !formProveedor.ruc.trim()}
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className={labelSmClass}>Nombre / Razón social <span className="text-red-500">*</span></label>
                      <input type="text" name="nombre" value={formProveedor.nombre}
                        onChange={handleProveedorInputChange} placeholder="Ej: TEXTILES DEL SUR S.A."
                        className={`${inputSmClass} uppercase`} />
                    </div>
                    <div>
                      <label className={labelSmClass}>RUC <span className="text-red-500">*</span></label>
                      <input type="text" name="ruc" value={formProveedor.ruc}
                        onChange={handleProveedorInputChange} placeholder="Ej: 80012345-1"
                        className={`${inputSmClass} ${errorRuc ? "border-red-300 bg-red-50" : ""}`} />
                      {errorRuc && <p className="mt-1 text-xs text-red-600">{errorRuc}</p>}
                    </div>
                    <div>
                      <label className={labelSmClass}>Teléfono</label>
                      <input type="text" name="telefono" value={formProveedor.telefono}
                        onChange={handleProveedorInputChange} placeholder="Ej: 0981 111 222"
                        className={inputSmClass} />
                    </div>
                    <div>
                      <label className={labelSmClass}>Email</label>
                      <input type="email" name="email" value={formProveedor.email}
                        onChange={handleProveedorInputChange} placeholder="Ej: ventas@empresa.com"
                        className={inputSmClass} />
                    </div>
                    <div className="col-span-2">
                      <label className={labelSmClass}>Persona de contacto</label>
                      <input type="text" name="contacto" value={formProveedor.contacto}
                        onChange={handleProveedorInputChange} placeholder="Ej: CARLOS MENDOZA"
                        className={`${inputSmClass} uppercase`} />
                    </div>
                  </div>
                </InlineFormBox>
              )}
            </div>
          </section>

          {/* ── 4. Condiciones de pago ────────────────────────────────────── */}
          <section className="space-y-4">
            <SectionTitle>Condiciones de pago</SectionTitle>

            <div>
              <label className={labelClass}>Tipo de pago</label>
              <SegmentedControl<TipoPago>
                value={form.tipo_pago}
                options={[
                  { value: "contado", label: "Contado" },
                  { value: "credito", label: "Crédito" },
                ]}
                onChange={(v) => setForm((prev) => ({ ...prev, tipo_pago: v }))}
              />
            </div>

            {form.tipo_pago === "credito" && (
              <div>
                <label className={labelClass}>Plazo (días)</label>
                <input type="number" name="plazo_dias" value={form.plazo_dias}
                  onChange={handleChange} placeholder="Ej: 30"
                  className={inputClass} min={1} />
              </div>
            )}
          </section>

          {/* ── 4. Moneda ─────────────────────────────────────────────────── */}
          <section className="space-y-4">
            <SectionTitle>Moneda</SectionTitle>

            <SegmentedControl<Moneda>
              value={form.moneda}
              options={[
                { value: "PYG", label: "Guaraníes (₲)" },
                { value: "USD", label: "Dólares (USD)" },
              ]}
              onChange={(v) => setForm((prev) => ({ ...prev, moneda: v, tipo_cambio: "" }))}
            />

            {form.moneda === "USD" && (
              <div>
                <label className={labelClass}>
                  Tipo de cambio (USD → Gs.) <span className="text-red-500">*</span>
                </label>
                <MontoInput
                  value={form.tipo_cambio}
                  onChange={(n) => setForm((prev) => ({ ...prev, tipo_cambio: String(n) }))}
                  placeholder="Ej: 7500"
                  className={inputClass}
                  decimals={false}
                  required
                />
                <p className="mt-1 text-xs text-slate-400">
                  Se aplica a todos los productos de la factura. Si lo corregís, se recalculan
                  los que ya cargaste.
                </p>
              </div>
            )}
          </section>

          {/* ── 5. Productos de la compra ─────────────────────────────────── */}
          <section className="space-y-3">
            <SectionTitle>
              Productos de la compra{lineas.length > 0 ? ` (${lineas.length})` : ""}
            </SectionTitle>

            {/* Alta de una línea. Todo junto en una tarjeta: son los campos de
                un mismo producto y antes estaban repartidos en cuatro secciones
                separadas por los datos de la factura. */}
            <div className="space-y-3 rounded-xl border-2 border-dashed border-slate-200 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Agregar producto
              </p>

              <div>
                <label className={labelSmClass}>
                  Producto <span className="text-red-500">*</span>
                </label>
                <SmartSearchSelect
                  options={opcionesProducto}
                  value={form.producto_id}
                  onChange={handleProductoSelectChange}
                  placeholder="Buscar producto por nombre o SKU…"
                  emptyText="Ningún producto coincide"
                />

                {productoSeleccionado && !productoCreado && (
                  <p className="mt-1.5 text-xs text-gray-400">
                    Costo promedio actual: {formatGs(productoSeleccionado.costo_promedio)}
                    &nbsp;·&nbsp;Precio de venta actual: {formatGs(productoSeleccionado.precio_venta)}
                  </p>
                )}
                {productoCreado && (
                  <p className="mt-1.5 text-xs text-green-600">
                    <Check className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> Producto &quot;{productoCreado}&quot; creado y seleccionado.
                  </p>
                )}

              {!mostrarFormProducto ? (
                <button
                  type="button"
                  onClick={() => { setMostrarFormProducto(true); setProductoCreado(null); }}
                  className="mt-2 text-xs text-gray-400 hover:text-gray-700 underline transition-colors"
                >
                  ¿No encontrás el producto? Crear nuevo
                </button>
              ) : (
                <InlineFormBox titulo="Nuevo producto" onCancel={handleCancelarProducto} onSave={handleAgregarProducto}
                  saveDisabled={!formProducto.nombre.trim() || !formProducto.sku.trim()}
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="col-span-2">
                      <label className={labelSmClass}>Tipo de producto</label>
                      <SegmentedControl<TipoGastro>
                        small
                        value={formProducto.tipo_gastro}
                        options={[
                          { value: "reventa", label: "Reventa" },
                          { value: "menu",    label: "Menú" },
                          { value: "materia", label: "Materia prima" },
                        ]}
                        onChange={(v) =>
                          setFormProducto((prev) => ({
                            ...prev,
                            tipo_gastro: v,
                            // La unidad sigue al tipo salvo que ya la hayan tocado.
                            unidad_medida:
                              prev.unidad_medida === FLAGS_TIPO[prev.tipo_gastro].unidad
                                ? FLAGS_TIPO[v].unidad
                                : prev.unidad_medida,
                          }))
                        }
                      />
                      <p className="mt-1 text-xs text-slate-500">
                        {formProducto.tipo_gastro === "reventa"
                          ? "Se compra y se vende tal cual. Controla stock."
                          : formProducto.tipo_gastro === "menu"
                            ? "Se vende preparado. No descuenta stock directo."
                            : "Insumo para recetas. No se vende por separado."}
                      </p>
                    </div>
                    <div>
                      <label className={labelSmClass}>Nombre <span className="text-red-500">*</span></label>
                      <input type="text" name="nombre" value={formProducto.nombre}
                        onChange={handleProductoInputChange} placeholder="Ej: REMERA OVERSIZE BLANCA"
                        className={`${inputSmClass} uppercase`} />
                    </div>
                    <div>
                      <label className={labelSmClass}>SKU / Código <span className="text-red-500">*</span></label>
                      <input type="text" name="sku" value={formProducto.sku}
                        onChange={handleProductoInputChange} placeholder="Ej: OOTD-005"
                        className={`${inputSmClass} uppercase ${errorSku ? "border-red-300 bg-red-50" : ""}`} />
                      {errorSku && <p className="mt-1 text-xs text-red-600">{errorSku}</p>}
                    </div>
                    <div>
                      <label className={labelSmClass}>Unidad de medida</label>
                      <SelectField name="unidad_medida" value={formProducto.unidad_medida}
                        onChange={handleProductoInputChange} className={inputSmClass}>
                        <option value="Unidad">Unidad</option>
                        <option value="Par">Par</option>
                        <option value="Caja">Caja</option>
                        <option value="Kg">Kg</option>
                        <option value="Litro">Litro</option>
                        <option value="Metro">Metro</option>
                      </SelectField>
                    </div>
                    <div>
                      <label className={labelSmClass}>Stock mínimo</label>
                      <input type="number" name="stock_minimo" value={formProducto.stock_minimo}
                        onChange={handleProductoInputChange} placeholder="Ej: 5" min={0}
                        className={inputSmClass} />
                    </div>
                    {/* Método de valuación oculto: en esta instancia siempre es CPP,
                        igual que en el alta de Inventario. El valor sigue viajando
                        en el payload con su default. */}
                    <div className="col-span-2">
                      <label className={labelSmClass}>Precio de venta sugerido (Gs.)</label>
                      <MontoInput
                        value={formProducto.precio_venta_sugerido}
                        onChange={(n) => setFormProducto((prev) => ({ ...prev, precio_venta_sugerido: String(n) }))}
                        placeholder="Ej: 75000"
                        className={inputSmClass}
                        decimals={false}
                      />
                      {/* Preview de margen usando el costo del formulario principal */}
                      {margenPreview !== null && (
                        <p className={`mt-1 text-xs font-medium ${margenColor(margenPreview)}`}>
                          Margen s/venta: {margenPreview.toFixed(2)}%
                          {costoUnitarioPYG > 0
                            ? ` (costo: ${formatGs(costoUnitarioPYG)})`
                            : " — completá el costo de compra para ver el margen real"}
                        </p>
                      )}
                      {!margenPreview && costoUnitarioPYG === 0 && (
                        <p className="mt-1 text-xs text-gray-400">
                          El margen se calculará con el costo de compra que ingreses abajo.
                        </p>
                      )}
                    </div>
                  </div>
                </InlineFormBox>
              )}
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div>
                  <label className={labelSmClass}>
                    Cantidad <span className="text-red-500">*</span>
                  </label>
                  <input type="number" name="cantidad" value={form.cantidad}
                    onChange={handleChange} placeholder="Ej: 50"
                    className={inputSmClass} min={0} step="any" />
                </div>

                <div>
                  <label className={labelSmClass}>
                    Costo unit. ({form.moneda === "USD" ? "USD" : "Gs."})
                    <span className="text-red-500"> *</span>
                  </label>
                  <MontoInput
                    value={form.costo_unitario_input}
                    onChange={(n) => setForm((prev) => ({ ...prev, costo_unitario_input: String(n) }))}
                    placeholder={form.moneda === "USD" ? "Ej: 12" : "Ej: 18000"}
                    className={inputSmClass}
                    decimals={form.moneda === "USD"}
                  />
                  {form.moneda === "USD" && costoInputNum > 0 && tipoCambioNum > 0 && (
                    <p className="mt-1 text-xs text-gray-400">≈ {formatGs(costoUnitarioPYG)}</p>
                  )}
                </div>

                <div>
                  <label className={labelSmClass}>IVA</label>
                  <SegmentedControl<TipoIva>
                    small
                    value={form.iva_tipo}
                    options={[
                      { value: "exenta", label: "Ex." },
                      { value: "5", label: "5%" },
                      { value: "10", label: "10%" },
                    ]}
                    onChange={(v) => setForm((prev) => ({ ...prev, iva_tipo: v }))}
                  />
                </div>

                <div>
                  <label className={labelSmClass}>
                    Precio venta <span className="font-normal text-slate-400">(opcional)</span>
                  </label>
                  <MontoInput
                    value={form.precio_venta}
                    onChange={(n) => setForm((prev) => ({ ...prev, precio_venta: String(n) }))}
                    placeholder="Opcional"
                    className={inputSmClass}
                    decimals={false}
                  />
                  {margenVenta !== null && (
                    <p className={`mt-1 text-xs font-medium ${margenColor(margenVenta)}`}>
                      {margenVenta < 0 && (
                        <AlertTriangle className="mr-0.5 inline h-3 w-3 align-[-0.125em]" aria-hidden />
                      )}
                      Margen {margenVenta.toFixed(1)}%
                    </p>
                  )}
                </div>
              </div>

              <p className="text-xs text-slate-400">
                El precio de venta viene del inventario. Cambialo si sube, o dejalo vacío
                para que el producto conserve el que ya tiene.
              </p>

              {errorLinea && (
                <p className="text-xs font-semibold text-amber-700">{errorLinea}</p>
              )}

              <button
                type="button"
                onClick={agregarLinea}
                disabled={!borradorListo}
                className="w-full rounded-lg bg-[#4FAEB2] px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#3F8E91] active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
              >
                <Plus className="mr-1 inline h-4 w-4 align-[-0.125em]" aria-hidden />
                Agregar producto a la compra
                {total > 0 ? ` · ${formatGs(total)}` : ""}
              </button>
            </div>
          </section>

          {/* ── Líneas ya cargadas ────────────────────────────────────────── */}
          {lineas.length > 0 && (
            <section className="space-y-3">
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50">
                    <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2">Producto</th>
                      <th className="px-3 py-2 text-right">Cant.</th>
                      <th className="px-3 py-2 text-right">Costo unit.</th>
                      <th className="px-3 py-2">IVA</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lineasCalculadas.map(({ l, c }) => (
                      <tr key={l.key}>
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-slate-800">{l.producto_nombre}</p>
                          <p className="text-xs text-slate-400">
                            Venta {formatGs(l.precio_venta)} · margen{" "}
                            <span className={margenColor(c.margen)}>{c.margen.toFixed(1)}%</span>
                          </p>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{l.cantidad}</td>
                        <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-600">
                          {form.moneda === "USD" ? (
                            <>
                              USD {l.costo_unitario_original.toLocaleString("es-PY")}
                              <br />
                              <span className="text-slate-400">≈ {formatGs(c.costoPYG)}</span>
                            </>
                          ) : (
                            formatGs(c.costoPYG)
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">
                          {l.iva_tipo === "exenta" ? "Exenta" : `${l.iva_tipo}%`}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">
                          {formatGs(c.total)}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => quitarLinea(l.key)}
                            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                            aria-label={`Quitar ${l.producto_nombre}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-center">
                  <p className="mb-1 text-xs text-slate-500">Gravada</p>
                  <p className="text-sm font-semibold tabular-nums text-slate-700">{formatGs(gravadaOrden)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-center">
                  <p className="mb-1 text-xs text-slate-500">IVA incluido</p>
                  <p className="text-sm font-semibold tabular-nums text-slate-700">{formatGs(ivaOrden)}</p>
                </div>
                <div className="rounded-xl bg-[#4FAEB2] px-3 py-3 text-center text-white">
                  <p className="mb-1 text-xs text-white/80">Total de la factura</p>
                  <p className="text-base font-bold tabular-nums">{formatGs(totalOrden)}</p>
                </div>
              </div>
            </section>
          )}

          {/* ── Impacto en inventario ─────────────────────────────────────── */}
          {borradorListo && productoSeleccionado && (
            <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-xs text-green-700">
              <span className="mt-0.5 text-base leading-none"><Check className="inline h-4 w-4 align-[-0.125em]" aria-hidden /></span>
              <span>
                <strong>{productoSeleccionado.nombre}</strong> todavía no está en la lista. Si
                guardás así, igual se agrega: entrarán{" "}
                <strong>{cantidadNum} unidades</strong> al inventario.
              </span>
            </div>
          )}

          {errorSubmit && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-700">{errorSubmit}</p>
            </div>
          )}

          {/* ── Acciones ─────────────────────────────────────────────────── */}
          <div className="flex gap-4 pt-2">
            <button
              type="submit"
              disabled={!calculosListos || submitting}
              className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-5 py-3 rounded-lg text-sm font-medium transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
            >
              {submitting
                ? "Guardando..."
                : `Guardar compra${
                    lineas.length + (borradorListo && !lineas.some((l) => l.producto_id === form.producto_id) ? 1 : 0) > 0
                      ? ` (${lineas.length + (borradorListo && !lineas.some((l) => l.producto_id === form.producto_id) ? 1 : 0)} producto${
                          lineas.length + (borradorListo && !lineas.some((l) => l.producto_id === form.producto_id) ? 1 : 0) === 1 ? "" : "s"
                        })`
                      : ""
                  }`}
            </button>
            <button
              type="button"
              onClick={() => router.push("/compras")}
              className="border border-slate-200 px-5 py-3 rounded-lg text-sm hover:bg-slate-50 transition-colors"
            >
              Cancelar
            </button>
          </div>

        </form>
      </div>

    </div>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
      {children}
    </h3>
  );
}

function InlineFormBox({
  titulo,
  children,
  onSave,
  onCancel,
  saveDisabled,
}: {
  titulo: string;
  children: React.ReactNode;
  onSave: () => void;
  onCancel: () => void;
  saveDisabled: boolean;
}) {
  return (
    <div className="mt-4 border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-4">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
        {titulo}
      </p>
      {children}
      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onSave}
          disabled={saveDisabled}
          className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
        >
          Guardar {titulo.toLowerCase()}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border border-slate-200 px-4 py-2 rounded-lg text-xs hover:bg-white transition-colors"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
