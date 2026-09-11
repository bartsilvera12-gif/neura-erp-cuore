"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { getProveedores } from "@/lib/proveedores/storage";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import ImportExcelButton from "@/components/ui/ImportExcelButton";
import { confirmar } from "@/components/ui/ConfirmDialog";
import { useIsAdmin } from "@/lib/auth/use-is-admin";
import {
  avisoError, badgeNeutro, badgeOk, btnIcono, btnIconoPeligro, btnPrimario,
  btnSecundario, card, cardHead, celdaVacia, input, tabla, tbody, td, th,
  thRow, thead, tr,
} from "@/lib/ui/estilos";
import type { Proveedor } from "@/lib/proveedores/types";

export default function ProveedoresPage() {
  const { isAdmin } = useIsAdmin();
  const [lista, setLista] = useState<Proveedor[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [borrandoId, setBorrandoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setCargando(true);
    getProveedores().then((rows) => {
      if (!cancel) {
        setLista(rows);
        setCargando(false);
      }
    });
    return () => {
      cancel = true;
    };
  }, [refreshKey]);

  const filtradas = useMemo(() => {
    const t = busqueda.trim().toLowerCase();
    if (!t) return lista;
    return lista.filter((p) => {
      const cats = (p.categorias ?? []).map((c) => c.nombre.toLowerCase()).join(" ");
      return (
        p.nombre.toLowerCase().includes(t) ||
        (p.ruc ?? "").toLowerCase().includes(t) ||
        (p.email ?? "").toLowerCase().includes(t) ||
        cats.includes(t)
      );
    });
  }, [lista, busqueda]);

  /**
   * Borra el proveedor. Si ya tiene órdenes de compra el servidor devuelve 409:
   * esas compras son documentos y tienen que seguir diciendo a quién se le
   * compró, así que en ese caso se ofrece darlo de baja en lugar de borrarlo.
   */
  async function eliminar(p: Proveedor) {
    const ok = await confirmar(`¿Borrar el proveedor "${p.nombre}"?`, { confirmLabel: "Borrar" });
    if (!ok) return;

    setBorrandoId(p.id);
    setError(null);
    try {
      const r = await fetch(`/api/proveedores/${p.id}`, { method: "DELETE", credentials: "include" });
      const j = await r.json().catch(() => ({}));

      if (r.status === 409 && j?.puede_desactivar) {
        const baja = await confirmar(`${j.error}\n\n¿Querés darlo de baja?`, {
          confirmLabel: "Dar de baja",
          destructivo: false,
        });
        if (!baja) return;
        const r2 = await fetch(`/api/proveedores/${p.id}?desactivar=1`, {
          method: "DELETE",
          credentials: "include",
        });
        const j2 = await r2.json().catch(() => ({}));
        if (!r2.ok || !j2?.success) setError(j2?.error ?? "No se pudo dar de baja.");
        else setRefreshKey((k) => k + 1);
        return;
      }

      if (!r.ok || !j?.success) setError(j?.error ?? "No se pudo borrar el proveedor.");
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setBorrandoId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">Proveedores</h1>
          <p className="mt-1 text-sm text-slate-500">
            Maestro de abastecimiento: categorías, condiciones de pago y vínculo con compras.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportExcelButton url="/api/proveedores/export" />
          <ImportExcelButton
            entidad="Proveedores"
            previewUrl="/api/proveedores/import/preview"
            commitUrl="/api/proveedores/import/commit"
            templateUrl="/api/proveedores/import/template"
            permiteCrearFaltantes
            visible={isAdmin}
            onCompleted={() => setRefreshKey((k) => k + 1)}
          />
          <Link href="/proveedores/categorias" className={btnSecundario}>
            <Tags className="h-4 w-4 text-[#3F8E91]" aria-hidden />
            Categorías
          </Link>
          <Link href="/proveedores/nuevo" className={btnPrimario}>
            <Plus className="h-4 w-4" aria-hidden />
            Nuevo proveedor
          </Link>
        </div>
      </div>

      {error && <div className={avisoError}>{error}</div>}

      <div className={card}>
        <div className={cardHead}>
          <input
            type="search"
            placeholder="Buscar por nombre, RUC, email o categoría…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className={`${input} min-w-[240px] max-w-xl flex-1`}
          />
          <span className="text-xs text-slate-500">
            {filtradas.length} de {lista.length}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className={tabla}>
            <thead className={thead}>
              <tr className={thRow}>
                <th className={th}>Proveedor</th>
                <th className={th}>RUC</th>
                <th className={th}>Contacto</th>
                <th className={th}>Categorías</th>
                <th className={th}>Estado</th>
                <th className={`${th} text-right`}>Acciones</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {cargando ? (
                <tr><td colSpan={6} className={celdaVacia}>Cargando…</td></tr>
              ) : filtradas.length === 0 ? (
                <tr>
                  <td colSpan={6} className={celdaVacia}>
                    {lista.length === 0 ? "No hay proveedores cargados." : "Sin resultados."}
                  </td>
                </tr>
              ) : (
                filtradas.map((p) => (
                  <tr key={p.id} className={tr}>
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-slate-800">{p.nombre}</div>
                      {p.nombre_comercial && (
                        <div className="text-xs text-slate-500">{p.nombre_comercial}</div>
                      )}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-600">{p.ruc ?? "—"}</td>
                    <td className={td}>
                      <div>{p.contacto ?? "—"}</div>
                      {p.telefono && <div className="text-xs text-slate-400">{p.telefono}</div>}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {(p.categorias ?? []).length === 0 ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          p.categorias!.map((c) => (
                            <span
                              key={c.id}
                              className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-500/10"
                            >
                              {c.nombre}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={p.estado === "activo" ? badgeOk : badgeNeutro}>
                        {p.estado === "activo" ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link
                          href={`/proveedores/${p.id}/editar`}
                          className={btnIcono}
                          aria-label={`Editar ${p.nombre}`}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Link>
                        <button
                          type="button"
                          onClick={() => eliminar(p)}
                          disabled={borrandoId === p.id}
                          className={btnIconoPeligro}
                          aria-label={`Borrar ${p.nombre}`}
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
