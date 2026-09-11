"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { FacturaElectronicaPanel } from "@/components/sifen/FacturaElectronicaPanel";
import type {
  FacturaElectronicaDTO,
  SifenCancelacionPreviewDTO,
  SifenJobDTO,
} from "@/lib/sifen/types";

type FacturaApiRow = {
  id: string;
  numero_factura: string;
  fecha: string;
  fecha_vencimiento: string;
  monto: number;
  saldo: number;
  estado: string;
  tipo: string;
  moneda: string;
  cliente_id: string | null;
  cliente_display?: string;
  /** Si la factura fue creada por el puente venta→factura, tiene el uuid de la venta origen. */
  origen_venta_id?: string | null;
};

type SifenResumen = {
  sifen_config_exists: boolean;
  sifen_config_activa: boolean;
  sifen_ambiente: string | null;
  sifen_plazo_cancelacion_horas: number;
  factura_electronica: FacturaElectronicaDTO | null;
  cancelacion: SifenCancelacionPreviewDTO | null;
  sifen_job: SifenJobDTO | null;
  cancelacion_confirmada_set?: boolean;
};

function formatFecha(str: string) {
  if (!str) return "—";
  const [y, m, d] = str.split("-");
  return `${d}/${m}/${y}`;
}

function FacturaDetalleInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params?.id as string | undefined;

  const [factura, setFactura] = useState<FacturaApiRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [resumen, setResumen] = useState<SifenResumen | null>(null);
  const [loadingF, setLoadingF] = useState(true);
  const [loadingS, setLoadingS] = useState(true);
  const [ncResumen, setNcResumen] = useState<{
    monto_acreditado: number;
    monto_pendiente_aprobacion: number;
    cantidad_ncs: number;
    cantidad_aprobadas: number;
  } | null>(null);

  /** Evita reabrir el KUDE en cada refresco del resumen. */
  const kudeAbierto = useRef(false);

  const onResumenLoaded = useCallback((r: SifenResumen) => {
    setResumen(r);
    // Viene de cobrar con factura: el comprobante que se lleva el cliente es el
    // KUDE, así que se abre solo apenas está aprobado.
    if (
      searchParams.get("kude") === "1" &&
      !kudeAbierto.current &&
      r.factura_electronica?.estado_sifen === "aprobado"
    ) {
      kudeAbierto.current = true;
      try {
        window.open(`/api/facturas/${id}/sifen/kude?auto=1`, "_blank", "noopener");
      } catch { /* el navegador puede bloquearlo: queda el botón del panel */ }
    }
  }, [searchParams, id]);

  const reloadFacturaComercial = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${id}`);
      const j = (await res.json()) as { success?: boolean; data?: FacturaApiRow; error?: string };
      if (res.ok && j.success && j.data) setFactura(j.data);
    } catch {
      /* ignorar */
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoadingF(true);
      setLoadErr(null);
      try {
        const res = await fetchWithSupabaseSession(`/api/facturas/${id}`);
        const j = (await res.json()) as { success?: boolean; data?: FacturaApiRow; error?: string };
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          setFactura(null);
          return;
        }
        if (!res.ok || !j.success || !j.data) {
          setLoadErr(j.error ?? "No se pudo cargar la factura");
          setFactura(null);
          return;
        }
        setNotFound(false);
        setFactura(j.data);
      } catch {
        if (!cancelled) setLoadErr("Error de red");
      } finally {
        if (!cancelled) setLoadingF(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoadingS(true);
      try {
        const res = await fetchWithSupabaseSession(`/api/facturas/${id}/sifen/resumen`);
        const j = (await res.json()) as { success?: boolean; data?: SifenResumen };
        if (cancelled) return;
        if (res.ok && j.success && j.data) setResumen(j.data);
        else setResumen(null);
      } catch {
        if (!cancelled) setResumen(null);
      } finally {
        if (!cancelled) setLoadingS(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Agregados de notas de crédito de esta factura (monto acreditado / pendiente).
  // No bloqueante: si falla, la ficha se muestra igual sin la sección extra.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithSupabaseSession(`/api/facturas/${id}/notas-credito`, { cache: "no-store" });
        const j = (await res.json()) as {
          success?: boolean;
          data?: { resumen?: typeof ncResumen };
        };
        if (cancelled) return;
        if (res.ok && j.success && j.data?.resumen) {
          setNcResumen(j.data.resumen);
        }
      } catch {
        /* silencioso */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (searchParams?.get("print") === "1" && factura && !loadingF) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [searchParams, factura, loadingF]);

  if (!id) {
    return null;
  }

  if (loadingF) {
    return (
      <div className="max-w-6xl mx-auto py-20 text-center text-sm text-slate-400">Cargando factura…</div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-6xl mx-auto py-20 text-center space-y-3">
        <p className="text-slate-600">Factura no encontrada.</p>
        <Link href="/gestion-clientes" className="text-[#0EA5E9] text-sm font-medium hover:underline">
          Volver a gestión de clientes
        </Link>
      </div>
    );
  }

  if (loadErr || !factura) {
    return (
      <div className="max-w-6xl mx-auto py-20 text-center space-y-3">
        <p className="text-red-600 text-sm">{loadErr ?? "Error"}</p>
        <Link href="/gestion-clientes" className="text-[#0EA5E9] text-sm font-medium hover:underline">
          Volver
        </Link>
      </div>
    );
  }

  const monedaLabel = factura.moneda === "USD" ? "USD" : "Gs.";

  return (
    <div className="max-w-6xl mx-auto space-y-6 py-6 px-4 sm:px-6 print:px-0 w-full">
      <div className="flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div>
          {/* Back link: si la factura viene del puente venta→factura, volvemos a Ventas.
              Si no (suscripción / plan), mantenemos el back histórico a Gestión de clientes. */}
          {factura.origen_venta_id ? (
            <Link
              href="/ventas"
              className="text-xs font-medium text-[#0EA5E9] hover:underline"
            >
              ← Ventas
            </Link>
          ) : factura.cliente_id ? (
            <Link
              href={`/gestion-clientes?cliente=${encodeURIComponent(factura.cliente_id)}`}
              className="text-xs font-medium text-[#0EA5E9] hover:underline"
            >
              ← Gestión de clientes
            </Link>
          ) : (
            <Link
              href="/gestion-clientes"
              className="text-xs font-medium text-[#0EA5E9] hover:underline"
            >
              ← Gestión de clientes
            </Link>
          )}
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Factura {factura.numero_factura}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Cliente:{" "}
            {factura.cliente_id ? (
              <Link href={`/clientes/${factura.cliente_id}`} className="text-[#0EA5E9] font-medium hover:underline">
                {factura.cliente_display ?? "Ver cliente"}
              </Link>
            ) : (
              <span className="text-slate-700 font-medium">{factura.cliente_display ?? "Consumidor final"}</span>
            )}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-5 space-y-3">
        <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Resumen comercial</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-slate-400 text-xs">Emisión</dt>
            <dd className="font-medium text-slate-800">{formatFecha(factura.fecha)}</dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Vencimiento</dt>
            <dd className="font-medium text-slate-800">{formatFecha(factura.fecha_vencimiento)}</dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Tipo</dt>
            <dd className="font-medium text-slate-800 capitalize">{factura.tipo}</dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Monto</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">
              {monedaLabel}{" "}
              {factura.monto.toLocaleString(factura.moneda === "USD" ? "en-US" : "es-PY")}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Saldo</dt>
            <dd className="font-semibold text-slate-900 tabular-nums">
              {monedaLabel}{" "}
              {factura.saldo.toLocaleString(factura.moneda === "USD" ? "en-US" : "es-PY")}
            </dd>
          </div>
          <div>
            <dt className="text-slate-400 text-xs">Estado</dt>
            <dd className="font-medium text-slate-800">{factura.estado}</dd>
          </div>
        </dl>

        {ncResumen && ncResumen.cantidad_ncs > 0 && (
          <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/50 px-3 py-2.5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Notas de crédito</p>
                <p className="font-semibold text-slate-800">
                  {ncResumen.cantidad_ncs}{" "}
                  <span className="text-[11px] font-normal text-slate-500">
                    ({ncResumen.cantidad_aprobadas} aprob.)
                  </span>
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Acreditado</p>
                <p className="font-semibold text-emerald-800 tabular-nums">
                  {monedaLabel}{" "}
                  {ncResumen.monto_acreditado.toLocaleString(factura.moneda === "USD" ? "en-US" : "es-PY")}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Pendiente NC</p>
                <p className="font-semibold text-amber-900 tabular-nums">
                  {monedaLabel}{" "}
                  {ncResumen.monto_pendiente_aprobacion.toLocaleString(factura.moneda === "USD" ? "en-US" : "es-PY")}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">Saldo restante</p>
                <p className="font-bold text-slate-900 tabular-nums">
                  {monedaLabel}{" "}
                  {factura.saldo.toLocaleString(factura.moneda === "USD" ? "en-US" : "es-PY")}
                </p>
              </div>
            </div>
            <p className="mt-1.5 text-[10px] text-slate-500">
              &quot;Acreditado&quot; suma NC ya aprobadas por SIFEN (ya restadas del saldo). &quot;Pendiente&quot;
              son NC en borrador o esperando SET (no impactan saldo aún).
            </p>
          </div>
        )}
      </div>

      <FacturaElectronicaPanel
        facturaId={id}
        clienteId={factura.cliente_id ?? ""}
        facturaComercial={{
          monto: factura.monto,
          saldo: factura.saldo,
          estado: factura.estado,
          moneda: factura.moneda,
          cliente_display: factura.cliente_display ?? "",
        }}
        resumen={resumen}
        loadingResumen={loadingS}
        onResumenLoaded={onResumenLoaded}
        onComercialUpdated={reloadFacturaComercial}
      />
    </div>
  );
}

export default function FacturaDetallePage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-6xl mx-auto py-20 text-center text-sm text-slate-400">Cargando factura…</div>
      }
    >
      <FacturaDetalleInner />
    </Suspense>
  );
}
