"use client";

import Link from "next/link";
import { BarChart3, Landmark, Receipt, ShoppingBag, TrendingUp } from "lucide-react";
import { card } from "@/lib/ui/estilos";

function ReportCard({
  href, titulo, descripcion, boton, icon: Icon,
}: {
  href: string; titulo: string; descripcion: string; boton: string; icon: typeof BarChart3;
}) {
  return (
    <Link
      href={href}
      className={`${card} group flex flex-col p-5 transition-shadow hover:shadow-md`}
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#4FAEB2]/20 bg-gradient-to-br from-[#4FAEB2]/12 to-[#4FAEB2]/5 text-[#3F8E91]">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <h2 className="text-base font-semibold text-slate-800">{titulo}</h2>
      </div>
      <p className="mt-3 flex-1 text-sm text-slate-500">{descripcion}</p>
      <span className="mt-4 text-sm font-semibold text-[#3F8E91] group-hover:underline">
        {boton} →
      </span>
    </Link>
  );
}

export default function ReportesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Reportes</h1>
        <p className="mt-1 text-sm text-slate-500">Ventas, caja, compras y control bancario.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ReportCard
          href="/reportes/ventas"
          titulo="Ventas"
          descripcion="Cuánto se vendió y por dónde salió cada pedido: salón, delivery o retiro, con los más vendidos y cómo pagaron."
          boton="Ver ventas"
          icon={TrendingUp}
        />
        <ReportCard
          href="/reportes/compras"
          titulo="Compras"
          descripcion="Qué se compró y a quién, con el desglose por proveedor y por producto, y cuánto quedó a crédito."
          boton="Ver compras"
          icon={ShoppingBag}
        />
        <ReportCard
          href="/reportes/cierres-caja"
          titulo="Cierres de caja"
          descripcion="Aperturas, cierres, movimientos y diferencias por turno."
          boton="Ver cierres"
          icon={BarChart3}
        />
        <ReportCard
          href="/reportes/estado-cuenta"
          titulo="Estado de cuenta"
          descripcion="Resumen financiero por cajas cerradas."
          boton="Ver estado"
          icon={Receipt}
        />
        <ReportCard
          href="/reportes/conciliacion-bancaria"
          titulo="Conciliación bancaria"
          descripcion="Control de pagos por transferencia y tarjeta asociados a cajas y ventas."
          boton="Ver conciliación"
          icon={Landmark}
        />
      </div>
    </div>
  );
}
