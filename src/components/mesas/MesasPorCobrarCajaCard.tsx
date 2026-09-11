"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getMesasPorCobrar } from "@/lib/mesas/storage";

function formatGs(v: number) { return `Gs. ${Math.round(v).toLocaleString("es-PY")}`; }

/** Card compacta en Caja: cuántas mesas hay por cobrar + acceso a facturarlas. */
export default function MesasPorCobrarCajaCard() {
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => getMesasPorCobrar().then((d) => {
      if (cancelled) return;
      setCount(d.length);
      setTotal(d.reduce((s, m) => s + m.total, 0));
    });
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (count === 0) return null;

  return (
    <Link
      href="/ventas/mesas-por-cobrar"
      className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50/70 p-4 shadow-sm transition-colors hover:bg-rose-50"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-rose-700">Mesas por cobrar</p>
        <p className="mt-0.5 text-sm text-slate-600">
          <strong>{count}</strong> mesa(s) esperando cobro · {formatGs(total)}
        </p>
      </div>
      <span className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white">Facturar →</span>
    </Link>
  );
}
