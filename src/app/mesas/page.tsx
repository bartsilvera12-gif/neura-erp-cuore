"use client";

import { useEffect, useState, useMemo } from "react";
import BuscadorLista, { coincideBusqueda } from "@/components/ui/BuscadorLista";
import NuevoParaLlevarModal from "@/components/mesas/NuevoParaLlevarModal";
import { useRouter } from "next/navigation";
import { AlertTriangle, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { confirmar } from "@/components/ui/ConfirmDialog";
import { useIsAdmin } from "@/lib/auth/use-is-admin";
import { crearMesas, getMesasConUltimoNumero } from "@/lib/mesas/storage";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { EstadoMesa, MesaConResumen } from "@/lib/mesas/types";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

interface MesaStyle {
  card: string;
  tile: string;
  pill: string;
  dot: string;
  label: string;
}

const ESTADO_STYLE: Record<EstadoMesa, MesaStyle> = {
  libre:      { card: "border-slate-200 bg-white hover:border-emerald-300",            tile: "bg-emerald-50 text-emerald-600", pill: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500", label: "Libre" },
  ocupada:    { card: "border-amber-200 bg-amber-50/40 hover:border-amber-300",        tile: "bg-amber-100 text-amber-700",    pill: "bg-amber-100 text-amber-800",    dot: "bg-amber-500",   label: "Ocupada" },
  por_cobrar: { card: "border-rose-200 bg-rose-50/50 hover:border-rose-300 ring-1 ring-rose-100", tile: "bg-rose-100 text-rose-700", pill: "bg-rose-100 text-rose-800",   dot: "bg-rose-500",    label: "Por cobrar" },
  cerrada:    { card: "border-slate-200 bg-slate-50 hover:border-slate-300",           tile: "bg-slate-100 text-slate-500",    pill: "bg-slate-100 text-slate-600",    dot: "bg-slate-400",   label: "Cerrada" },
  inactiva:   { card: "border-slate-200 bg-slate-50 opacity-60",                       tile: "bg-slate-100 text-slate-400",    pill: "bg-slate-100 text-slate-500",    dot: "bg-slate-300",   label: "Inactiva" },
};

export default function MesasPage() {
  const router = useRouter();
  const { isAdmin } = useIsAdmin();
  const [mesas, setMesas] = useState<MesaConResumen[]>([]);
  const [busqueda, setBusqueda] = useState("");
  /** Alta de un pedido Para llevar sin salir del salón. */
  const [plAbierto, setPlAbierto] = useState(false);
  const [ultimoNumero, setUltimoNumero] = useState(0);
  const [loading, setLoading] = useState(true);
  /** Falló el último refresco: se muestra sin borrar lo que ya estaba. */
  const [errorCarga, setErrorCarga] = useState<string | null>(null);

  // Alta de mesas
  const [modalAbierto, setModalAbierto] = useState(false);
  const [desde, setDesde] = useState("1");
  const [cantidad, setCantidad] = useState("1");
  const [nombre, setNombre] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorAlta, setErrorAlta] = useState<string | null>(null);
  const [avisoAlta, setAvisoAlta] = useState<string | null>(null);

  // Edición de una mesa concreta
  const [editando, setEditando] = useState<MesaConResumen | null>(null);
  const [edNumero, setEdNumero] = useState("");
  const [edNombre, setEdNombre] = useState("");
  const [edGuardando, setEdGuardando] = useState(false);
  const [edError, setEdError] = useState<string | null>(null);
  /** Qué se perdería al borrar la mesa abierta en el modal. */
  const [impacto, setImpacto] = useState<{
    sesiones: number; items: number; comandas: number; facturadas: number; cuenta_viva: boolean;
  } | null>(null);

  function abrirEdicion(m: MesaConResumen) {
    setEditando(m);
    setEdNumero(String(m.mesa.numero));
    setEdNombre(m.mesa.nombre ?? "");
    setEdError(null);
    setImpacto(null);
    void fetchWithSupabaseSession(`/api/mesas/${m.mesa.id}?impacto=1`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b) => { if (b?.success) setImpacto(b.data.impacto); })
      .catch(() => { /* la advertencia se degrada a genérica, no vale romper el modal */ });
  }

  /**
   * Borra la mesa con todo su historial.
   *
   * La confirmación enumera lo que se pierde con números reales. Es una acción
   * que no tiene vuelta atrás y que arrastra cosas que el usuario no ve desde
   * acá — comandas de cocina, líneas de cuenta — así que no alcanza con un
   * "¿estás seguro?".
   */
  async function borrarDefinitivo(m: MesaConResumen) {
    const i = impacto;
    const lineas = [
      `Vas a borrar la mesa ${m.mesa.numero} y todo su historial. Esto no se puede deshacer.`,
      "",
      "Se van a borrar:",
      `· ${i?.sesiones ?? 0} cuenta(s) de esta mesa`,
      `· ${i?.items ?? 0} línea(s) de pedido`,
      `· ${i?.comandas ?? 0} comanda(s) de cocina`,
    ];
    if ((i?.facturadas ?? 0) > 0) {
      lineas.push(
        "",
        `${i?.facturadas} de esas cuentas ya se facturaron. Las ventas NO se borran: siguen en Caja ` +
          "y en los reportes, pero dejan de decir de qué mesa salieron."
      );
    }

    if (!(await confirmar(lineas.join("\n"), { confirmLabel: "Borrar definitivamente" }))) return;

    setEdError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/mesas/${m.mesa.id}?forzar=1`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) setEdError(body?.error ?? "No se pudo borrar la mesa.");
      else { setEditando(null); await recargar(); }
    } catch (e) {
      setEdError(e instanceof Error ? e.message : "Error de red");
    }
  }

  /** Vuelve a poner en el salón una mesa dada de baja. */
  async function reactivarMesa(m: MesaConResumen) {
    setEdError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/mesas/${m.mesa.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activo: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) setEdError(body?.error ?? "No se pudo reactivar.");
      else { setEditando(null); await recargar(); }
    } catch (e) {
      setEdError(e instanceof Error ? e.message : "Error de red");
    }
  }

  async function guardarEdicion() {
    if (!editando || edGuardando) return;
    setEdGuardando(true);
    setEdError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/mesas/${editando.mesa.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numero: parseInt(edNumero, 10), nombre: edNombre.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        setEdError(body?.error ?? "No se pudo guardar.");
        return;
      }
      setEditando(null);
      await recargar();
    } catch (e) {
      setEdError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setEdGuardando(false);
    }
  }

  /**
   * Borra la mesa. Si ya tuvo cuentas, el servidor responde 409: borrarla
   * arrastraría ese historial (la relación es ON DELETE CASCADE), así que se
   * ofrece darla de baja.
   */
  async function eliminarMesa(m: MesaConResumen) {
    const nombre = m.mesa.nombre ? `${m.mesa.numero} — ${m.mesa.nombre}` : `${m.mesa.numero}`;
    if (!(await confirmar(`¿Borrar la mesa ${nombre}?`, { confirmLabel: "Borrar" }))) return;
    setEdError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/mesas/${m.mesa.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));

      if (res.status === 409 && body?.puede_desactivar) {
        const baja = await confirmar(`${body.error}\n\n¿Querés darla de baja?`, {
          confirmLabel: "Dar de baja",
          destructivo: false,
        });
        if (!baja) return;
        const res2 = await fetchWithSupabaseSession(`/api/mesas/${m.mesa.id}?desactivar=1`, { method: "DELETE" });
        const body2 = await res2.json().catch(() => ({}));
        if (!res2.ok || body2?.success === false) setEdError(body2?.error ?? "No se pudo dar de baja.");
        else { setEditando(null); await recargar(); }
        return;
      }

      if (!res.ok || body?.success === false) setEdError(body?.error ?? "No se pudo borrar la mesa.");
      else { setEditando(null); await recargar(); }
    } catch (e) {
      setEdError(e instanceof Error ? e.message : "Error de red");
    }
  }

  /**
   * Refresca el salón.
   *
   * Si la llamada falla se conserva la lista anterior. El refresco automático
   * corre cada 15 segundos y un tropiezo del servidor —un deploy, la sesión
   * renovándose— no puede vaciar la pantalla: el mozo vería "no hay mesas" con
   * las mesas ahí, y en medio del servicio eso es peor que un dato viejo.
   */
  const recargar = () =>
    getMesasConUltimoNumero(isAdmin).then((d) => {
      if (d.error) {
        setErrorCarga(d.error);
        setLoading(false);
        return d;
      }
      setErrorCarga(null);
      setMesas(d.mesas);
      setUltimoNumero(d.ultimoNumero);
      setLoading(false);
      return d;
    });

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getMesasConUltimoNumero(isAdmin).then((d) => {
        if (cancelled) return;
        if (d.error) { setErrorCarga(d.error); setLoading(false); return; }
        setErrorCarga(null);
        setMesas(d.mesas);
        setUltimoNumero(d.ultimoNumero);
        setLoading(false);
      });
    load();
    // Mientras el modal está abierto no refrescamos: pisaría lo que el usuario
    // está tipeando en "desde".
    const t = setInterval(() => { if (!modalAbierto) load(); }, 15000);
    return () => { cancelled = true; clearInterval(t); };
    // isAdmin llega despues del primer render: sin el en las dependencias, la
    // lista se cargaba sin las mesas dadas de baja y no volvia a pedirlas.
  }, [modalAbierto, isAdmin]);

  function abrirModal() {
    setDesde(String(ultimoNumero + 1));
    setCantidad("1");
    setNombre("");
    setErrorAlta(null);
    setAvisoAlta(null);
    setModalAbierto(true);
  }

  const desdeNum = parseInt(desde, 10);
  const cantNum = parseInt(cantidad, 10);
  const rangoValido = Number.isInteger(desdeNum) && desdeNum >= 1 && Number.isInteger(cantNum) && cantNum >= 1;
  const hasta = rangoValido ? desdeNum + cantNum - 1 : null;

  async function confirmarAlta() {
    if (!rangoValido || guardando) return;
    setGuardando(true);
    setErrorAlta(null);
    setAvisoAlta(null);
    const res = await crearMesas(desdeNum, cantNum, cantNum === 1 ? nombre : null);
    setGuardando(false);
    if (!res.ok) { setErrorAlta(res.error); return; }

    await recargar();
    if (res.creadas.length === 0) {
      setErrorAlta(`Esas mesas ya existían (${res.existentes.join(", ")}). No se creó ninguna.`);
      return;
    }
    if (res.existentes.length > 0) {
      setAvisoAlta(
        `Se crearon ${res.creadas.length} mesa(s). Ya existían y se saltearon: ${res.existentes.join(", ")}.`
      );
      return;
    }
    setModalAbierto(false);
  }

  /** Mesas que coinciden con la búsqueda. */
  const mesasVisibles = useMemo(
    () =>
      mesas.filter((m) =>
        coincideBusqueda(busqueda, m.mesa.numero, m.mesa.nombre, m.mozo_nombre)
      ),
    [mesas, busqueda]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Mesas</h1>
          <p className="text-sm text-slate-500">Tocá una mesa para tomar el pedido.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Un pedido para llevar se toma en el mismo momento que una mesa:
              alguien llega al mostrador. Tenerlo en otro módulo obligaba a
              salir del salón para algo que pasa acá. */}
          <button
            type="button"
            onClick={() => setPlAbierto(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#3F8E91]"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Para llevar
          </button>
          <button
            type="button"
            onClick={abrirModal}
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Crear mesas
          </button>
        </div>
      </div>

      {/* Se busca por número, por nombre de la mesa y por mozo: con el salón
          lleno, encontrar "la 14" a ojo entre veinte tarjetas cuesta más que
          escribir 14. */}
      <BuscadorLista
        valor={busqueda}
        onChange={setBusqueda}
        placeholder="Buscar por número de mesa, nombre o mozo…"
        mostrando={mesasVisibles.length}
        total={mesas.length}
      />

      {/* Leyenda */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(["libre", "ocupada", "por_cobrar"] as EstadoMesa[]).map((e) => (
          <span key={e} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium ${ESTADO_STYLE[e].pill}`}>
            <span className={`inline-block h-2 w-2 rounded-full ${ESTADO_STYLE[e].dot}`} />
            {ESTADO_STYLE[e].label}
          </span>
        ))}
      </div>

      {errorCarga && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            No se pudo actualizar el salón ({errorCarga}). Se está mostrando la última información
            disponible; vuelve a intentar solo.
          </span>
        </div>
      )}

      {loading ? (
        <p className="py-10 text-center text-slate-400">Cargando mesas…</p>
      ) : mesas.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center">
          <p className="text-base font-semibold text-slate-700">Todavía no hay mesas cargadas</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Creá las mesas del salón para empezar a tomar pedidos. Podés numerarlas de corrido y
            renombrarlas después.
          </p>
          <button
            type="button"
            onClick={abrirModal}
            className="mt-5 inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Crear mesas
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {mesasVisibles.map((m) => {
            const st = ESTADO_STYLE[m.mesa.estado];
            const activa = !!m.sesion;
            const dadaDeBaja = m.mesa.activo === false;
            return (
              <div key={m.mesa.id} className={`relative ${dadaDeBaja ? "opacity-60" : ""}`}>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => abrirEdicion(m)}
                  className="absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white/90 text-slate-400 shadow-sm backdrop-blur transition-colors hover:border-[#4FAEB2]/50 hover:text-[#3F8E91]"
                  aria-label={`Editar mesa ${m.mesa.numero}`}
                  title="Editar o borrar"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (dadaDeBaja) { abrirEdicion(m); return; }
                  router.push(`/mesas/${m.mesa.id}`);
                }}
                className={`group flex min-h-[150px] w-full flex-col items-center justify-center gap-2 rounded-3xl border p-5 text-center shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md active:scale-[0.98] ${st.card}`}
              >
                <div className={`flex h-14 w-14 items-center justify-center rounded-2xl text-2xl font-extrabold transition-transform duration-200 group-hover:scale-105 ${st.tile}`}>
                  {m.mesa.numero}
                </div>
                <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-slate-400">
                  {m.mesa.nombre ? m.mesa.nombre : "Mesa"}
                </span>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${st.pill}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                  {dadaDeBaja ? "Dada de baja" : st.label}
                </span>
                {activa ? (
                  <div className="mt-0.5 flex flex-col items-center leading-tight">
                    <span className="text-sm font-bold tabular-nums text-slate-800">{formatGs(m.total)}</span>
                    {m.items_count > 0 && <span className="text-[11px] text-slate-400">{m.items_count} ítem(s)</span>}
                  </div>
                ) : dadaDeBaja ? (
                  <span className="mt-0.5 text-[11px] text-slate-400">Fuera del salón</span>
                ) : (
                  <span className="mt-0.5 text-[11px] text-slate-300">Tocá para abrir</span>
                )}
              </button>
              </div>
            );
          })}
        </div>
      )}

      {/* El pedido Para llevar se crea desde el salón: es el mismo momento en
          que se abre una mesa, alguien llegó. Mandarlo a otro módulo para
          escribir un nombre era un rodeo con el cliente enfrente. */}
      {plAbierto && (
        <NuevoParaLlevarModal
          onCerrar={() => setPlAbierto(false)}
          onCreado={(sesionId) => {
            setPlAbierto(false);
            router.push(`/mesas/pl/${sesionId}`);
          }}
        />
      )}

      {modalAbierto && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={() => !guardando && setModalAbierto(false)}
        >
          <div
            className="my-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-slate-800">Crear mesas</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Se crean numeradas de corrido. La capacidad de cada mesa no se carga acá.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalAbierto(false)}
                disabled={guardando}
                className="text-slate-400 transition-colors hover:text-slate-700 disabled:opacity-50"
                aria-label="Cerrar"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Numerar desde
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={desde}
                    onChange={(e) => setDesde(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Cuántas mesas
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={cantidad}
                    onChange={(e) => setCantidad(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/20"
                  />
                </div>
              </div>

              {cantNum === 1 && (
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Nombre <span className="font-normal normal-case text-slate-400">(opcional)</span>
                  </label>
                  <input
                    type="text"
                    value={nombre}
                    onChange={(e) => setNombre(e.target.value)}
                    placeholder="Ej: Terraza 1, Barra"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/20"
                  />
                </div>
              )}

              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {rangoValido
                  ? cantNum === 1
                    ? `Se creará la mesa ${desdeNum}.`
                    : `Se crearán ${cantNum} mesas, de la ${desdeNum} a la ${hasta}.`
                  : "Ingresá un número inicial y una cantidad válidos."}
                {ultimoNumero > 0 && ` La mesa más alta hoy es la ${ultimoNumero}.`}
              </p>

              {errorAlta && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{errorAlta}</span>
                </div>
              )}
              {avisoAlta && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{avisoAlta}</span>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
              <button
                type="button"
                onClick={() => setModalAbierto(false)}
                disabled={guardando}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmarAlta}
                disabled={!rangoValido || guardando}
                className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {guardando ? "Creando…" : "Crear"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Editar / borrar una mesa */}
      {editando && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm"
          onClick={() => !edGuardando && setEditando(null)}
        >
          <div
            className="my-auto w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <span
              aria-hidden
              className="pointer-events-none block h-1 bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/80 to-[#4FAEB2]/30"
            />
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-800">
                Mesa {editando.mesa.numero}
              </h2>
              <button
                type="button"
                onClick={() => setEditando(null)}
                disabled={edGuardando}
                className="text-slate-400 transition-colors hover:text-slate-700 disabled:opacity-50"
                aria-label="Cerrar"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Número
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={edNumero}
                    onChange={(e) => setEdNumero(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm tabular-nums outline-none transition-colors focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Nombre (opcional)
                  </label>
                  <input
                    type="text"
                    value={edNombre}
                    onChange={(e) => setEdNombre(e.target.value)}
                    placeholder="Ej: Terraza"
                    maxLength={60}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-slate-400 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                  />
                </div>
              </div>

              {/* Solo aparece cuando hay algo que perder: para una mesa sin uso,
                  el botón "Borrar" de abajo ya la elimina sin ceremonia. */}
              {impacto && impacto.sesiones > 0 && (
                <div className="rounded-xl border border-red-200 bg-red-50/60 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-red-700">
                    Borrado definitivo
                  </p>
                  <p className="mt-1 text-xs text-red-800">
                    Esta mesa tiene {impacto.sesiones} cuenta{impacto.sesiones === 1 ? "" : "s"} con{" "}
                    {impacto.items} línea{impacto.items === 1 ? "" : "s"} de pedido y {impacto.comandas}{" "}
                    comanda{impacto.comandas === 1 ? "" : "s"} de cocina. Borrarla los elimina para siempre.
                    {impacto.facturadas > 0 && (
                      <> Las {impacto.facturadas} venta{impacto.facturadas === 1 ? "" : "s"} ya
                      facturada{impacto.facturadas === 1 ? "" : "s"} se conserva{impacto.facturadas === 1 ? "" : "n"},
                      pero pierde{impacto.facturadas === 1 ? "" : "n"} el vínculo con la mesa.</>
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => borrarDefinitivo(editando)}
                    disabled={edGuardando || impacto.cuenta_viva}
                    title={impacto.cuenta_viva ? "Cerrá o cancelá la cuenta abierta antes de borrar" : undefined}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Borrar definitivamente
                  </button>
                </div>
              )}

              {editando.mesa.activo === false && (
                <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Esta mesa está fuera del salón: no se ve para tomar pedidos, pero conserva su
                  número y su historial de cuentas. Reactivala para volver a usarla.
                </p>
              )}

              {editando.sesion && (
                <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  Esta mesa tiene una cuenta abierta. Cambiarle el número ahora puede confundir al
                  mozo que la está atendiendo.
                </p>
              )}

              {edError && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {edError}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
              {editando.mesa.activo === false ? (
                <button
                  type="button"
                  onClick={() => reactivarMesa(editando)}
                  disabled={edGuardando}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-semibold text-emerald-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  Reactivar
                </button>
              ) : impacto && impacto.sesiones > 0 ? (
                <button
                  type="button"
                  onClick={() => eliminarMesa(editando)}
                  disabled={edGuardando}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  Dar de baja
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => eliminarMesa(editando)}
                  disabled={edGuardando}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Borrar
                </button>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditando(null)}
                  disabled={edGuardando}
                  className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200/60 disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={guardarEdicion}
                  disabled={edGuardando || !edNumero.trim()}
                  className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#3F8E91] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {edGuardando ? "Guardando…" : "Guardar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
