"use client";

import { AlertTriangle, CheckCircle2, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { listarImpresoras, guardarImpresora, probarImpresora } from "@/lib/impresoras/storage";
import { SECTOR_LABEL, type Impresora, type SectorImpresora } from "@/lib/impresoras/types";

type FeedbackTipo = "ok" | "error";
interface EstadoBloque {
  ip: string;
  puerto: string;
  guardando: boolean;
  probando: boolean;
  feedback: { tipo: FeedbackTipo; texto: string } | null;
}

const SECTORES: { key: SectorImpresora; descripcion: string }[] = [
  { key: "pizzeria", descripcion: "Comandas de pizzas, calzones y adicionales." },
  { key: "plancha",  descripcion: "Comandas de hamburguesas, lomitos, papas y postres." },
  { key: "caja",     descripcion: "Tickets de venta para el cliente." },
];

function bloqueInicial(): EstadoBloque {
  return { ip: "", puerto: "9100", guardando: false, probando: false, feedback: null };
}

export default function ConfiguracionImpresorasPage() {
  const [cargando, setCargando] = useState(true);
  const [bloques, setBloques] = useState<Record<SectorImpresora, EstadoBloque>>({
    pizzeria: bloqueInicial(),
    plancha:  bloqueInicial(),
    caja:     bloqueInicial(),
  });

  useEffect(() => {
    let vivo = true;
    listarImpresoras().then((r) => {
      if (!vivo) return;
      if (r.success) {
        setBloques((prev) => {
          const next = { ...prev };
          for (const imp of r.impresoras) {
            next[imp.sector] = {
              ...prev[imp.sector],
              ip: imp.ip,
              puerto: String(imp.puerto),
            };
          }
          return next;
        });
      }
      setCargando(false);
    });
    return () => { vivo = false; };
  }, []);

  function editar(sector: SectorImpresora, patch: Partial<EstadoBloque>) {
    setBloques((prev) => ({ ...prev, [sector]: { ...prev[sector], ...patch, feedback: null } }));
  }

  async function guardar(sector: SectorImpresora) {
    const b = bloques[sector];
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(b.ip.trim())) {
      editar(sector, { feedback: { tipo: "error", texto: "IP inválida. Ej: 192.168.1.50" } });
      return;
    }
    const puerto = Number(b.puerto);
    if (!Number.isFinite(puerto) || puerto <= 0) {
      editar(sector, { feedback: { tipo: "error", texto: "Puerto inválido." } });
      return;
    }
    editar(sector, { guardando: true });
    const r = await guardarImpresora(sector, b.ip.trim(), puerto);
    setBloques((prev) => ({
      ...prev,
      [sector]: {
        ...prev[sector],
        guardando: false,
        feedback: r.success
          ? { tipo: "ok", texto: "Configuración guardada." }
          : { tipo: "error", texto: r.error },
      },
    }));
  }

  async function probar(sector: SectorImpresora) {
    const b = bloques[sector];
    if (!b.ip.trim() || !Number(b.puerto)) {
      editar(sector, { feedback: { tipo: "error", texto: "Cargá IP y puerto antes de probar." } });
      return;
    }
    editar(sector, { probando: true });
    const r = await probarImpresora(sector, b.ip.trim(), Number(b.puerto));
    setBloques((prev) => ({
      ...prev,
      [sector]: {
        ...prev[sector],
        probando: false,
        feedback: r.success
          ? { tipo: "ok", texto: "Ticket de prueba enviado. Verificá que haya salido el papel." }
          : { tipo: "error", texto: r.error },
      },
    }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Impresoras</h1>
        <p className="text-sm text-slate-500">
          Configuración de las impresoras térmicas conectadas por red (LAN) al ERP. Se
          conectan por TCP directo — no hace falta driver ni PC en cocina.
        </p>
      </div>

      {cargando ? (
        <p className="py-10 text-center text-slate-400">Cargando…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {SECTORES.map(({ key, descripcion }) => {
            const b = bloques[key];
            return (
              <div key={key} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start gap-2">
                  <Printer className="mt-0.5 h-5 w-5 text-slate-500" aria-hidden />
                  <div>
                    <h2 className="text-base font-semibold text-slate-800">{SECTOR_LABEL[key]}</h2>
                    <p className="text-xs text-slate-500">{descripcion}</p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600">IP</label>
                  <input
                    type="text"
                    value={b.ip}
                    onChange={(e) => editar(key, { ip: e.target.value })}
                    placeholder="192.168.1.50"
                    disabled={b.guardando || b.probando}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600">Puerto</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={b.puerto}
                    onChange={(e) => editar(key, { puerto: e.target.value })}
                    placeholder="9100"
                    disabled={b.guardando || b.probando}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    Casi siempre 9100 (RAW). Dejarlo así.
                  </p>
                </div>

                <div className="mt-1 flex flex-col gap-2">
                  <button
                    type="button"
                    disabled={b.guardando || b.probando}
                    onClick={() => guardar(key)}
                    className="rounded-lg bg-[#4FAEB2] px-3 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50"
                  >
                    {b.guardando ? "Guardando…" : "Guardar"}
                  </button>
                  <button
                    type="button"
                    disabled={b.guardando || b.probando}
                    onClick={() => probar(key)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {b.probando ? "Probando…" : "Probar impresión"}
                  </button>
                </div>

                {b.feedback && (
                  <div
                    className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                      b.feedback.tipo === "ok"
                        ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border border-red-200 bg-red-50 text-red-700"
                    }`}
                  >
                    {b.feedback.tipo === "ok"
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                    <span>{b.feedback.texto}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
