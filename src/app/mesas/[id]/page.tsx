"use client";

import { confirmar } from "@/components/ui/ConfirmDialog";
import { AlertTriangle, Pizza, Replace, X } from "lucide-react";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import MesaProductPicker from "@/components/mesas/MesaProductPicker";
import NotaCocina from "@/components/mesas/NotaCocina";
import MitadMitadPicker, { type MitadMitadResult } from "@/components/ventas/MitadMitadPicker";
import CobroCuenta from "@/components/ventas/CobroCuenta";
import { getModuleAccessCached } from "@/lib/modulos/module-access-cache";
import {
  actualizarItemMesa, agregarItemMesa, cancelarCuentaMesa,
  enviarComandaMesa, enviarMesaACaja, getMesaDetalle,
} from "@/lib/mesas/storage";
import type { EstadoMesa, MesaSesionItem } from "@/lib/mesas/types";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

const ESTADO_BADGE: Record<EstadoMesa, string> = {
  libre: "bg-emerald-100 text-emerald-700",
  ocupada: "bg-amber-100 text-amber-700",
  por_cobrar: "bg-rose-100 text-rose-700",
  cerrada: "bg-slate-100 text-slate-600",
  inactiva: "bg-slate-100 text-slate-600",
};

export default function MesaDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [numero, setNumero] = useState<number | null>(null);
  const [mesaEstado, setMesaEstado] = useState<EstadoMesa>("libre");
  const [porCobrar, setPorCobrar] = useState(false);
  const [items, setItems] = useState<MesaSesionItem[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * Línea que se está corrigiendo. Cuando está seteada, el buscador y el
   * armador de mitad y mitad reemplazan ese ítem en vez de agregar uno nuevo:
   * es el caso de "cargué el sabor equivocado".
   */
  const [cambiandoItem, setCambiandoItem] = useState<MesaSesionItem | null>(null);
  const [mitadOpen, setMitadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Sesión viva de la mesa: es la que identifica la cuenta en la pantalla de cobro. */
  const [sesionId, setSesionId] = useState<string | null>(null);
  /** Panel de cobro desplegado. Arranca cerrado para no tapar el pedido. */
  /**
   * Si este usuario puede cobrar. El mozo tiene mesas y comandas pero no
   * ventas: sin esto veía el cobro y recibía un error de permiso al apretar, y
   * el que sí cobra veía un "Pasar a caja" que no necesita.
   *
   * Arranca en null —todavía no se sabe— para no mostrar ninguna de las dos
   * cosas y que no aparezcan y desaparezcan al cargar la pantalla.
   */
  const [puedeCobrar, setPuedeCobrar] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const tmpCounter = useRef(0);

  const load = useCallback(async () => {
    const d = await getMesaDetalle(id);
    if (d) {
      setNumero(d.mesa.numero);
      setMesaEstado(d.mesa.estado);
      setPorCobrar(d.sesion?.estado === "por_cobrar");
      setSesionId(d.sesion?.id ?? null);
      setItems(d.items);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let vivo = true;
    void getModuleAccessCached().then((r) => {
      if (!vivo) return;
      const slugs = r.data.slugs ?? [];
      setPuedeCobrar(Boolean(r.data.superAdmin) || slugs.includes("ventas"));
    });
    return () => { vivo = false; };
  }, []);

  const markPending = (tmpId: string, on: boolean) =>
    setPendingIds((prev) => { const n = new Set(prev); if (on) n.add(tmpId); else n.delete(tmpId); return n; });

  // ── Agregar (optimista): aparece al instante, la API guarda en segundo plano ──
  async function onAdd(
    prod: { id: string; nombre: string; precio_venta: number },
    cantidad: number,
    observacion: string | null
  ): Promise<boolean> {
    setError(null);
    const tmpId = `tmp-${++tmpCounter.current}`;
    const optimistic: MesaSesionItem = {
      id: tmpId, sesion_id: "", producto_id: prod.id, producto_nombre: prod.nombre, sku: null,
      cantidad, precio_unitario: prod.precio_venta, total: Math.round(prod.precio_venta * cantidad),
      observacion, estado: "pendiente", comanda_id: null, enviado_at: null,
    };
    setItems((prev) => [...prev, optimistic]);
    markPending(tmpId, true);
    setMesaEstado((e) => (e === "libre" ? "ocupada" : e));

    const r = await agregarItemMesa(id, { producto_id: prod.id, cantidad, observacion });
    if (!r.success) {
      setItems((prev) => prev.filter((i) => i.id !== tmpId)); // revertir
      markPending(tmpId, false);
      setError(r.error);
      return false;
    }
    setItems((prev) => prev.map((i) => (i.id === tmpId ? r.item : i))); // reconciliar
    // La cuenta se crea en el servidor recién al cargar el primer producto. Sin
    // esto la pantalla nunca se enteraba de su id, y el cobro —que depende de
    // ese id— no aparecía en toda la visita: había que salir y volver a entrar.
    if (!sesionId && r.item.sesion_id) setSesionId(r.item.sesion_id);
    markPending(tmpId, false);
    return true;
  }

  // Pizza mitad y mitad (optimista): aparece al instante con el precio del sabor más caro.
  async function onAddMitad(r: MitadMitadResult) {
    setMitadOpen(false);
    setError(null);
    // Si venía de "Cambiar", corrige la línea en vez de sumar otra pizza.
    if (cambiandoItem) {
      const item = cambiandoItem;
      setCambiandoItem(null);
      void onCambiarProducto(item, {
        producto_id: r.producto_id,
        display_name: r.display_name,
        precio_unitario: r.precio_unitario,
        mitad: r.mitad,
      });
      return;
    }
    const tmpId = `tmp-${++tmpCounter.current}`;
    const optimistic: MesaSesionItem = {
      id: tmpId, sesion_id: "", producto_id: r.producto_id, producto_nombre: r.display_name, sku: null,
      cantidad: 1, precio_unitario: r.precio_unitario, total: r.precio_unitario,
      observacion: null, estado: "pendiente", comanda_id: null, enviado_at: null,
      es_mitad_mitad: true, mitad_1_nombre: r.mitad.nombre1, mitad_2_nombre: r.mitad.nombre2,
    };
    setItems((prev) => [...prev, optimistic]);
    markPending(tmpId, true);
    setMesaEstado((e) => (e === "libre" ? "ocupada" : e));

    const res = await agregarItemMesa(id, {
      producto_id: r.producto_id, cantidad: 1, observacion: null,
      precio_unitario: r.precio_unitario, display_name: r.display_name, mitad: r.mitad,
    });
    if (!res.success) {
      setItems((prev) => prev.filter((i) => i.id !== tmpId));
      markPending(tmpId, false);
      setError(res.error);
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === tmpId ? res.item : i)));
    if (!sesionId && res.item.sesion_id) setSesionId(res.item.sesion_id);
    markPending(tmpId, false);
  }

  async function onChangeQty(item: MesaSesionItem, delta: number) {
    if (item.id.startsWith("tmp-") || item.estado === "cancelado") return;
    const nueva = Math.max(1, item.cantidad + delta);
    if (nueva === item.cantidad) return;
    if (
      item.estado === "enviado" &&
      !(await confirmar(
        `"${item.producto_nombre}" ya está en cocina. Cambiar la cantidad de ${item.cantidad} a ${nueva} manda un aviso de MODIFICACIÓN al sector. ¿Seguimos?`,
        { confirmLabel: "Sí, modificar", cancelLabel: "Dejar como está", destructivo: false }
      ))
    ) return;
    const prev = items;
    setItems((p) => p.map((i) => (i.id === item.id ? { ...i, cantidad: nueva, total: Math.round(i.precio_unitario * nueva) } : i)));
    const r = await actualizarItemMesa(item.id, { cantidad: nueva });
    if (!r.success) { setItems(prev); setError(r.error); }
  }

  /** Nota de cocina de un ítem ya cargado ("sin aceitunas"). */
  async function onCambiarNota(item: MesaSesionItem, observacion: string | null): Promise<boolean> {
    if (item.id.startsWith("tmp-")) return false;
    setError(null);
    const prev = items;
    setItems((p) => p.map((i) => (i.id === item.id ? { ...i, observacion } : i)));
    const r = await actualizarItemMesa(item.id, { observacion });
    if (!r.success) { setItems(prev); setError(r.error); return false; }
    return true;
  }

  /**
   * Reemplaza el producto de una línea. Si ya estaba en cocina, el servidor
   * manda además un aviso de modificación al sector que la estaba preparando.
   */
  async function onCambiarProducto(
    item: MesaSesionItem,
    payload: {
      producto_id: string;
      display_name?: string | null;
      precio_unitario?: number | null;
      mitad?: { producto1_id: string; producto2_id: string; nombre1: string; nombre2: string } | null;
    }
  ): Promise<boolean> {
    if (item.id.startsWith("tmp-")) return false;
    setError(null);
    const prev = items;
    const r = await actualizarItemMesa(item.id, {
      producto_id: payload.producto_id,
      display_name: payload.display_name ?? null,
      precio_unitario: payload.precio_unitario ?? null,
      mitad: payload.mitad ?? null,
    });
    if (!r.success) { setItems(prev); setError(r.error); return false; }
    setItems((p) => p.map((i) => (i.id === item.id ? r.item : i)));
    return true;
  }

  async function onCancelItem(item: MesaSesionItem) {
    if (item.id.startsWith("tmp-")) return;
    if (
      item.estado === "enviado" &&
      !(await confirmar(
        `"${item.producto_nombre}" ya está en cocina. Al cancelarlo se manda un aviso de CANCELACIÓN al sector para que dejen de prepararlo. ¿Seguimos?`,
        { confirmLabel: "Sí, cancelar el producto", cancelLabel: "Volver" }
      ))
    ) return;
    const prev = items;
    setItems((p) => p.filter((i) => i.id !== item.id));
    const r = await actualizarItemMesa(item.id, { cancelar: true });
    if (!r.success) { setItems(prev); setError(r.error); }
  }

  async function onEnviarComanda() {
    setError(null); setOkMsg(null); setBusy(true);
    const r = await enviarComandaMesa(id);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setItems((prev) => prev.map((i) => (i.estado === "pendiente" ? { ...i, estado: "enviado" } : i)));
    if (r.sin_produccion || r.comandas.length === 0) {
      setOkMsg("No hay productos que requieran producción.");
    } else {
      const partes = r.comandas.map((c) => `${c.sector === "pizzeria" ? "Pizzería" : "Plancha"} N°${c.numero}`);
      // No se abre ninguna ventana de impresión acá. La comanda queda esperando
      // en el tablero de Comandas y la imprime la cocina, que es donde está el
      // papel. Abrirla en la caja obligaba al cajero a cerrar pestañas con el
      // cliente enfrente, y encima el ticket salía de la impresora equivocada.
      setOkMsg(`Enviado a cocina: ${partes.join(" · ")}. Lo imprimen ellos.`);
    }
    setTimeout(() => setOkMsg(null), 3000);
  }

  /**
   * Deja la cuenta en la lista de pendientes de Caja.
   *
   * Hace falta porque el mozo no cobra: su usuario tiene mesas y comandas, no
   * ventas. Sin esto no tendría forma de pasarle la mesa al que sí cobra.
   * Quien cobra en el salón no lo necesita — tiene el cobro acá abajo.
   */
  async function onPasarACaja() {
    setError(null);
    const hayPend = items.some((i) => i.estado === "pendiente");
    if (hayPend) {
      const enviar = await confirmar(
        "Hay productos sin enviar a cocina. ¿Querés mandarlos antes de pasar la mesa a caja?",
        { confirmLabel: "Enviar y pasar", cancelLabel: "Pasar sin enviar", destructivo: false }
      );
      if (enviar) {
        const c = await enviarComandaMesa(id);
        if (!c.success) { setError(c.error); return; }
      }
    }
    setBusy(true);
    const r = await enviarMesaACaja(id);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    router.push("/mesas");
  }

  async function onCancelarCuenta() {
    // Una mesa sin nada cargado no tiene cuenta que perder: liberarla no
    // descarta consumo, sólo la devuelve al salón. Preguntar ahí es ruido.
    const vacia = items.length === 0;
    if (
      !vacia &&
      !(await confirmar(`¿Cancelar la cuenta de la mesa ${numero}? Esto no factura ni cobra nada.`))
    ) {
      return;
    }
    setBusy(true);
    const r = await cancelarCuentaMesa(id);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    router.push("/mesas");
  }

  if (loading) return <p className="py-10 text-center text-slate-400">Cargando mesa…</p>;

  const total = items.reduce((s, i) => s + i.total, 0);
  const hayItems = items.length > 0;
  /**
   * Id de la cuenta, con los propios productos como respaldo.
   *
   * El estado se llena al cargar la pantalla y al crear la cuenta, pero si por
   * cualquier camino quedara vacío, el cobro desaparecería sin explicación.
   * Cualquier producto ya guardado sabe a qué cuenta pertenece, así que sirve
   * de red: mientras haya algo cargado, hay con qué cobrar.
   */
  const cuentaId =
    sesionId ?? items.find((i) => !i.id.startsWith("tmp-") && i.sesion_id)?.sesion_id ?? null;
  const hayPendientes = items.some((i) => i.estado === "pendiente");

  return (
    <div className="space-y-5 pb-32">
      <div>
        <button onClick={() => router.push("/mesas")} className="text-sm text-[#0EA5E9]">← Mesas</button>
        <h1 className="text-2xl font-bold text-slate-800">
          Mesa {numero}
          <span className={`ml-2 align-middle rounded-full px-2.5 py-0.5 text-xs font-semibold ${ESTADO_BADGE[mesaEstado]}`}>
            {mesaEstado === "por_cobrar" ? "Por cobrar" : mesaEstado.charAt(0).toUpperCase() + mesaEstado.slice(1)}
          </span>
        </h1>
      </div>

      {/* El cobro está más abajo en esta misma pantalla, así que sólo hace falta
          avisar que el pedido ya no se edita. */}
      {porCobrar && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5">
          <p className="text-sm font-medium text-rose-700">
            Esta cuenta está marcada para cobrar. El pedido ya no se edita.
          </p>
        </div>
      )}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}</div>}
      {okMsg && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">{okMsg}</div>}

      {cambiandoItem && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#4FAEB2]/40 bg-[#4FAEB2]/10 px-4 py-2.5 text-sm text-[#2F6E71]">
          <Replace className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Cambiando <strong>{cambiandoItem.producto_nombre}</strong>. Elegí el producto correcto.
          </span>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded-md border border-[#4FAEB2]/40 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-[#4FAEB2]/10"
          >
            Buscar producto
          </button>
          <button
            type="button"
            onClick={() => setMitadOpen(true)}
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
          >
            Pizza mitad y mitad
          </button>
          <button
            type="button"
            onClick={() => setCambiandoItem(null)}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            Cancelar
          </button>
        </div>
      )}

      {/* Lista de productos */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Pedido</h2>
        {!hayItems ? (
          <p className="py-8 text-center text-slate-400">Todavía no agregaste productos.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((it) => {
              const tmp = it.id.startsWith("tmp-") || pendingIds.has(it.id);
              const enviado = it.estado === "enviado";
              return (
                <li key={it.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{it.cantidad}× {it.producto_nombre}</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${enviado ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                        {enviado ? "Enviado" : "Pendiente"}
                      </span>
                      {tmp && <span className="text-[10px] text-slate-400">guardando…</span>}
                    </div>
                    {it.es_mitad_mitad && it.mitad_1_nombre && it.mitad_2_nombre && (
                      <p className="text-xs text-amber-700">½ {it.mitad_1_nombre} + ½ {it.mitad_2_nombre}</p>
                    )}
                    <p className="text-xs text-slate-400">{formatGs(it.precio_unitario)} c/u</p>
                    <NotaCocina
                      valor={it.observacion}
                      editable={!porCobrar && !tmp}
                      onGuardar={(texto) => onCambiarNota(it, texto)}
                    />
                    {/* Editar cantidad solo si es pendiente (no enviado a cocina). */}
                    {!porCobrar && !tmp && (
                      <div className="mt-1 flex items-center gap-2">
                        <button type="button" onClick={() => onChangeQty(it, -1)} className="h-8 w-8 rounded-md border border-slate-300 text-lg font-bold leading-none">−</button>
                        <span className="w-6 text-center text-sm font-semibold tabular-nums">{it.cantidad}</span>
                        <button type="button" onClick={() => onChangeQty(it, +1)} className="h-8 w-8 rounded-md border border-slate-300 text-lg font-bold leading-none">+</button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (
                              it.estado === "enviado" &&
                              !(await confirmar(
                                `"${it.producto_nombre}" ya está en cocina. Cambiarlo manda un aviso de MODIFICACIÓN al sector. ¿Seguimos?`,
                                { confirmLabel: "Sí, cambiar", cancelLabel: "Dejar como está", destructivo: false }
                              ))
                            ) return;
                            setCambiandoItem(it);
                            setPickerOpen(true);
                          }}
                          className="ml-1 inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-[#4FAEB2] hover:text-[#3F8E91]"
                          title="Cambiar este producto por otro"
                        >
                          <Replace className="h-3.5 w-3.5" aria-hidden />
                          Cambiar
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="font-semibold tabular-nums text-slate-800">{formatGs(it.total)}</span>
                    {!porCobrar && !tmp && (
                      <button type="button" onClick={() => onCancelItem(it)} className="text-xs text-red-400 hover:text-red-600">
                        <X className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {enviado ? "Quitar" : "Cancelar"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
          <span className="text-base font-bold text-slate-900">TOTAL</span>
          <span className="text-xl font-extrabold tabular-nums text-slate-900">{formatGs(total)}</span>
        </div>
      </div>

      {/* El cobro vive acá, en la misma pantalla de la mesa. Tener que salir a
          Caja para cobrar la cuenta que ya se tenía abierta era pedirle al
          cajero que recorriera el sistema para terminar donde ya estaba. */}
      {/* El cobro va siempre a la vista, sin desplegar. Estaba detrás de un
          botón que lo abría más abajo, fuera de la pantalla: se apretaba y
          parecía que no pasaba nada. Un cobro escondido no sirve de nada. */}
      {hayItems && cuentaId && puedeCobrar === true && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-4 text-sm font-semibold text-slate-800">Cobrar esta mesa</p>
          <CobroCuenta
            sesionId={cuentaId}
            total={total}
            pendientes={items.filter((i) => i.estado === "pendiente").length}
            habilitado={hayItems}
            volverA="/mesas"
            onError={setError}
          />
        </div>
      )}

      {/* Acciones (sticky abajo) — solo si la cuenta sigue en mano del mozo */}
      {!porCobrar && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 p-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
          <div className="mx-auto grid max-w-3xl grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setPickerOpen(true)}
              className="rounded-xl bg-[#0EA5E9] px-5 py-4 text-base font-semibold text-white shadow-sm hover:bg-[#0284C7] active:scale-95">
              + Agregar productos
            </button>
            <button type="button" onClick={() => setMitadOpen(true)}
              className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 text-base font-semibold text-amber-800 shadow-sm hover:bg-amber-100 active:scale-95">
              <Pizza className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> Pizza mitad y mitad
            </button>
            {hayPendientes && (
              <button type="button" onClick={onEnviarComanda} disabled={busy}
                className="rounded-xl bg-[#4FAEB2] px-5 py-4 text-base font-semibold text-white shadow-sm hover:bg-[#3F8E91] active:scale-95 disabled:opacity-50">
                Enviar comanda
              </button>
            )}
            {/* Disponible para todos: el mozo lo usa para soltar la cuenta, y quien
                cobra también, cuando prefiere que la tome la caja. */}
            {hayItems && (
              <button type="button" onClick={onPasarACaja} disabled={busy}
                className="rounded-xl border border-slate-300 px-5 py-4 text-base font-semibold text-slate-700 hover:bg-slate-50 active:scale-95 disabled:opacity-50">
                Pasar a caja
              </button>
            )}
            {/* Con productos es "cancelar la cuenta" y se descarta consumo; sin
                productos es sólo devolver la mesa al salón. Antes este botón
                sólo existía con productos, así que una mesa abierta por error
                quedaba ocupada sin forma de liberarla. */}
            <button type="button" onClick={onCancelarCuenta} disabled={busy}
              className={`rounded-xl border px-5 py-4 text-base font-semibold active:scale-95 disabled:opacity-50 ${
                hayItems
                  ? "border-rose-300 text-rose-600 hover:bg-rose-50"
                  : "border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}>
              {hayItems ? "Cancelar cuenta" : "Liberar mesa"}
            </button>
          </div>
        </div>
      )}

      <MesaProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAdd={async (prod, cantidad, observacion) => {
          if (cambiandoItem) {
            const item = cambiandoItem;
            setCambiandoItem(null);
            setPickerOpen(false);
            return onCambiarProducto(item, { producto_id: prod.id });
          }
          return onAdd(prod, cantidad, observacion);
        }}
      />
      <MitadMitadPicker open={mitadOpen} onClose={() => setMitadOpen(false)} onConfirm={onAddMitad} />
    </div>
  );
}
