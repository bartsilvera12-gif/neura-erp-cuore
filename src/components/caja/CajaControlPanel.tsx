"use client";

import { AlertTriangle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import MontoInput from "@/components/ui/MontoInput";
import {
  abrirCaja,
  cerrarCaja,
  getCajaAbierta,
  getResumenCaja,
  registrarMovimiento,
} from "@/lib/caja/storage";
import type { Caja, CajaResumen, MedioPagoCaja, TipoMovimientoCaja } from "@/lib/caja/types";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

function formatFechaHora(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-PY", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-[#0EA5E9] bg-white text-sm";

type ModalKind = null | "abrir" | "cerrar" | "mov";

export default function CajaControlPanel({
  onStateChange,
}: {
  /** Notifica al padre si hay (o no) caja abierta, para habilitar/bloquear ventas. */
  onStateChange?: (abierta: boolean) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [caja, setCaja] = useState<Caja | null>(null);
  const [resumen, setResumen] = useState<CajaResumen | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const c = await getCajaAbierta();
    setCaja(c);
    onStateChange?.(!!c);
    setResumen(c ? await getResumenCaja(c.id) : null);
    setLoading(false);
  }, [onStateChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && !caja) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-400 shadow-sm">
        Cargando estado de caja…
      </div>
    );
  }

  return (
    <>
      {caja ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
                  Caja abierta · N° {caja.numero_caja}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                Apertura: <strong>{formatFechaHora(caja.fecha_apertura)}</strong> · Monto inicial{" "}
                <strong>{formatGs(caja.monto_apertura)}</strong>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setModal("mov")}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Movimiento de caja
              </button>
              <button
                type="button"
                onClick={() => setModal("cerrar")}
                className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-700"
              >
                Cerrar caja
              </button>
            </div>
          </div>

          {resumen && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total vendido" value={formatGs(resumen.total_vendido)} sub={`${resumen.cantidad_ventas} venta(s)`} />
              <Stat label="Efectivo" value={formatGs(resumen.total_efectivo)} />
              <Stat label="Transferencia" value={formatGs(resumen.total_transferencia)} />
              <Stat label="QR" value={formatGs(resumen.total_qr)} />
              <Stat label="Tarjeta" value={formatGs(resumen.total_tarjeta)} />
              <Stat
                label="Debería haber en caja"
                value={formatGs(resumen.efectivo_esperado)}
                sub="apertura + efectivo ± mov."
                accent
              />
              <Stat label="Ingresos efvo." value={formatGs(resumen.ingresos_efectivo)} />
              <Stat label="Egresos efvo." value={formatGs(resumen.egresos_efectivo)} />
              <Stat label="Retiros efvo." value={formatGs(resumen.retiros_efectivo)} />
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-amber-700">
                  Caja cerrada
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                Para vender primero tenés que <strong>abrir caja</strong>.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModal("abrir")}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700"
            >
              Abrir caja
            </button>
          </div>
        </div>
      )}

      {modal === "abrir" && (
        <AbrirCajaModal onClose={() => setModal(null)} onDone={() => { setModal(null); void refresh(); }} />
      )}
      {modal === "cerrar" && caja && resumen && (
        <CerrarCajaModal
          caja={caja}
          resumen={resumen}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); void refresh(); }}
        />
      )}
      {modal === "mov" && caja && (
        <MovimientoModal onClose={() => setModal(null)} onDone={() => { setModal(null); void refresh(); }} />
      )}
    </>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 ${accent ? "border-emerald-300 bg-emerald-100/60" : "border-slate-200 bg-white"}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm font-bold tabular-nums text-slate-900">{value}</p>
      {sub && <p className="text-[10px] text-slate-400">{sub}</p>}
    </div>
  );
}

// ── Modal shell ────────────────────────────────────────────────────────────────

/**
 * Modal centrado, montado en `document.body` vía portal.
 *
 * El portal no es decorativo: el panel vive dentro de `<main>`, que es un
 * contenedor con scroll propio dentro de un shell `h-svh overflow-hidden`. Ahí
 * el overlay quedaba recortado y el fondo oscuro no llegaba hasta abajo.
 * Colgándolo del body, `inset-0` cubre siempre el viewport completo.
 *
 * `items-center` con `overflow-y-auto` en el overlay: el modal queda centrado, y
 * si el contenido no entra en pantallas bajas, el overlay scrollea en vez de
 * cortar el panel.
 */
function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!montado) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="my-auto flex max-h-[88vh] w-full max-w-md flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <h3 className="text-base font-semibold text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Cerrar (Esc)"><X className="inline h-4 w-4 align-[-0.125em]" aria-hidden /></button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function ErrorBanner({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
      <AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {msg}
    </div>
  );
}

// ── Abrir ────────────────────────────────────────────────────────────────────

function AbrirCajaModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [monto, setMonto] = useState("");
  const [obs, setObs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    setSaving(true);
    const r = await abrirCaja(parseFloat(monto) || 0, obs.trim() || null);
    setSaving(false);
    if (!r.success) { setError(r.error); return; }
    onDone();
  }

  return (
    <ModalShell title="Abrir caja" onClose={onClose}>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">Monto de apertura (Gs.)</label>
      <MontoInput value={monto} onChange={(n) => setMonto(String(n))} placeholder="Ej: 300.000" className={inputClass} decimals={false} />
      <label className="mb-1.5 mt-3 block text-sm font-medium text-slate-700">Observación (opcional)</label>
      <textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2} className={inputClass} placeholder="Ej: turno noche" />
      <ErrorBanner msg={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50">Cancelar</button>
        <button type="button" onClick={submit} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {saving ? "Abriendo…" : "Abrir caja"}
        </button>
      </div>
    </ModalShell>
  );
}

// ── Cerrar ───────────────────────────────────────────────────────────────────

function CerrarCajaModal({
  caja, resumen, onClose, onDone,
}: { caja: Caja; resumen: CajaResumen; onClose: () => void; onDone: () => void }) {
  const [monto, setMonto] = useState("");
  const [obs, setObs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // El turno ya se cerró: se queda mostrando el botón del arqueo en vez de
  // cerrar el modal. La impresión automática se abre en una pestaña y el
  // navegador de la caja puede bloquearla; si eso pasaba, el arqueo no salía y
  // no quedaba forma de pedirlo desde acá.
  const [cerrada, setCerrada] = useState(false);

  // ── Derivados (NO cambian la fórmula del backend) ──────────────────────────
  const apertura = caja.monto_apertura;
  const transf = resumen.total_transferencia;
  const tarjeta = resumen.total_tarjeta;
  // El QR se cobra como los otros medios electrónicos y hasta ahora quedaba
  // fuera del cierre: una venta por QR no aparecía en el total esperado, así que
  // el turno cerraba con una diferencia que no existía y el cajero la buscaba en
  // el cajón. Es dinero real, y va donde van transferencias y tarjetas.
  const qr = resumen.total_qr;
  const ajustes = resumen.ajustes_efectivo;
  // Efectivo FÍSICO esperado (fuente de verdad del backend): apertura + ventas
  // efectivo + ingresos − egresos − retiros (+ ajustes). Vuelto NO cuenta: las
  // ventas en efectivo ya son el total real de la venta, no el monto recibido.
  const efectivoEsperado = resumen.efectivo_esperado;
  // Neto de movimientos manuales de efectivo (para que el cierre total cuadre).
  const manualNet = resumen.ingresos_efectivo - resumen.egresos_efectivo - resumen.retiros_efectivo + ajustes;
  // Cierre TOTAL esperado del turno = efectivo físico + transferencias + tarjetas
  //                                  = apertura + total vendido (+ movs. manuales).
  const cierreTotalEsperado = efectivoEsperado + transf + tarjeta + qr;

  const contado = parseFloat(monto) || 0;            // efectivo FÍSICO contado
  const difEfectivo = contado - efectivoEsperado;    // diferencia de efectivo físico
  const totalDeclarado = contado + transf + tarjeta + qr; // efectivo contado + medios electrónicos
  const difTotal = totalDeclarado - cierreTotalEsperado;

  async function submit() {
    setError(null);
    setSaving(true);

    // La pestaña se abre dentro del clic. Si se abriera después de que responda
    // el servidor, el navegador la trataría como emergente y la bloquearía.
    let arqueoWin: Window | null = null;
    try { arqueoWin = window.open("about:blank", "_blank"); } catch { arqueoWin = null; }

    // El backend cierra con el efectivo físico contado (diferencia = contado − esperado).
    const r = await cerrarCaja(contado, obs.trim() || null, caja.id);
    setSaving(false);
    if (!r.success) {
      try { arqueoWin?.close(); } catch { /* nada que cerrar */ }
      setError(r.error);
      return;
    }

    // El arqueo sale impreso al cerrar: es el papel que se firma y se guarda
    // con el dinero. Pedirlo aparte era invitar a que el turno se cerrara sin
    // comprobante, y después nadie puede reconstruir con qué se cerró.
    const href = `/api/caja/${caja.id}/arqueo?auto=1`;
    try {
      if (arqueoWin) arqueoWin.location.href = href;
      else window.open(href, "_blank", "noopener");
    } catch { /* queda disponible desde el botón de abajo */ }

    setCerrada(true);
  }

  if (cerrada) {
    return (
      <ModalShell title={`Caja N° ${caja.numero_caja} cerrada`} onClose={onDone}>
        <p className="text-sm text-slate-600">
          El turno quedó cerrado. El arqueo se abre en una pestaña nueva para imprimir; si el
          navegador la bloqueó, usá el botón.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <a
            href={`/api/caja/${caja.id}/arqueo?auto=1`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Imprimir arqueo
          </a>
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50"
          >
            Listo
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-snug text-slate-400">
          Después también lo podés reimprimir desde Reportes → Cierres de caja.
        </p>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`Cerrar caja N° ${caja.numero_caja}`} onClose={onClose}>
      {/* 1 · Resumen de ventas del turno */}
      <SectionLabel>Resumen de ventas del turno</SectionLabel>
      <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        <Row label="Cantidad de ventas" value={String(resumen.cantidad_ventas)} />
        <Row label="Ventas en efectivo" value={formatGs(resumen.total_efectivo)} />
        <Row label="Ventas por transferencia" value={formatGs(transf)} />
        <Row label="Ventas con tarjeta" value={formatGs(tarjeta)} />
        <Row label="Ventas por QR" value={formatGs(qr)} />
        <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold text-slate-900">
          <span>Total vendido</span><span className="tabular-nums">{formatGs(resumen.total_vendido)}</span>
        </div>
      </div>

      {/* 2 · Cierre total del turno (número protagonista) */}
      <SectionLabel className="mt-4">Cierre total del turno</SectionLabel>
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-3.5">
        <div className="space-y-1.5 text-sm">
          <Row label="Monto de apertura" value={formatGs(apertura)} />
          <Row label="Total vendido" value={`+ ${formatGs(resumen.total_vendido)}`} />
          {manualNet !== 0 && (
            <Row label="Movimientos manuales de efectivo" value={`${manualNet > 0 ? "+" : "−"} ${formatGs(Math.abs(manualNet))}`} />
          )}
        </div>
        <div className="mt-2.5 flex items-baseline justify-between border-t border-sky-200 pt-2.5">
          <span className="text-sm font-semibold text-sky-900">Cierre total esperado</span>
          <span className="text-xl font-extrabold tabular-nums text-sky-900">{formatGs(cierreTotalEsperado)}</span>
        </div>
      </div>

      {/* 3 · Desglose del cierre (cómo se compone ese total) */}
      <SectionLabel className="mt-4">Desglose del cierre</SectionLabel>
      <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
        <Row label="Efectivo físico esperado" value={formatGs(efectivoEsperado)} />
        <Row label="Transferencias registradas" value={`+ ${formatGs(transf)}`} />
        <Row label="Tarjetas registradas" value={`+ ${formatGs(tarjeta)}`} />
        <Row label="QR registrados" value={`+ ${formatGs(qr)}`} />
        <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold text-slate-900">
          <span>Total cierre esperado</span><span className="tabular-nums">{formatGs(cierreTotalEsperado)}</span>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-400">
        El <strong>efectivo físico esperado</strong> es apertura + ventas en efectivo + ingresos − egresos − retiros.
        Transferencias, tarjetas y QR suman al cierre total, pero <strong>no</strong> al efectivo físico.
      </p>

      {/* 4 · Cierre: solo efectivo físico contado */}
      <SectionLabel className="mt-4">Cierre</SectionLabel>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">Efectivo físico contado en caja (Gs.)</label>
      <MontoInput value={monto} onChange={(n) => setMonto(String(n))} placeholder="Ej: 160.000" className={inputClass} decimals={false} />
      <p className="mt-1 text-[11px] leading-snug text-slate-400">
        Ingresá solo el dinero físico disponible en caja. Transferencias, tarjetas y QR ya se toman desde las ventas registradas.
      </p>

      {/* 5 · Diferencias */}
      {monto !== "" && (
        <div className="mt-3 space-y-2">
          <DiffRow label="Diferencia de efectivo físico" hint={`contado − esperado (${formatGs(efectivoEsperado)})`} value={difEfectivo} />
          <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <span>Total declarado (efectivo + transferencias + tarjetas + QR)</span>
            <span className="tabular-nums font-medium text-slate-700">{formatGs(totalDeclarado)}</span>
          </div>
          <DiffRow label="Diferencia total del turno" hint={`declarado − cierre total (${formatGs(cierreTotalEsperado)})`} value={difTotal} />
        </div>
      )}

      <label className="mb-1.5 mt-3 block text-sm font-medium text-slate-700">Observación (opcional)</label>
      <textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2} className={inputClass} />
      <ErrorBanner msg={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50">Cancelar</button>
        <button type="button" onClick={submit} disabled={saving || monto === ""} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50">
          {saving ? "Cerrando…" : "Confirmar cierre"}
        </button>
      </div>
    </ModalShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <span>{label}</span><span className="tabular-nums">{value}</span>
    </div>
  );
}

function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${className}`}>{children}</p>
  );
}

/** Fila de diferencia con signo y color (verde = cuadra, azul = sobra, rojo = falta). */
function DiffRow({ label, hint, value }: { label: string; hint: string; value: number }) {
  const tone = value === 0 ? "bg-emerald-50 text-emerald-700" : value > 0 ? "bg-sky-50 text-sky-700" : "bg-red-50 text-red-700";
  const signo = value > 0 ? "+ " : value < 0 ? "− " : "";
  const estado = value > 0 ? "(sobra)" : value < 0 ? "(falta)" : "(cuadra)";
  return (
    <div className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold ${tone}`}>
      <span>
        {label} <span className="font-normal opacity-70">{estado}</span>
        <span className="mt-0.5 block text-[10px] font-normal opacity-60">{hint}</span>
      </span>
      <span className="tabular-nums">{signo}{formatGs(Math.abs(value))}</span>
    </div>
  );
}

// ── Movimiento ───────────────────────────────────────────────────────────────

const TIPOS: { v: TipoMovimientoCaja; label: string }[] = [
  { v: "ingreso", label: "Ingreso" },
  { v: "egreso", label: "Egreso" },
  { v: "retiro", label: "Retiro" },
  { v: "ajuste", label: "Ajuste" },
];
const MEDIOS: { v: MedioPagoCaja; label: string }[] = [
  { v: "efectivo", label: "Efectivo" },
  { v: "tarjeta", label: "Tarjeta" },
  { v: "transferencia", label: "Transferencia" },
  { v: "otro", label: "Otro" },
];

function MovimientoModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [tipo, setTipo] = useState<TipoMovimientoCaja>("ingreso");
  const [concepto, setConcepto] = useState("");
  const [monto, setMonto] = useState("");
  const [medio, setMedio] = useState<MedioPagoCaja>("efectivo");
  const [obs, setObs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    if (concepto.trim() === "") { setError("El concepto es obligatorio."); return; }
    if (!(parseFloat(monto) > 0)) { setError("El monto debe ser mayor a 0."); return; }
    setSaving(true);
    const r = await registrarMovimiento({
      tipo, concepto: concepto.trim(), monto: parseFloat(monto) || 0, medio_pago: medio, observacion: obs.trim() || null,
    });
    setSaving(false);
    if (!r.success) { setError(r.error); return; }
    onDone();
  }

  return (
    <ModalShell title="Movimiento de caja" onClose={onClose}>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">Tipo</label>
      <div className="grid grid-cols-4 gap-1">
        {TIPOS.map((t) => (
          <button key={t.v} type="button" onClick={() => setTipo(t.v)}
            className={`rounded-md border py-1.5 text-xs font-medium transition-colors ${
              tipo === t.v ? "border-[#0EA5E9] bg-[#0EA5E9]/10 text-[#0EA5E9]" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}>{t.label}</button>
        ))}
      </div>

      <label className="mb-1.5 mt-3 block text-sm font-medium text-slate-700">Concepto</label>
      <input type="text" value={concepto} onChange={(e) => setConcepto(e.target.value)} className={inputClass} placeholder="Ej: pago proveedor / retiro socio" />

      <label className="mb-1.5 mt-3 block text-sm font-medium text-slate-700">Monto (Gs.)</label>
      <MontoInput value={monto} onChange={(n) => setMonto(String(n))} placeholder="Ej: 50.000" className={inputClass} decimals={false} />

      <label className="mb-1.5 mt-3 block text-sm font-medium text-slate-700">Medio de pago</label>
      <div className="grid grid-cols-4 gap-1">
        {MEDIOS.map((m) => (
          <button key={m.v} type="button" onClick={() => setMedio(m.v)}
            className={`rounded-md border py-1.5 text-xs font-medium transition-colors ${
              medio === m.v ? "border-[#0EA5E9] bg-[#0EA5E9]/10 text-[#0EA5E9]" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}>{m.label}</button>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">Solo los movimientos en efectivo afectan el efectivo esperado.</p>

      <label className="mb-1.5 mt-3 block text-sm font-medium text-slate-700">Observación (opcional)</label>
      <textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2} className={inputClass} />
      <ErrorBanner msg={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50">Cancelar</button>
        <button type="button" onClick={submit} disabled={saving} className="rounded-lg bg-[#0EA5E9] px-4 py-2 text-sm font-medium text-white hover:bg-[#0284C7] disabled:opacity-50">
          {saving ? "Guardando…" : "Registrar"}
        </button>
      </div>
    </ModalShell>
  );
}
