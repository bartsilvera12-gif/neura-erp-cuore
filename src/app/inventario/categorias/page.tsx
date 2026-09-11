"use client";

import SelectField from "@/components/ui/SelectField";
import Link from "next/link";
import { useEffect, useState, useMemo } from "react";
import BuscadorLista, { coincideBusqueda } from "@/components/ui/BuscadorLista";
import { ArrowLeft, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import ImportExcelButton from "@/components/ui/ImportExcelButton";
import { confirmar } from "@/components/ui/ConfirmDialog";
import { useIsAdmin } from "@/lib/auth/use-is-admin";
import {
  avisoError, avisoInfo, badgeNeutro, badgeOk, btnChico, btnGhost, btnIcono,
  btnIconoPeligro, btnPrimario, card, cardHead, celdaVacia, input, label,
  tabla, tbody, td, tdFuerte, th, thRow, thead, tr,
} from "@/lib/ui/estilos";

interface Categoria {
  id: string;
  nombre: string;
  codigo: string | null;
  descripcion: string | null;
  parent_id: string | null;
  activo: boolean;
}

export default function CategoriasProductosPage() {
  const { isAdmin } = useIsAdmin();
  const [items, setItems] = useState<Categoria[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Alta
  const [nombre, setNombre] = useState("");
  const [codigo, setCodigo] = useState("");
  const [parentId, setParentId] = useState("");
  const [creating, setCreating] = useState(false);

  // Edición: se hace sobre la propia fila, no en un modal aparte. Son tres
  // campos cortos y así se ve el resto de la tabla mientras se corrige.
  const [editId, setEditId] = useState<string | null>(null);
  const [editNombre, setEditNombre] = useState("");
  const [editCodigo, setEditCodigo] = useState("");
  const [editParent, setEditParent] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [borrandoId, setBorrandoId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/inventario/categorias?todas=1", { credentials: "include" });
      const j = await r.json();
      if (r.ok && j?.success) setItems(j.data.categorias as Categoria[]);
      else setError(j?.error ?? "No se pudo cargar.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function handleCrear(e: React.FormEvent) {
    e.preventDefault();
    if (!nombre.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/inventario/categorias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          nombre: nombre.trim(),
          codigo: codigo.trim() || null,
          parent_id: parentId || null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j?.success) setError(j?.error ?? "No se pudo crear.");
      else {
        setNombre(""); setCodigo(""); setParentId("");
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setCreating(false);
    }
  }

  function abrirEdicion(c: Categoria) {
    setEditId(c.id);
    setEditNombre(c.nombre);
    setEditCodigo(c.codigo ?? "");
    setEditParent(c.parent_id ?? "");
    setError(null);
  }

  async function guardarEdicion() {
    if (!editId || guardando || !editNombre.trim()) return;
    setGuardando(true);
    setError(null);
    try {
      const r = await fetch(`/api/inventario/categorias/${editId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          nombre: editNombre.trim(),
          codigo: editCodigo.trim() || null,
          parent_id: editParent || null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j?.success) setError(j?.error ?? "No se pudo guardar.");
      else { setEditId(null); await load(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setGuardando(false);
    }
  }

  async function toggleActivo(cat: Categoria) {
    const r = await fetch(`/api/inventario/categorias/${cat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ activo: !cat.activo }),
    });
    const j = await r.json();
    if (r.ok && j?.success) load();
    else setError(j?.error ?? "No se pudo actualizar.");
  }

  /**
   * Borra de verdad. Si la categoría ya está en uso el servidor responde 409 y
   * ofrecemos la baja lógica: los productos ya clasificados conservan su
   * categoría y sólo deja de aparecer al cargar nuevos.
   */
  async function eliminar(c: Categoria) {
    const ok = await confirmar(`¿Borrar la categoría "${c.nombre}"?`, {
      confirmLabel: "Borrar",
    });
    if (!ok) return;

    setBorrandoId(c.id);
    setError(null);
    try {
      const r = await fetch(`/api/inventario/categorias/${c.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const j = await r.json().catch(() => ({}));

      if (r.status === 409 && j?.puede_desactivar) {
        const baja = await confirmar(`${j.error}\n\n¿Querés desactivarla?`, {
          confirmLabel: "Desactivar",
          destructivo: false,
        });
        if (!baja) return;
        const r2 = await fetch(`/api/inventario/categorias/${c.id}?desactivar=1`, {
          method: "DELETE",
          credentials: "include",
        });
        const j2 = await r2.json().catch(() => ({}));
        if (!r2.ok || !j2?.success) setError(j2?.error ?? "No se pudo desactivar.");
        else await load();
        return;
      }

      if (!r.ok || !j?.success) setError(j?.error ?? "No se pudo borrar.");
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setBorrandoId(null);
    }
  }

  const activas = items.filter((i) => i.activo);
  // El selector de categoría padre sigue mostrando todas: filtrar la tabla no
  // debería quitarte opciones al editar.
  const visibles = useMemo(
    () => items.filter((c) => coincideBusqueda(busqueda, c.nombre, c.codigo)),
    [items, busqueda]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">Categorías de productos</h1>
          <p className="mt-1 text-sm text-slate-500">Clasificá tus productos para reportes y búsqueda.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportExcelButton url="/api/inventario/categorias/export" />
          <ImportExcelButton
            entidad="Categorías"
            previewUrl="/api/inventario/categorias/import/preview"
            commitUrl="/api/inventario/categorias/import/commit"
            templateUrl="/api/inventario/categorias/import/template"
            permiteCrearFaltantes
            visible={isAdmin}
            onCompleted={load}
          />
          <Link href="/inventario" className={btnGhost}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Volver a Inventario
          </Link>
        </div>
      </div>

      <div className={`${avisoInfo} max-w-3xl`}>
        Estas categorías aparecen en el selector <strong>Categoría principal</strong> de Nuevo producto.
        Los <Link href="/proveedores/categorias" className="font-medium underline underline-offset-2">rubros de proveedor</Link>{" "}
        también se importan automáticamente acá, así no tenés que cargarlos dos veces.
      </div>

      {error && <div className={avisoError}>{error}</div>}

      {/* Alta */}
      <div className={`${card} max-w-3xl`}>
        <div className={cardHead}>
          <h2 className="text-base font-semibold text-slate-800">Nueva categoría</h2>
        </div>
        <form onSubmit={handleCrear} className="grid grid-cols-1 items-end gap-3 p-5 md:grid-cols-3">
          <div>
            <label className={label}>Nombre</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Ej: BEBIDAS"
              className={input}
              required
            />
          </div>
          <div>
            <label className={label}>Código (opcional)</label>
            <input
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              placeholder="Ej: BEB"
              className={input}
            />
          </div>
          <div>
            <label className={label}>Categoría padre (opcional)</label>
            <SelectField value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— ninguna —</option>
              {activas.map((i) => (
                <option key={i.id} value={i.id}>{i.nombre}</option>
              ))}
            </SelectField>
          </div>
          <div className="md:col-span-3">
            <button type="submit" disabled={creating || !nombre.trim()} className={btnPrimario}>
              <Plus className="h-4 w-4" aria-hidden />
              {creating ? "Creando…" : "Crear categoría"}
            </button>
          </div>
        </form>
      </div>

      {/* Lista */}
      <div className={card}>
        <div className={cardHead}>
          <div>
            <h2 className="text-base font-semibold text-slate-800">Categorías</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {items.length} en total · {activas.length} activa{activas.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="border-b border-slate-100 px-5 py-3">
          <BuscadorLista
            valor={busqueda}
            onChange={setBusqueda}
            placeholder="Buscar categoría por nombre o código…"
            mostrando={visibles.length}
            total={items.length}
          />
        </div>
        <div className="overflow-x-auto">
          <table className={tabla}>
            <thead className={thead}>
              <tr className={thRow}>
                <th className={th}>Nombre</th>
                <th className={th}>Código</th>
                <th className={th}>Padre</th>
                <th className={th}>Estado</th>
                <th className={`${th} text-right`}>Acciones</th>
              </tr>
            </thead>
            <tbody className={tbody}>
              {loading ? (
                <tr><td colSpan={5} className={celdaVacia}>Cargando…</td></tr>
              ) : visibles.length === 0 ? (
                <tr><td colSpan={5} className={celdaVacia}>{busqueda.trim() ? "Ninguna categoría coincide con la búsqueda." : "Todavía no cargaste categorías."}</td></tr>
              ) : (
                visibles.map((c) => {
                  const parent = items.find((i) => i.id === c.parent_id);
                  const enEdicion = editId === c.id;

                  if (enEdicion) {
                    return (
                      <tr key={c.id} className="bg-[#4FAEB2]/5">
                        <td className="px-5 py-3">
                          <input
                            value={editNombre}
                            onChange={(e) => setEditNombre(e.target.value)}
                            className={input}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void guardarEdicion();
                              if (e.key === "Escape") setEditId(null);
                            }}
                          />
                        </td>
                        <td className="px-5 py-3">
                          <input
                            value={editCodigo}
                            onChange={(e) => setEditCodigo(e.target.value)}
                            placeholder="—"
                            className={input}
                          />
                        </td>
                        <td className="px-5 py-3" colSpan={2}>
                          <SelectField value={editParent} onChange={(e) => setEditParent(e.target.value)} size="sm">
                            <option value="">— ninguna —</option>
                            {activas.filter((i) => i.id !== c.id).map((i) => (
                              <option key={i.id} value={i.id}>{i.nombre}</option>
                            ))}
                          </SelectField>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={guardarEdicion}
                              disabled={guardando || !editNombre.trim()}
                              className={btnIcono}
                              aria-label="Guardar cambios"
                              title="Guardar"
                            >
                              <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditId(null)}
                              className={btnIcono}
                              aria-label="Cancelar edición"
                              title="Cancelar"
                            >
                              <X className="h-4 w-4" aria-hidden />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={c.id} className={tr}>
                      <td className={tdFuerte}>{c.nombre}</td>
                      <td className={`${td} text-slate-500`}>{c.codigo ?? "—"}</td>
                      <td className={`${td} text-slate-500`}>{parent?.nombre ?? "—"}</td>
                      <td className={td}>
                        <span className={c.activo ? badgeOk : badgeNeutro}>
                          {c.activo ? "Activo" : "Inactivo"}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => toggleActivo(c)}
                            className={`${btnGhost} ${btnChico}`}
                          >
                            {c.activo ? "Desactivar" : "Activar"}
                          </button>
                          <button
                            type="button"
                            onClick={() => abrirEdicion(c)}
                            className={btnIcono}
                            aria-label={`Editar ${c.nombre}`}
                            title="Editar"
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => eliminar(c)}
                            disabled={borrandoId === c.id}
                            className={btnIconoPeligro}
                            aria-label={`Borrar ${c.nombre}`}
                            title="Borrar"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
