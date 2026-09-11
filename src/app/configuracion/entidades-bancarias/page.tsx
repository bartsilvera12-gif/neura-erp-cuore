"use client";

import { confirmar } from "@/components/ui/ConfirmDialog";
import SelectField from "@/components/ui/SelectField";
import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { GlobalConfigSubpageShell } from "@/components/config/GlobalConfigSubpageShell";
import {
  actualizarEntidadBancaria, crearEntidadBancaria, eliminarEntidadBancaria, getEntidadesBancarias,
  type EntidadBancaria,
} from "@/lib/configuracion/entidades-bancarias";

const TIPOS = [
  { v: "banco", label: "Banco" },
  { v: "pos", label: "POS" },
  { v: "billetera", label: "Billetera" },
  { v: "qr", label: "QR" },
  { v: "otro", label: "Otro" },
] as const;
const tipoLabel = (t: string | null) => TIPOS.find((x) => x.v === t)?.label ?? "—";
const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
const input = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20";

export default function EntidadesBancariasPage() {
  const [entidades, setEntidades] = useState<EntidadBancaria[]>([]);
  const [cargando, setCargando] = useState(true);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [nNombre, setNNombre] = useState("");
  const [nBanco, setNBanco] = useState("");
  const [nTipo, setNTipo] = useState<string>("banco");
  const [nCuenta, setNCuenta] = useState("");
  const [guardando, setGuardando] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [eNombre, setENombre] = useState(""); const [eBanco, setEBanco] = useState("");
  const [eTipo, setETipo] = useState<string>("banco"); const [eCuenta, setECuenta] = useState("");

  async function recargar() { setCargando(true); setEntidades(await getEntidadesBancarias(true)); setCargando(false); }
  useEffect(() => { recargar(); }, []);

  const filtradas = useMemo(() => {
    const term = norm(q);
    if (!term) return entidades;
    return entidades.filter((e) => norm(e.nombre).includes(term) || norm(e.banco ?? "").includes(term));
  }, [entidades, q]);

  function flash(msg: string) { setOk(msg); setError(null); setTimeout(() => setOk(null), 2500); }

  async function crear() {
    if (!nNombre.trim()) { setError("El nombre es obligatorio."); return; }
    setGuardando(true);
    const r = await crearEntidadBancaria({ nombre: nNombre.trim(), banco: nBanco.trim() || null, tipo: nTipo, numero_cuenta: nCuenta.trim() || null });
    setGuardando(false);
    if (!r.success) { setError(r.error); return; }
    setNNombre(""); setNBanco(""); setNCuenta(""); setNTipo("banco");
    flash("Entidad creada."); recargar();
  }

  function abrirEdit(e: EntidadBancaria) {
    setEditId(e.id); setENombre(e.nombre); setEBanco(e.banco ?? ""); setETipo(e.tipo ?? "banco"); setECuenta(e.numero_cuenta ?? ""); setError(null);
  }
  async function guardarEdit() {
    if (!editId) return;
    const r = await actualizarEntidadBancaria(editId, { nombre: eNombre.trim(), banco: eBanco.trim() || null, tipo: eTipo, numero_cuenta: eCuenta.trim() || null });
    if (!r.success) { setError(r.error); return; }
    setEditId(null); flash("Entidad actualizada."); recargar();
  }
  async function toggleActivo(e: EntidadBancaria) {
    const r = await actualizarEntidadBancaria(e.id, { activo: !e.activo });
    if (!r.success) { setError(r.error); return; }
    flash(e.activo ? "Entidad desactivada." : "Entidad activada."); recargar();
  }
  async function eliminar(e: EntidadBancaria) {
    if (!(await confirmar(`¿Eliminar "${e.nombre}"? Si tiene conciliaciones asociadas, se desactiva en vez de borrarse.`))) return;
    const r = await eliminarEntidadBancaria(e.id);
    if (!r.success) { setError(r.error); return; }
    flash(r.eliminada ? "Entidad eliminada." : "Tiene conciliaciones: se desactivó en vez de borrarse."); recargar();
  }

  return (
    <GlobalConfigSubpageShell title="Entidades bancarias" description="Configurá bancos, POS, billeteras y cuentas usadas para transferencias, tarjetas y conciliación.">
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}</div>}
      {ok && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">{ok}</div>}

      {/* Alta */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Agregar entidad</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          <input value={nNombre} onChange={(e) => setNNombre(e.target.value)} placeholder="Nombre (ej: Ueno)" className={`${input} sm:col-span-2`} />
          <input value={nBanco} onChange={(e) => setNBanco(e.target.value)} placeholder="Banco / entidad (opcional)" className={input} />
          <SelectField value={nTipo} onChange={(e) => setNTipo(e.target.value)} className={input}>
            {TIPOS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </SelectField>
          <input value={nCuenta} onChange={(e) => setNCuenta(e.target.value)} placeholder="N° cuenta (opc.)" className={input} />
        </div>
        <button onClick={crear} disabled={guardando} className="mt-3 rounded-lg bg-[#0EA5E9] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0284C7] disabled:opacity-50">
          {guardando ? "Guardando…" : "Agregar entidad"}
        </button>
      </div>

      {/* Listado */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-800">Entidades ({entidades.length})</h2>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" className={`${input} max-w-xs`} />
        </div>
        {cargando ? <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
          : filtradas.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">No hay entidades. Agregá la primera arriba.</p>
          : (
          <ul className="divide-y divide-slate-100">
            {filtradas.map((e) => (
              <li key={e.id} className="py-3">
                {editId === e.id ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
                    <input value={eNombre} onChange={(ev) => setENombre(ev.target.value)} className={`${input} sm:col-span-2`} />
                    <input value={eBanco} onChange={(ev) => setEBanco(ev.target.value)} placeholder="Banco" className={input} />
                    <SelectField value={eTipo} onChange={(ev) => setETipo(ev.target.value)} className={input}>{TIPOS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</SelectField>
                    <input value={eCuenta} onChange={(ev) => setECuenta(ev.target.value)} placeholder="N° cuenta" className={input} />
                    <div className="flex gap-2 sm:col-span-5">
                      <button onClick={guardarEdit} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">Guardar</button>
                      <button onClick={() => setEditId(null)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-800">
                        {e.nombre}
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{tipoLabel(e.tipo)}</span>
                        {!e.activo && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Inactiva</span>}
                      </p>
                      <p className="text-xs text-slate-500">{[e.banco, e.numero_cuenta, e.moneda].filter(Boolean).join(" · ") || "—"}</p>
                    </div>
                    <div className="flex gap-1.5 text-sm">
                      <button onClick={() => abrirEdit(e)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-700 hover:bg-slate-50">Editar</button>
                      <button onClick={() => toggleActivo(e)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-700 hover:bg-slate-50">{e.activo ? "Desactivar" : "Activar"}</button>
                      <button onClick={() => eliminar(e)} className="rounded-lg border border-rose-200 px-3 py-1.5 text-rose-600 hover:bg-rose-50">Eliminar</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </GlobalConfigSubpageShell>
  );
}
