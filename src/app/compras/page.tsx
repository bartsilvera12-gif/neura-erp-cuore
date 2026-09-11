"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { getCompras } from "@/lib/compras/storage";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { FancySelect } from "@/components/ui/FancySelect";
import SelectField from "@/components/ui/SelectField";
import MobileFab from "@/components/ui/MobileFab";
import { confirmar } from "@/components/ui/ConfirmDialog";
import {
  avisoError, avisoInfo, btnGhost, btnIcono, btnIconoPeligro, btnPrimario,
  card, cardHead, celdaVacia, input, label, tabla, tbody, th, thRow, thead, tr,
} from "@/lib/ui/estilos";
import type { Compra, TipoPago } from "@/lib/compras/types";

function formatGs(valor: number) {
  return `Gs. ${valor.toLocaleString("es-PY")}`;
}

function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch {
    return iso;
  }
}

const tipoPagoBadge: Record<TipoPago, string> = {
  contado: "bg-sky-50 text-sky-700 ring-sky-600/15",
  credito: "bg-amber-50 text-amber-800 ring-amber-600/15",
};

const ivaLabel: Record<string, string> = {
  exenta: "Exenta",
  "5": "IVA 5%",
  "10": "IVA 10%",
};

export default function ComprasPage() {
  const [todas, setTodas] = useState<Compra[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [filtroTipoPago, setFiltroTipoPago] = useState<TipoPago | "">("");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [borrandoId, setBorrandoId] = useState<string | null>(null);

  // Edición administrativa (ver comentario en abrirEdicion).
  const [editando, setEditando] = useState<Compra | null>(null);
  const [edTipoPago, setEdTipoPago] = useState<TipoPago>("contado");
  const [edPlazo, setEdPlazo] = useState("");
  const [edTimbrado, setEdTimbrado] = useState("");
  const [guardando, setGuardando] = useState(false);

  function recargar() {
    return getCompras().then((data) => {
      setTodas([...data].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()));
    });
  }

  useEffect(() => {
    let cancel = false;
    getCompras().then((data) => {
      if (cancel) return;
      setTodas([...data].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()));
    });
    return () => { cancel = true; };
  }, []);

  /**
   * La edición se limita a los datos administrativos (forma de pago, plazo,
   * timbrado). Cantidad, costo y precio ya movieron el stock y el costo promedio
   * del producto: cambiarlos "en el papel" dejaría el inventario mintiendo. Para
   * corregirlos hay que borrar la compra —lo que revierte el movimiento— y
   * cargarla de nuevo.
   */
  function abrirEdicion(c: Compra) {
    setEditando(c);
    setEdTipoPago(c.tipo_pago === "credito" ? "credito" : "contado");
    setEdPlazo(c.plazo_dias != null ? String(c.plazo_dias) : "");
    setEdTimbrado(c.nro_timbrado ?? "");
    setError(null);
  }

  async function guardarEdicion() {
    if (!editando || guardando) return;
    setGuardando(true);
    setError(null);
    try {
      const r = await fetch(`/api/compras/${editando.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tipo_pago: edTipoPago,
          plazo_dias: edTipoPago === "credito" ? edPlazo : null,
          nro_timbrado: edTimbrado,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.success) setError(j?.error ?? "No se pudo guardar la compra.");
      else { setEditando(null); await recargar(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setGuardando(false);
    }
  }

  /**
   * Borrar una compra revierte su impacto: descuenta del stock lo que había
   * entrado y elimina el movimiento de inventario asociado. Lo único que no se
   * puede reconstruir es el costo promedio y el precio de venta anteriores —el
   * servidor lo avisa y lo mostramos tal cual.
   */
  async function eliminar(c: Compra) {
    const ok = await confirmar(
      `¿Borrar la compra ${c.numero_control}?\n\n` +
        `Se van a descontar ${c.cantidad} de ${c.producto_nombre} del stock y se ` +
        `eliminará su movimiento de inventario.`,
      { confirmLabel: "Borrar y revertir" }
    );
    if (!ok) return;

    setBorrandoId(c.id);
    setError(null);
    setAviso(null);
    try {
      const r = await fetch(`/api/compras/${c.id}`, { method: "DELETE", credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.success) {
        setError(j?.error ?? "No se pudo borrar la compra.");
      } else {
        if (j.data?.advertencia) setAviso(j.data.advertencia);
        await recargar();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setBorrandoId(null);
    }
  }

  const filtradas = todas.filter((c) => {
    const texto = busqueda.toLowerCase();
    const coincideTexto =
      texto === "" ||
      c.proveedor_nombre.toLowerCase().includes(texto) ||
      c.producto_nombre.toLowerCase().includes(texto) ||
      c.numero_control.toLowerCase().includes(texto);
    const coincideTipoPago = filtroTipoPago === "" || c.tipo_pago === filtroTipoPago;
    return coincideTexto && coincideTipoPago;
  });

  const hayFiltros = busqueda || filtroTipoPago;

  /**
   * Una factura de varios productos son varias filas con el mismo número de
   * control. Se ordenan juntas y sólo la primera repite proveedor, pago y
   * fecha; las demás quedan indentadas debajo.
   */
  const agrupadas = (() => {
    const orden: string[] = [];
    const porNumero = new Map<string, typeof filtradas>();
    for (const c of filtradas) {
      if (!porNumero.has(c.numero_control)) {
        porNumero.set(c.numero_control, []);
        orden.push(c.numero_control);
      }
      porNumero.get(c.numero_control)!.push(c);
    }
    return orden.flatMap((n) => {
      const grupo = porNumero.get(n)!;
      const totalGrupo = grupo.reduce((acc, x) => acc + x.total, 0);
      return grupo.map((c, i) => ({
        compra: c,
        primera: i === 0,
        lineas: grupo.length,
        totalGrupo,
      }));
    });
  })();

  const cantidadFacturas = new Set(filtradas.map((c) => c.numero_control)).size;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">Compras</h1>
          <p className="mt-1 text-sm text-slate-500">Registro de órdenes de compra a proveedores.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportExcelButton url="/api/compras/export" />
          <Link href="/compras/nueva" className={btnPrimario}>
            <Plus className="h-4 w-4" aria-hidden />
            Nueva compra
          </Link>
        </div>
      </div>

      {error && <div className={avisoError}>{error}</div>}
      {aviso && <div className={avisoInfo}>{aviso}</div>}

      <div className={card}>
        <div className={cardHead}>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Buscar por proveedor, producto o N° control…"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              className={`${input} min-w-0 flex-1 sm:min-w-72`}
            />
            <FancySelect
              value={filtroTipoPago}
              onChange={(v) => setFiltroTipoPago(v as TipoPago | "")}
              ariaLabel="Filtrar por tipo de pago"
              className="w-44"
              size="sm"
              options={[
                { value: "", label: "Todos los pagos" },
                { value: "contado", label: "Contado" },
                { value: "credito", label: "Crédito" },
              ]}
            />
            {hayFiltros && (
              <button
                type="button"
                onClick={() => { setBusqueda(""); setFiltroTipoPago(""); }}
                className={btnGhost}
              >
                Limpiar filtros
              </button>
            )}
          </div>
          <span className="text-xs text-slate-500">
            {cantidadFacturas} compra{cantidadFacturas === 1 ? "" : "s"} · {filtradas.length} de{" "}
            {todas.length} producto{todas.length === 1 ? "" : "s"}
          </span>
        </div>

        {/* Columnas auxiliares (Costo unit., IVA, Margen, Pago) se ocultan en
            mobile/tablet; min-w fuerza el scroll horizontal. */}
        <EdgeScrollArea>
          <table className={`${tabla} min-w-[900px] lg:min-w-0`}>
            <thead className={thead}>
              <tr className={thRow}>
                <th className={th}>N° Control</th>
                <th className={th}>Proveedor</th>
                <th className={th}>Producto</th>
                <th className={`${th} text-right`}>Cant.</th>
                <th className={`${th} hidden text-right lg:table-cell`}>Costo unit.</th>
                <th className={`${th} hidden lg:table-cell`}>IVA</th>
                <th className={`${th} text-right`}>Total</th>
                <th className={`${th} hidden text-right lg:table-cell`}>Margen</th>
                <th className={`${th} hidden lg:table-cell`}>Pago</th>
                <th className={th}>Fecha</th>
                <th className={`${th} text-right`}>Acciones</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {filtradas.length === 0 ? (
                <tr>
                  <td colSpan={11} className={celdaVacia}>
                    {todas.length === 0
                      ? "No hay compras registradas"
                      : "Ninguna compra coincide con los filtros"}
                  </td>
                </tr>
              ) : (
                agrupadas.map(({ compra: c, primera, lineas, totalGrupo }) => (
                  <tr
                    key={c.id}
                    className={`${tr} ${primera ? "border-t-2 border-slate-200" : ""}`}
                  >
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-500">
                      {primera ? (
                        <>
                          {c.numero_control}
                          {lineas > 1 && (
                            <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                              {lineas} prod.
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-300">↳</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 font-medium text-slate-800">
                      {primera ? c.proveedor_nombre : ""}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">{c.producto_nombre}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-slate-700">{c.cantidad}</td>
                    <td className="hidden px-5 py-3.5 text-right text-xs tabular-nums text-slate-600 lg:table-cell">
                      {c.moneda === "USD" && c.costo_unitario_original != null ? (
                        <span>
                          USD {c.costo_unitario_original.toLocaleString("es-PY")}
                          <br />
                          <span className="text-slate-400">≈ {formatGs(c.costo_unitario)}</span>
                        </span>
                      ) : (
                        formatGs(c.costo_unitario ?? c.total)
                      )}
                    </td>
                    <td className="hidden px-5 py-3.5 text-xs text-slate-500 lg:table-cell">
                      {c.iva_tipo ? ivaLabel[c.iva_tipo] : "—"}
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                      {formatGs(c.total)}
                      {primera && lineas > 1 && (
                        <span className="block text-[11px] font-normal text-slate-400">
                          factura {formatGs(totalGrupo)}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-5 py-3.5 text-right text-sm font-medium tabular-nums text-emerald-600 lg:table-cell">
                      {c.margen_venta != null ? `${c.margen_venta.toFixed(1)}%` : "—"}
                    </td>
                    <td className="hidden px-5 py-3.5 lg:table-cell">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                          c.tipo_pago ? tipoPagoBadge[c.tipo_pago] : "bg-slate-100 text-slate-500 ring-slate-500/15"
                        }`}
                      >
                        {c.tipo_pago === "contado"
                          ? "Contado"
                          : c.tipo_pago === "credito"
                          ? `Crédito ${c.plazo_dias ?? ""}d`
                          : "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-xs tabular-nums text-slate-500">
                      {primera ? formatFecha(c.fecha) : ""}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => abrirEdicion(c)}
                          className={btnIcono}
                          aria-label={`Editar ${c.numero_control}`}
                          title="Editar forma de pago y timbrado"
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => eliminar(c)}
                          disabled={borrandoId === c.id}
                          className={btnIconoPeligro}
                          aria-label={`Borrar ${c.numero_control}`}
                          title="Borrar y revertir stock"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </EdgeScrollArea>
      </div>

      {/* Modal de edición administrativa */}
      {editando && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => !guardando && setEditando(null)}
        >
          <div
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/80 to-[#4FAEB2]/30"
            />
            <div className="space-y-4 px-5 pb-4 pt-5">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Editar {editando.numero_control}</h3>
                <p className="mt-1 text-sm text-slate-500">
                  {editando.producto_nombre} · {editando.cantidad} u. · {formatGs(editando.total)}
                </p>
              </div>

              <div className={avisoInfo}>
                Cantidad, costo y precio no se editan acá: ya impactaron el stock y el costo del
                producto. Para corregirlos, borrá la compra —se revierte el movimiento— y cargala de
                nuevo.
              </div>

              <div>
                <label className={label}>Forma de pago</label>
                <SelectField
                  value={edTipoPago}
                  onChange={(e) => setEdTipoPago(e.target.value as TipoPago)}
                >
                  <option value="contado">Contado</option>
                  <option value="credito">Crédito</option>
                </SelectField>
              </div>

              {edTipoPago === "credito" && (
                <div>
                  <label className={label}>Plazo (días)</label>
                  <input
                    type="number"
                    min={0}
                    value={edPlazo}
                    onChange={(e) => setEdPlazo(e.target.value)}
                    placeholder="Ej: 30"
                    className={input}
                  />
                </div>
              )}

              <div>
                <label className={label}>N° de timbrado</label>
                <input
                  value={edTimbrado}
                  onChange={(e) => setEdTimbrado(e.target.value)}
                  className={input}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
              <button type="button" onClick={() => setEditando(null)} disabled={guardando} className={btnGhost}>
                Cancelar
              </button>
              <button
                type="button"
                onClick={guardarEdicion}
                disabled={guardando || !edTimbrado.trim()}
                className={btnPrimario}
              >
                {guardando ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      <MobileFab href="/compras/nueva" label="Nueva compra" />
    </div>
  );
}
