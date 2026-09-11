"use client";

import { Check, Sandwich } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

interface ProductoHit {
  id: string;
  nombre: string;
  precio_venta: number;
  imagen_url: string | null;
  categoria: string | null;
  /** true = reventa (muestra stock); false = menú/elaborado (badge "Menú"). */
  controla_stock: boolean;
  /** Solo presente en reventa; null en menú/elaborado. */
  stock_actual: number | null;
}

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

/** Modal táctil: categorías grandes + cards de productos con imagen. */
export default function MesaProductPicker({
  open, onClose, onAdd,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Agrega un producto. Devuelve true si se aceptó (optimista). Recibe datos del
   * producto para render instantáneo en la lista de la mesa.
   */
  onAdd: (
    producto: { id: string; nombre: string; precio_venta: number },
    cantidad: number,
    observacion: string | null
  ) => Promise<boolean>;
}) {
  const [productos, setProductos] = useState<ProductoHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [catSel, setCatSel] = useState<string>("__todas__");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<ProductoHit | null>(null);
  const [cant, setCant] = useState(1);
  const [obs, setObs] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    fetchWithSupabaseSession("/api/mesas/productos", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setProductos((j?.data?.items ?? []) as ProductoHit[]))
      .catch(() => setProductos([]))
      .finally(() => setLoading(false));
  }, [open]);

  const categorias = useMemo(() => {
    const set = new Set<string>();
    for (const p of productos) set.add(p.categoria || "Sin categoría");
    return [...set].sort();
  }, [productos]);

  const filtrados = useMemo(() => {
    const term = q.trim().toLowerCase();
    return productos.filter((p) => {
      const cat = p.categoria || "Sin categoría";
      if (catSel !== "__todas__" && cat !== catSel) return false;
      if (term && !p.nombre.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [productos, catSel, q]);

  if (!open) return null;

  function elegir(p: ProductoHit) {
    setSel(p); setCant(1); setObs(""); setFeedback(null);
  }

  async function confirmar() {
    if (!sel) return;
    const prod = sel;
    // Optimista: el agregado aparece instantáneo en la mesa; no bloqueamos el modal.
    setFeedback(`${prod.nombre} agregado`);
    setSel(null);
    setTimeout(() => setFeedback(null), 1500);
    void onAdd({ id: prod.id, nombre: prod.nombre, precio_venta: prod.precio_venta }, cant, obs.trim() || null);
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-start justify-center bg-slate-900/60 p-2 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div className="flex max-h-[96dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 p-3">
          <h3 className="text-lg font-semibold text-slate-800">Agregar productos</h3>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100">Cerrar</button>
        </div>

        {/* Buscador + categorías */}
        <div className="border-b border-slate-200 p-3">
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar producto…"
            className="mb-3 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-[#0EA5E9]"
          />
          <div className="flex flex-wrap gap-2">
            <CatChip active={catSel === "__todas__"} onClick={() => setCatSel("__todas__")}>Todas</CatChip>
            {categorias.map((c) => (
              <CatChip key={c} active={catSel === c} onClick={() => setCatSel(c)}>{c}</CatChip>
            ))}
          </div>
        </div>

        {/* Grid productos */}
        <div className="flex-1 overflow-y-auto p-3">
          {feedback && <div className="mb-3 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700"><Check className="h-4 w-4 shrink-0" aria-hidden />{feedback}</div>}
          {loading ? (
            <p className="py-10 text-center text-slate-400">Cargando productos…</p>
          ) : filtrados.length === 0 ? (
            <p className="py-10 text-center text-slate-400">Sin productos.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {filtrados.map((p) => (
                <button
                  key={p.id} type="button" onClick={() => elegir(p)}
                  className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition hover:border-[#0EA5E9] active:scale-95"
                >
                  <div className="h-24 w-full bg-slate-100">
                    {p.imagen_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imagen_url} alt={p.nombre} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-300"><Sandwich className="h-6 w-6" aria-hidden /></div>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="line-clamp-2 text-sm font-medium text-slate-800">{p.nombre}</p>
                    <p className="mt-0.5 text-sm font-bold text-[#0EA5E9]">{formatGs(p.precio_venta)}</p>
                    {/* Reventa → stock; menú/elaborado → badge (no se bloquea por stock). */}
                    {p.controla_stock ? (
                      <p className={`mt-0.5 text-[11px] font-medium ${(p.stock_actual ?? 0) <= 0 ? "text-red-500" : "text-slate-500"}`}>
                        {(p.stock_actual ?? 0) <= 0 ? "Sin stock" : `Stock: ${p.stock_actual}`}
                      </p>
                    ) : (
                      <span className="mt-0.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">Menú</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Panel cantidad/observación */}
        {sel && (
          <div className="border-t border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-800">{sel.nombre}</p>
                <p className="text-xs text-slate-500">{formatGs(sel.precio_venta)} c/u · subtotal {formatGs(sel.precio_venta * cant)}</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setCant((c) => Math.max(1, c - 1))} className="h-11 w-11 rounded-lg border border-slate-300 bg-white text-xl font-bold">−</button>
                <span className="w-10 text-center text-lg font-bold tabular-nums">{cant}</span>
                <button type="button" onClick={() => setCant((c) => c + 1)} className="h-11 w-11 rounded-lg border border-slate-300 bg-white text-xl font-bold">+</button>
              </div>
            </div>
            <input
              value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observación (ej: sin cebolla)"
              className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-[#0EA5E9]"
            />
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setSel(null)} className="rounded-lg border border-slate-200 px-4 py-3 text-sm">Cancelar</button>
              <button type="button" onClick={confirmar} className="flex-1 rounded-lg bg-[#0EA5E9] px-4 py-3 text-base font-semibold text-white hover:bg-[#0284C7]">
                Agregar a la mesa
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CatChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${active ? "bg-[#0EA5E9] text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
    >
      {children}
    </button>
  );
}
