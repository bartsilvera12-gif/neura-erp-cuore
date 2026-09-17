"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { crearParaLlevar } from "@/lib/mesas/storage";

/**
 * Alta de un pedido Para llevar: nombre del cliente y nota para cocina.
 *
 * Vive en un componente propio porque se crea desde dos lados —el tablero de
 * Para llevar y el salón de Mesas— y es el mismo acto: alguien llegó al
 * mostrador. Con una copia en cada pantalla, agregar un campo mañana obligaría
 * a acordarse de las dos.
 */
export interface NuevoParaLlevarModalProps {
  /** Se llama con el id de la sesión creada, para llevar al detalle del pedido. */
  onCreado: (sesionId: string) => void;
  onCerrar: () => void;
}

type Modalidad = "delivery" | "retira";

const inputBase =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";

export default function NuevoParaLlevarModal({ onCreado, onCerrar }: NuevoParaLlevarModalProps) {
  const [nombre, setNombre] = useState("");
  const [modalidad, setModalidad] = useState<Modalidad>("retira");
  const [direccion, setDireccion] = useState("");
  const [notaExtra, setNotaExtra] = useState("");
  // Costo de delivery: los chips son atajos frecuentes, "Otro" despliega un
  // input para cualquier monto. 0 = sin costo cargado todavía; se puede
  // editar después desde el detalle del pedido si se olvidó ahora.
  const [costoDelivery, setCostoDelivery] = useState<number>(0);
  const [otroCostoAbierto, setOtroCostoAbierto] = useState(false);
  const [otroCostoTexto, setOtroCostoTexto] = useState("");
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chipsCostoDelivery = [10000, 15000, 20000];
  function formatGs(n: number) { return `Gs. ${n.toLocaleString("es-PY")}`; }
  function elegirCosto(monto: number) {
    setCostoDelivery(monto);
    setOtroCostoAbierto(false);
    setOtroCostoTexto("");
  }
  function guardarOtroCosto() {
    const n = Math.max(0, Math.round(Number(otroCostoTexto.replace(/[^\d]/g, "")) || 0));
    setCostoDelivery(n);
    setOtroCostoAbierto(false);
  }

  async function crear() {
    setError(null);
    // Delivery sin dirección no llega. Se pide antes de encolar el pedido a
    // cocina, no después: si sale sin dirección hay que llamar al cliente.
    if (modalidad === "delivery" && direccion.trim().length === 0) {
      setError("La dirección de entrega es obligatoria para delivery.");
      return;
    }
    // Componemos la nota que va a cocina en un formato que el ticket sabe leer:
    //   Delivery: <dirección>      → "COMANDA - DELIVERY" + bloque de dirección
    //   Retira en el local         → "COMANDA - HORNO"
    // Cualquier nota extra viaja después, entre paréntesis.
    const partes: string[] = [];
    if (modalidad === "delivery") {
      partes.push(`Delivery: ${direccion.trim()}`);
    } else {
      partes.push("Retira en el local");
    }
    if (notaExtra.trim().length > 0) partes.push(`(${notaExtra.trim()})`);
    const notaFinal = partes.join(" ");

    setCreando(true);
    const r = await crearParaLlevar(
      nombre.trim() || null,
      notaFinal,
      modalidad === "delivery" ? costoDelivery : 0,
    );
    setCreando(false);
    if (!r.success) { setError(r.error); return; }
    onCreado(r.sesion.id);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={() => !creando && onCerrar()}
    >
      {/* Mismo material que ConfirmDialog: borde, franja de marca y sombra
          profunda. Sin eso el modal se lee como un diálogo del navegador. */}
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/80 to-[#4FAEB2]/30"
        />
        <div className="px-5 pb-4 pt-5">
          <h3 className="text-lg font-bold text-slate-800">Nuevo Para llevar</h3>
          <p className="mt-1 text-sm text-slate-500">El correlativo PL se asigna solo.</p>

          <label className="mt-3 block text-xs font-medium text-slate-600">Nombre del cliente</label>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej: Ramón"
            maxLength={120}
            disabled={creando}
            autoFocus
            className={`mt-1 text-base ${inputBase}`}
            onKeyDown={(e) => { if (e.key === "Enter") void crear(); }}
          />

          {/* Modalidad: define el título de la comanda y si hace falta pedir
              la dirección. Se elige antes de la dirección para que el campo
              aparezca sólo cuando corresponde. */}
          <label className="mt-4 block text-xs font-medium text-slate-600">Modalidad</label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(["retira", "delivery"] as Modalidad[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={creando}
                onClick={() => setModalidad(m)}
                className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors ${
                  modalidad === m
                    ? "border-amber-500 bg-amber-50 text-amber-800"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {m === "delivery" ? "Delivery" : "Retira en el local"}
              </button>
            ))}
          </div>

          {modalidad === "delivery" && (
            <>
              <label className="mt-3 block text-xs font-medium text-slate-600">
                Dirección de entrega <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={direccion}
                onChange={(e) => setDireccion(e.target.value)}
                placeholder="Ej: Avda. España 742 c/ San José"
                maxLength={200}
                disabled={creando}
                className={`mt-1 text-sm ${inputBase}`}
                onKeyDown={(e) => { if (e.key === "Enter") void crear(); }}
              />

              {/* Costo de delivery: chips rápidos + "Otro" que despliega un
                  input para cargar cualquier monto. Se puede dejar en 0 y
                  editar después desde el detalle del pedido. */}
              <label className="mt-3 block text-xs font-medium text-slate-600">Costo delivery</label>
              <div className="mt-1 flex flex-wrap gap-2">
                {chipsCostoDelivery.map((monto) => (
                  <button
                    key={monto}
                    type="button"
                    disabled={creando}
                    onClick={() => elegirCosto(monto)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
                      costoDelivery === monto && !otroCostoAbierto
                        ? "border-emerald-500 bg-emerald-50 text-emerald-800"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {formatGs(monto)}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={creando}
                  onClick={() => setOtroCostoAbierto((v) => !v)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
                    otroCostoAbierto || (costoDelivery > 0 && !chipsCostoDelivery.includes(costoDelivery))
                      ? "border-emerald-500 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Otro
                </button>
              </div>

              {otroCostoAbierto && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={otroCostoTexto}
                    onChange={(e) => setOtroCostoTexto(e.target.value)}
                    placeholder="Ej: 12000"
                    disabled={creando}
                    autoFocus
                    className={`text-sm ${inputBase}`}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); guardarOtroCosto(); } }}
                  />
                  <button
                    type="button"
                    disabled={creando}
                    onClick={guardarOtroCosto}
                    className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Guardar
                  </button>
                </div>
              )}

              {costoDelivery > 0 && !otroCostoAbierto && (
                <p className="mt-1.5 text-xs text-slate-500">
                  Se cobra <strong>{formatGs(costoDelivery)}</strong> aparte del pedido.
                  <button
                    type="button"
                    onClick={() => elegirCosto(0)}
                    className="ml-2 text-red-600 hover:underline"
                  >
                    Quitar
                  </button>
                </p>
              )}
            </>
          )}

          <label className="mt-3 block text-xs font-medium text-slate-600">Nota extra (opcional)</label>
          <input
            type="text"
            value={notaExtra}
            onChange={(e) => setNotaExtra(e.target.value)}
            placeholder="Ej: sin picante, entregar 21:00"
            maxLength={200}
            disabled={creando}
            className={`mt-1 text-sm ${inputBase}`}
            onKeyDown={(e) => { if (e.key === "Enter") void crear(); }}
          />

          {error && (
            <p className="mt-2 text-sm text-red-600">
              <AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
          <button
            type="button"
            disabled={creando}
            onClick={onCerrar}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200/60 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={creando}
            onClick={() => void crear()}
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {creando ? "Creando…" : "Crear"}
          </button>
        </div>
      </div>
    </div>
  );
}
