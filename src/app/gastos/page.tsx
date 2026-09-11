"use client";

import { confirmar } from "@/components/ui/ConfirmDialog";
import { Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import BuscadorLista, { coincideBusqueda } from "@/components/ui/BuscadorLista";
import { getGastos, deleteGasto } from "@/lib/gastos/actions";
import {
  avisoError, badgeMarca, badgeNeutro, btnIcono, btnIconoPeligro, btnPrimario,
  card, cardHead, celdaVacia, tabla, tbody, td, tdFuerte, th, thRow, thead, tr,
} from "@/lib/ui/estilos";
import type { Gasto } from "@/lib/gastos/actions";

function formatGs(valor: number) {
  return `Gs. ${valor.toLocaleString("es-PY")}`;
}

function formatFecha(fecha: string) {
  try {
    const d = new Date(fecha);
    return d.toLocaleDateString("es-PY", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return fecha;
  }
}

export default function GastosPage() {
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(true);
  const [eliminando, setEliminando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getGastos()
      .then(setGastos)
      .catch(() => setGastos([]))
      .finally(() => setCargando(false));
  }, []);

  async function handleEliminar(g: Gasto) {
    const nombre = g.descripcion || g.categoria || "sin descripción";
    if (!(await confirmar(`¿Borrar el gasto "${nombre}"?`, { confirmLabel: "Borrar" }))) return;
    setEliminando(g.id);
    setError(null);
    try {
      await deleteGasto(g.id);
      setGastos((prev) => prev.filter((x) => x.id !== g.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo borrar el gasto.");
    } finally {
      setEliminando(null);
    }
  }

  /** Lo que se ve con el buscador puesto. */
  const visibles = useMemo(
    () => gastos.filter((g) => coincideBusqueda(busqueda, g.descripcion, g.categoria, g.monto)),
    [gastos, busqueda]
  );
  // El total acompaña a lo que se está viendo: si el filtro muestra tres gastos
  // y el total sigue siendo el de todos, el número no dice nada.
  const total = visibles.reduce((s, g) => s + (Number(g.monto) || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">Gastos operativos</h1>
          <p className="mt-1 text-sm text-slate-500">Registro de gastos de la empresa.</p>
        </div>
        <Link href="/gastos/nuevo" className={btnPrimario}>
          <Plus className="h-4 w-4" aria-hidden />
          Nuevo gasto
        </Link>
      </div>

      {error && <div className={avisoError}>{error}</div>}

      <div className={card}>
        <div className={cardHead}>
          <div>
            <h2 className="text-base font-semibold text-slate-800">Gastos</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {gastos.length} registrado{gastos.length === 1 ? "" : "s"}
            </p>
          </div>
          {gastos.length > 0 && (
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Total</p>
              <p className="text-base font-bold tabular-nums text-slate-800">{formatGs(total)}</p>
            </div>
          )}
        </div>

        <div className="border-b border-slate-100 px-5 py-3">
          <BuscadorLista
            valor={busqueda}
            onChange={setBusqueda}
            placeholder="Buscar por descripción, categoría o monto…"
            mostrando={visibles.length}
            total={gastos.length}
          />
        </div>

        {/* Categoría y Tipo se ocultan en pantallas chicas; min-w fuerza el
            scroll horizontal en mobile. */}
        <div className="overflow-x-auto">
          <table className={`${tabla} min-w-[720px] sm:min-w-0`}>
            <thead className={thead}>
              <tr className={thRow}>
                <th className={th}>Fecha</th>
                <th className={`${th} hidden md:table-cell`}>Categoría</th>
                <th className={th}>Descripción</th>
                <th className={`${th} text-right`}>Monto</th>
                <th className={`${th} hidden md:table-cell`}>Tipo</th>
                <th className={`${th} text-right`}>Acciones</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {cargando ? (
                <tr><td colSpan={6} className={celdaVacia}>Cargando…</td></tr>
              ) : visibles.length === 0 ? (
                <tr>
                  <td colSpan={6} className={celdaVacia}>
                    Todavía no registraste gastos.{" "}
                    <Link href="/gastos/nuevo" className="font-medium text-[#3F8E91] underline underline-offset-2">
                      Registrar el primero
                    </Link>
                  </td>
                </tr>
              ) : (
                visibles.map((g) => (
                  <tr key={g.id} className={tr}>
                    <td className={`${td} whitespace-nowrap tabular-nums`}>{formatFecha(g.fecha)}</td>
                    <td className={`${tdFuerte} hidden md:table-cell`}>{g.categoria || "—"}</td>
                    <td className={`${td} max-w-[220px] truncate`}>{g.descripcion || "—"}</td>
                    <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                      {formatGs(g.monto)}
                    </td>
                    <td className="hidden px-5 py-3.5 md:table-cell">
                      <span className={g.tipo === "fijo" ? badgeMarca : badgeNeutro}>{g.tipo}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link
                          href={`/gastos/${g.id}/editar`}
                          className={btnIcono}
                          aria-label={`Editar gasto del ${formatFecha(g.fecha)}`}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleEliminar(g)}
                          disabled={eliminando === g.id}
                          className={btnIconoPeligro}
                          aria-label={`Borrar gasto del ${formatFecha(g.fecha)}`}
                          title="Borrar"
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
        </div>
      </div>
    </div>
  );
}
