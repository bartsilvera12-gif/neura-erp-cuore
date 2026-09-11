"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type {
  FacturaElectronicaDTO,
  SifenCancelacionPreviewDTO,
  SifenConsultaLoteUltimaPersistida,
  SifenJobDTO,
} from "@/lib/sifen/types";
import { decodeXmlNumericEntities } from "@/lib/sifen/decode-xml-entities";
import { friendlyErrorMsg } from "@/lib/sifen/friendly-error-msg";
import { SifenEstadoBadge } from "./SifenEstadoBadge";
import { FacturaCorreccionFiscalNC } from "@/components/facturas/FacturaCorreccionFiscalNC";
import { useIsAdmin } from "@/lib/auth/use-is-admin";

type Resumen = {
  sifen_config_exists: boolean;
  sifen_config_activa: boolean;
  sifen_ambiente: string | null;
  sifen_plazo_cancelacion_horas: number;
  factura_electronica: FacturaElectronicaDTO | null;
  cancelacion: SifenCancelacionPreviewDTO | null;
  /** Fase 2: último Job de la cola async para este DE. */
  sifen_job: SifenJobDTO | null;
  /** La SET confirmó la cancelación (evento 0600, o 4003 "ya tenía el evento"). */
  cancelacion_confirmada_set?: boolean;
};

/**
 * Etiqueta para el badge de progreso cuando hay un Job async corriendo en el
 * server. Prefiere `sifen_job.etapa` (worker) sobre `estado_sifen` porque la
 * etapa del Job es más precisa (sabemos qué está haciendo el worker en este
 * momento, no solo el estado persistido tras cada etapa).
 */
function etiquetaProgresoJob(job: SifenJobDTO | null, estadoSifen: string | null): string | null {
  // Si el documento ya llegó a un estado definitivo, no se muestra progreso:
  // manda el documento, no el trabajo que lo produjo. El trabajo tarda un
  // instante más en marcarse terminado, y en ese hueco la pantalla mostraba
  // "Aprobado" y "Esperando respuesta SET…" al mismo tiempo, que se contradicen
  // y hacen dudar de si la factura salió o no.
  const stDoc = String(estadoSifen ?? "");
  if (stDoc === "aprobado" || stDoc === "rechazado" || stDoc === "cancelado") return null;

  if (job) {
    if (job.estado === "pendiente") return "En cola…";
    if (job.estado === "procesando") {
      switch (job.etapa) {
        case "xml":
          return "Generando XML…";
        case "firmar":
          return "Firmando…";
        case "enviar":
          return "Enviando a SET…";
        case "consulta_lote":
          return "Esperando respuesta SET…";
        default:
          return "Procesando…";
      }
    }
    return null;
  }
  // Sin job (flujo sincrónico manual) — mantiene el comportamiento anterior.
  const st = String(estadoSifen ?? "");
  if (st === "enviado" || st === "en_proceso") return "En proceso en SET";
  return null;
}

/** Una línea operativa; en producción evita jerga de pipeline/XML. */
function subtituloSifenEjecutivo(resumen: Resumen, debugUi: boolean): string {
  if (!resumen.sifen_config_activa) return "Activá SIFEN en configuración para emitir el documento electrónico.";
  const fe = resumen.factura_electronica;

  // Con un trabajo en curso el documento se está emitiendo solo, aunque su
  // estado todavía diga "borrador". Decir "pendiente" ahí invita al cajero a
  // apretar "Generar y enviar" creyendo que la pantalla se quedó trabada — y
  // eso es exactamente lo que hacía.
  const trabajoEnCurso =
    resumen.sifen_job != null &&
    (resumen.sifen_job.estado === "pendiente" || resumen.sifen_job.estado === "procesando");
  if (trabajoEnCurso && String(fe?.estado_sifen ?? "") !== "aprobado") {
    return "Emitiendo el documento. La pantalla se actualiza sola.";
  }

  if (!fe) return "Aún no hay documento electrónico.";
  if (debugUi) {
    switch (String(fe.estado_sifen)) {
      case "borrador":
        return "Siguiente: XML, firma y envío al SET.";
      case "generado":
        return "Siguiente: firma y envío al SET.";
      case "firmado":
        return "Listo para enviar el lote al SET.";
      case "enviado":
      case "en_proceso":
        return "SET procesando. Consultá el lote para ver el resultado.";
      case "aprobado":
        return "DE aprobado.";
      case "rechazado":
        return "SET rechazó el DE. Usá «Regenerar documento» para volver a generar el XML (nuevo CDC si corresponde), luego firmá y enviá.";
      case "error_envio":
        return fe.error?.trim()
          ? fe.error.trim().length > 140
            ? `${fe.error.trim().slice(0, 140)}…`
            : fe.error.trim()
          : "Falló el envío. Podés reintentar.";
      case "cancelado":
        return "Cancelado en el ERP.";
      default:
        return "Revisá el estado del documento.";
    }
  }
  switch (String(fe.estado_sifen)) {
    case "borrador":
      return "Pendiente: generar el documento electrónico.";
    case "generado":
      return "Pendiente: firmar y enviar.";
    case "firmado":
      return "Pendiente de envío al SET.";
    case "enviado":
    case "en_proceso":
      return "En proceso en el SET. Consultá el resultado del envío.";
    case "aprobado":
      return "Documento aprobado.";
    case "rechazado":
      return "El documento fue rechazado. Podés regenerar el XML y luego firmar y enviar de nuevo.";
    case "error_envio":
      return fe.error?.trim()
        ? friendlyErrorMsg({ raw: fe.error.trim(), estadoSifen: String(fe.estado_sifen) }).titulo
        : "Falló el envío. Podés reintentar.";
    case "cancelado":
      return "Documento anulado en el sistema.";
    default:
      return "Revisá el estado del documento.";
  }
}

function ResumenSifenCompacto({ resumen, debugUi }: { resumen: Resumen; debugUi: boolean }) {
  const fe = resumen.factura_electronica;
  const st = fe?.estado_sifen ?? null;
  const job = resumen.sifen_job;
  const progreso = etiquetaProgresoJob(job, st);
  return (
    <div className="flex flex-wrap items-center gap-3 min-w-0">
      <SifenEstadoBadge estadoSifen={st} mostrarPistaEnvioSet={false} className="shrink-0" />
      {progreso ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-800 ring-1 ring-sky-200 shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" aria-hidden />
          {progreso}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-600 leading-snug">{subtituloSifenEjecutivo(resumen, debugUi)}</p>
        {!resumen.sifen_config_activa ? (
          <a
            href="/configuracion/facturacion-electronica"
            className="text-xs font-semibold text-[#0EA5E9] hover:underline mt-1 inline-block"
          >
            Configuración SIFEN
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** Alineado a POST …/sifen/xml: se puede regenerar en `enviado` para corregir DE rechazado o pendiente. */
const XML_BLOQUEADOS = new Set(["aprobado", "cancelado"]);
const FIRMAR_BLOQUEADOS = new Set(["aprobado", "enviado", "cancelado", "rechazado"]);

/** Texto cuando consulta-lote no trae `gResProcLote` (0365 ≠ “sigue en cola”). */
function mensajeConsultaSinFilasPorCdc(uc: SifenConsultaLoteUltimaPersistida): string {
  const rawCod = (uc.dCodResLot ?? "").trim();
  const codSinCeros = rawCod.replace(/^0+/, "") || rawCod;
  const msg = (uc.dMsgResLot ?? "").toLowerCase();
  const loteCancelado =
    codSinCeros === "365" || /\b0365\b/.test(rawCod) || msg.includes("cancelad");
  if (loteCancelado) {
  return (
    "SET respondió que el lote está cancelado y no incluyó filas por CDC. " +
      "Eso es habitual cuando recibe-lote devolvió 0301 (todos los DE rechazados): el motivo del rechazo no se repite aquí por documento. " +
      "Revisá duplicidad de timbrado + establecimiento + punto de expedición + número de documento, el XML frente al XSD y el certificado usado al firmar."
  );
  }
  return (
    "Sin detalle por CDC en esta respuesta. Si el envío fue hace poco, el lote podría seguir en proceso: reintentá la consulta en unos minutos."
  );
}

async function readApiError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
}

function formatLimiteCancelacion(iso: string | null): string {
  if (iso == null || !iso.trim()) return "—";
  try {
    return new Date(iso).toLocaleString("es-PY", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export function FacturaElectronicaPanel({
  facturaId,
  clienteId,
  facturaComercial,
  resumen,
  loadingResumen,
  onResumenLoaded,
  onComercialUpdated,
}: {
  facturaId: string;
  /** Para atajo «cancelar y reemitir» (ficha cliente). */
  clienteId: string;
  /** Datos comerciales para NC (saldo = monto de la NC en v1). */
  facturaComercial: {
    monto: number;
    saldo: number;
    estado: string;
    moneda: string;
    cliente_display: string;
  };
  resumen: Resumen | null;
  loadingResumen: boolean;
  onResumenLoaded: (r: Resumen) => void;
  /** Tras anular la factura comercial (cancelación DE). */
  onComercialUpdated?: () => void | Promise<void>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const debugUi =
    (typeof process !== "undefined" && process.env.NODE_ENV === "development") ||
    searchParams?.get("debug") === "1";
  const [action, setAction] = useState<
    | "borrador"
    | "xml"
    | "firmar"
    | "enviar"
    | "consulta-lote"
    | "cancelar-de"
    | "pipeline"
    | "reintentar-job"
    | null
  >(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const { isAdmin: esAdmin } = useIsAdmin();
  /** Herramienta admin: reimportar el XML aprobado descargado de Marangatú. */
  const [reimportando, setReimportando] = useState(false);
  const reimportFileRef = useRef<HTMLInputElement | null>(null);
  /** true cuando el polling se cortó por timeout (90s sin cambios). Fase 3.1. */
  const [pollingCortadoPorTimeout, setPollingCortadoPorTimeout] = useState(false);
  const [cancelModal, setCancelModal] = useState<"cancelar" | "reemitir" | null>(null);
  const [motivoCancel, setMotivoCancel] = useState("");

  /**
   * Envío de la factura por correo. Se manda solo al aprobar el DE; esto es
   * para ver qué pasó y reintentar — el caso frecuente es que el correo se haya
   * tipeado mal al cobrar, así que se puede corregir sin tocar la ficha.
   */
  const [mail, setMail] = useState<{
    configurado: boolean;
    destinatario: string | null;
    envios: { destinatario: string; origen: string; ok: boolean; error: string | null; created_at: string }[];
  } | null>(null);
  const [mailDestino, setMailDestino] = useState("");
  const [mailEnviando, setMailEnviando] = useState(false);

  const refreshMail = useCallback(async () => {
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/enviar-mail`);
      const j = (await res.json()) as { success?: boolean; data?: typeof mail };
      if (res.ok && j.success && j.data) {
        setMail(j.data);
        setMailDestino((prev) => prev || j.data?.destinatario || "");
      }
    } catch {
      /* el bloque de correo simplemente no se muestra */
    }
  }, [facturaId]);

  const enviarPorMail = useCallback(async () => {
    setMailEnviando(true);
    setFlash(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/enviar-mail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: mailDestino.trim() || undefined }),
      });
      const j = (await res.json()) as { success?: boolean; data?: { message?: string }; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
      } else {
        setFlash({ kind: "ok", text: j.data?.message ?? "Factura enviada." });
      }
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setMailEnviando(false);
      await refreshMail();
    }
  }, [facturaId, mailDestino, refreshMail]);

  const refresh = useCallback(async (): Promise<Resumen | null> => {
    const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/resumen`, {
      cache: "no-store",
    });
    const j = (await res.json()) as { success?: boolean; data?: Resumen };
    if (res.ok && j.success && j.data) {
      const merged: Resumen = {
        ...j.data,
        sifen_plazo_cancelacion_horas: j.data.sifen_plazo_cancelacion_horas ?? j.data.cancelacion?.plazo_horas ?? 48,
        cancelacion: j.data.cancelacion ?? null,
      };
      onResumenLoaded(merged);
      return merged;
    }
    return null;
  }, [facturaId, onResumenLoaded]);

  const ejecutarCancelacion = async (reemitirTrasOk: boolean) => {
    setFlash(null);
    const m = motivoCancel.trim();
    if (m.length < 5) {
      setFlash({ kind: "err", text: "Indicá un motivo de al menos 5 caracteres." });
      return;
    }
    setAction("cancelar-de");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/cancelar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: m }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setFlash({ kind: "ok", text: "Documento electrónico cancelado en el ERP. La factura comercial quedó anulada." });
      setCancelModal(null);
      setMotivoCancel("");
      await refresh();
      await onComercialUpdated?.();
      if (reemitirTrasOk && clienteId.trim()) {
        router.push(`/clientes/${encodeURIComponent(clienteId.trim())}`);
      }
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  /**
   * Conciliación con SET: reenvía el evento de cancelación para facturas que
   * quedaron marcadas «canceladas» en el ERP pero NUNCA se cancelaron en la SET
   * (bug histórico: la cancelación era solo local). No cambia el estado local
   * (ya está cancelada); solo hace que la SET coincida. Si SET rechaza (fuera de
   * las 48h), hay que ir por Nota de Crédito.
   */
  const ejecutarReintentoSet = async () => {
    setFlash(null);
    const motivo = fe?.sifen_cancelacion_motivo?.trim() || "Cancelación de documento electrónico";
    setAction("cancelar-de");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/cancelar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo, reintentar_set: true }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({
          kind: "err",
          text:
            (j.error ?? `Error ${res.status}`) +
            " — Si la SET la rechaza por plazo, hay que anular con Nota de Crédito.",
        });
        return;
      }
      setFlash({ kind: "ok", text: "Cancelación registrada en la SET. La factura quedó anulada también en Marangatú." });
      await refresh();
      await onComercialUpdated?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  /**
   * Reimporta el XML firmado APROBADO (descargado de Marangatú) para una factura
   * que quedó con un CDC rechazado en el ERP. Corrige el CDC y repone el XML, así
   * la Nota de Crédito referencia el documento correcto y deja de fallar con "CDC
   * inexistente". No re-firma ni reenvía nada.
   */
  const reimportarFirmado = async (file: File) => {
    setFlash(null);
    setReimportando(true);
    try {
      const xml = await file.text();
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/reimportar-firmado`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xml }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string; data?: { cdc?: string } };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setFlash({
        kind: "ok",
        text: `Documento aprobado reimportado. CDC corregido (${j.data?.cdc ?? ""}). Ya podés emitir la Nota de Crédito.`,
      });
      await refresh();
      await onComercialUpdated?.();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setReimportando(false);
      if (reimportFileRef.current) reimportFileRef.current.value = "";
    }
  };

  const run = async (kind: "borrador" | "xml" | "firmar") => {
    setFlash(null);
    setAction(kind);
    try {
      const path =
        kind === "borrador"
          ? `/api/facturas/${facturaId}/sifen/borrador`
          : kind === "xml"
            ? `/api/facturas/${facturaId}/sifen/xml`
            : `/api/facturas/${facturaId}/sifen/firmar`;
      const res = await fetchWithSupabaseSession(path, { method: "POST" });
      if (!res.ok) {
        setFlash({ kind: "err", text: await readApiError(res) });
        return;
      }
      setFlash({
        kind: "ok",
        text:
          kind === "borrador"
            ? "Borrador electrónico listo."
            : kind === "xml"
              ? "XML generado correctamente."
              : "XML firmado correctamente.",
      });
      await refresh();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  /** Solo POST XML local (sin firma ni SET). Tras `rechazado`, el API puede reservar nueva revisión de CDC. */
  const regenerarDocumentoRechazado = async () => {
    setFlash(null);
    setAction("xml");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/xml`, { method: "POST" });
      if (!res.ok) {
        setFlash({ kind: "err", text: await readApiError(res) });
        return;
      }
      setFlash({
        kind: "ok",
        text:
          "XML regenerado desde los datos actuales del cliente (RUC/DV/tipo de contribuyente/dirección). Si el DE estaba rechazado, se asignó un nuevo CDC. Continuá con firmar y enviar. Este paso no envía datos al SET.",
      });
      await refresh();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  const etiquetaAmbienteSet =
    resumen?.sifen_ambiente === "produccion" ? "producción" : "pruebas (TEST)";

  const runEnviar = async (opts?: { accionUi?: "enviar" | "none" }) => {
    const accionUi = opts?.accionUi ?? "enviar";
    setFlash(null);
    // Guard defensivo: NUNCA reintentar /enviar si el DE ya salió de 'firmado'.
    // Estados post-envío (enviado, en_proceso, aprobado, rechazado, cancelado)
    // hacen que el backend responda 409 y dejaba pegado el flash
    //   "Solo se puede enviar a SET con estado 'firmado'. Estado actual: 'enviado'"
    // aun cuando el flujo correcto era esperar /consulta-lote. Este chequeo cubre
    // races típicas: worker Phase 3 enviando en paralelo, doble click humano,
    // ejecutarGenerarYEnviar con state stale entre refresh() y runEnviar().
    const stActual = String(fe?.estado_sifen ?? "");
    if (
      stActual === "enviado" ||
      stActual === "en_proceso" ||
      stActual === "aprobado" ||
      stActual === "rechazado" ||
      stActual === "cancelado"
    ) {
      await refresh();
      return;
    }
    if (accionUi === "enviar") setAction("enviar");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/enviar`, { method: "POST" });
      const j = (await res.json()) as {
        success?: boolean;
        data?: {
          factura_electronica?: FacturaElectronicaDTO;
          recibe_lote?: {
            loteRecibido?: boolean;
            loteNoEncolado?: boolean;
            dCodRes?: string | null;
            dProtConsLote?: string | null;
            httpStatus?: number;
          };
        };
        error?: string;
      };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }

      const feResp = j.data?.factura_electronica;
      const rec = j.data?.recibe_lote;
      const cod = String(rec?.dCodRes ?? "").trim();
      const codSinCerosIni = cod.replace(/^0+/, "") || "";
      const codigoEs0300 = cod === "0300" || codSinCerosIni === "300";
      const prot =
        rec?.dProtConsLote == null ? "" : String(rec.dProtConsLote).trim();
      const http2xx =
        rec?.httpStatus != null && rec.httpStatus >= 200 && rec.httpStatus < 300;

      /** Solo éxito real: no mostrar verde si la API guardó error_envio / rechazo de lote. */
      const loteAceptado =
        feResp?.estado_sifen === "enviado" ||
        rec?.loteRecibido === true ||
        codigoEs0300 ||
        (http2xx && prot.length > 0 && rec?.loteNoEncolado !== true);

      if (!loteAceptado) {
        if (resumen != null && feResp) {
          onResumenLoaded({ ...resumen, factura_electronica: feResp });
        }
        setFlash({
          kind: "err",
          text:
            feResp?.error?.trim() ??
            "El SET no aceptó el envío. Revisá el detalle abajo o reintentá.",
        });
        await refresh();
        return;
      }

      if (resumen != null && feResp) {
        onResumenLoaded({ ...resumen, factura_electronica: feResp });
      }
      setFlash({
        kind: "ok",
        text: `Lote enviado correctamente a SET (${etiquetaAmbienteSet})`,
      });

      const loaded = await refresh();
      if (
        feResp &&
        feResp.estado_sifen === "enviado" &&
        loaded?.factura_electronica?.estado_sifen === "error_envio" &&
        loaded.factura_electronica.id === feResp.id
      ) {
        onResumenLoaded({ ...loaded, factura_electronica: feResp });
      }
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      if (accionUi === "enviar") setAction(null);
    }
  };

  const runConsultaLote = async () => {
    setFlash(null);
    setAction("consulta-lote");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/consulta-lote`, {
        method: "POST",
      });
      const j = (await res.json()) as {
        success?: boolean;
        data?: {
          consulta_lote?: {
            dCodResLot?: string | null;
            dMsgResLot?: string | null;
            resumenInferido?: string | null;
            estadoActualizado?: boolean;
          };
        };
        error?: string;
      };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      const c = j.data?.consulta_lote;
      const msg =
        c?.resumenInferido?.trim() ||
        (c?.dCodResLot != null
          ? `${c.dCodResLot}${c.dMsgResLot != null ? ` — ${c.dMsgResLot}` : ""}`
          : null) ||
        "Consulta lote completada.";
      setFlash({ kind: "ok", text: msg });
      await refresh();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  /**
   * Reintentar la emisión encolando un nuevo Job SIFEN. Fase 2. Usa el endpoint
   * dedicado /sifen/reintentar que valida que el DE no esté aprobado y agrega
   * origen='reintento_manual' al histórico.
   */
  const reintentarJob = async () => {
    setFlash(null);
    setAction("reintentar-job");
    try {
      const res = await fetchWithSupabaseSession(
        `/api/facturas/${facturaId}/sifen/reintentar`,
        { method: "POST" }
      );
      if (!res.ok) {
        setFlash({ kind: "err", text: await readApiError(res) });
        return;
      }
      setFlash({ kind: "ok", text: "Reintento encolado. Procesando en background…" });
      await refresh();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  /** Borrador → XML → firma → envío en una sola acción (mismos endpoints). */
  const ejecutarGenerarYEnviar = async () => {
    setFlash(null);
    setAction("pipeline");
    const post = async (path: string) => {
      const res = await fetchWithSupabaseSession(path, { method: "POST" });
      if (!res.ok) {
        setFlash({ kind: "err", text: await readApiError(res) });
        return false;
      }
      return true;
    };
    try {
      let cur = await refresh();
      if (!cur?.sifen_config_activa) {
        setFlash({ kind: "err", text: "SIFEN no está activo para esta empresa." });
        return;
      }

      // Si el servidor ya está emitiendo este documento, la pantalla no vuelve
      // a hacerlo. Los dos corriendo a la vez regeneraban el XML dos veces y
      // llegaban juntos al envío: el segundo volvía como «lote no encolado» y
      // en pantalla parecía un rechazo del SET sobre una factura correcta.
      const jobVivo =
        cur.sifen_job &&
        (cur.sifen_job.estado === "pendiente" || cur.sifen_job.estado === "procesando");
      if (jobVivo) {
        setFlash({ kind: "ok", text: "El documento ya se está emitiendo. Esperá el resultado." });
        return;
      }

      if (!cur.factura_electronica) {
        if (!(await post(`/api/facturas/${facturaId}/sifen/borrador`))) return;
        cur = (await refresh()) ?? cur;
      }

      let feLocal = cur.factura_electronica;
      let st = feLocal?.estado_sifen != null ? String(feLocal.estado_sifen) : "";

      if (st === "aprobado" || st === "cancelado") {
        setFlash({ kind: "ok", text: "Documento ya finalizado." });
        return;
      }
      if (st === "rechazado") {
        setFlash({
          kind: "err",
          text:
            debugUi
              ? "SET rechazó este DE. Revisá el detalle abajo o usá pasos avanzados."
              : "El SET rechazó este documento. Revisá el mensaje de error abajo.",
        });
        return;
      }
      if (st === "enviado" || st === "en_proceso") {
        setFlash({ kind: "ok", text: "Ya consta envío a SET. Usá «Consultar lote»." });
        return;
      }

      if (st === "borrador") {
        if (!(await post(`/api/facturas/${facturaId}/sifen/xml`))) return;
        cur = (await refresh()) ?? cur;
        feLocal = cur.factura_electronica;
        st = feLocal ? String(feLocal.estado_sifen) : "";
      }

      if (st === "generado") {
        if (!(await post(`/api/facturas/${facturaId}/sifen/firmar`))) return;
        cur = (await refresh()) ?? cur;
        feLocal = cur.factura_electronica;
        st = feLocal ? String(feLocal.estado_sifen) : "";
      }

      if (st === "error_envio") {
        const signed = Boolean(feLocal?.xml_firmado_path?.trim());
        if (!signed && feLocal?.xml_path?.trim()) {
          if (!(await post(`/api/facturas/${facturaId}/sifen/firmar`))) return;
          cur = (await refresh()) ?? cur;
          feLocal = cur.factura_electronica;
          st = feLocal ? String(feLocal.estado_sifen) : "";
        }
      }

      if (st === "firmado" || (st === "error_envio" && feLocal?.xml_firmado_path?.trim())) {
        await runEnviar({ accionUi: "none" });
        await refresh();
        return;
      }

      setFlash({
        kind: "err",
        text: debugUi
          ? "No se pudo completar el envío automático. Revisá «Pasos avanzados» o el estado del DE."
          : "No se pudo completar el envío automático. Revisá el estado del documento.",
      });
      await refresh();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  const fe = resumen?.factura_electronica ?? null;
  const estado = fe?.estado_sifen ?? null;

  // Fase 2 async: llegamos con ?auto=1 (redirect desde /ventas/nueva).
  // En vez de correr el pipeline client-side (30-35s bloqueando la caja),
  // encolamos un Job SIFEN server-side y respondemos inmediatamente.
  // El worker (Fase 3) toma el Job y ejecuta xml → firmar → enviar → consulta.
  // El polling de más abajo refresca /resumen cada 5s para reflejar el progreso.
  const autoDisparadoRef = useRef(false);
  const autoFlag = searchParams?.get("auto") === "1";
  useEffect(() => {
    if (!autoFlag) return;
    if (autoDisparadoRef.current) return;
    if (loadingResumen) return;
    if (!resumen?.sifen_config_activa) return;
    const estActual = String(estado ?? "");
    // Si el DE ya está en estado terminal, no reencolamos.
    // `error_envio` y `rechazado` también los tratamos como "no auto-encolar":
    // la respuesta anterior de SET debe quedar visible para el operador. Si
    // querés reintentar tras un rechazo, usá el botón "Reintentar" (pasa por
    // el mismo endpoint /encolar pero de forma explícita). Antes reencolaba
    // solo con montar el panel y el mensaje SET desaparecía sin que se viera.
    if (
      estActual === "aprobado" ||
      estActual === "cancelado" ||
      estActual === "rechazado" ||
      estActual === "error_envio"
    ) {
      return;
    }
    // Si ya hay un Job vivo (pendiente/procesando), no encolamos otro.
    // El polling se encarga de mostrar el progreso.
    const jobActivo =
      resumen.sifen_job &&
      (resumen.sifen_job.estado === "pendiente" || resumen.sifen_job.estado === "procesando");
    if (jobActivo) {
      autoDisparadoRef.current = true;
      return;
    }
    autoDisparadoRef.current = true;
    // Fire-and-forget: no await → la UI no se bloquea. El server encola el Job
    // y responde 202 al toque. Si falla el kickoff, el operador tiene el botón
    // "Reintentar" en el panel.
    void fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/encolar`, {
      method: "POST",
    })
      .then(async () => {
        // Refresh inmediato para que la UI capte el Job recién creado y arranque
        // el badge "En cola…" sin esperar el primer tick de polling.
        await refresh();
      })
      .catch(() => {
        /* silencioso: el botón manual sigue disponible */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFlag, loadingResumen, estado, resumen?.sifen_job?.id]);

  // Polling cada 5s mientras haya un Job vivo o el DE esté en estado no terminal.
  // Corta cuando:
  //   - DE terminal: aprobado | cancelado | rechazado.
  //   - Job terminal (rechazado/error) → deja el estado del DE quieto y muestra
  //     el error persistido; el operador decide si reintenta.
  //   - 90s desde el arranque del polling sin cambios → deja de batir la API;
  //     el operador puede refrescar la página o apretar "Consultar lote".
  const pollingStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!resumen?.sifen_config_activa) return;
    const st = String(estado ?? "");
    const jobSt = resumen.sifen_job?.estado ?? null;
    const deTerminal = st === "aprobado" || st === "cancelado" || st === "rechazado";
    const jobTerminal =
      jobSt === "aprobado" || jobSt === "rechazado" || jobSt === "error" || jobSt === null;
    if (deTerminal) {
      pollingStartedAtRef.current = null;
      setPollingCortadoPorTimeout(false);
      return;
    }
    // Sin Job activo y DE en estado no-terminal (ej. flujo manual) → sin polling.
    if (jobSt == null && !autoFlag) {
      pollingStartedAtRef.current = null;
      setPollingCortadoPorTimeout(false);
      return;
    }
    // Job terminal pero DE en estado intermedio (poco común: enviado/en_proceso
    // con consulta pendiente). Dejamos de batir el server; el operador consulta.
    if (jobTerminal && st !== "enviado" && st !== "en_proceso") {
      pollingStartedAtRef.current = null;
      setPollingCortadoPorTimeout(false);
      return;
    }
    if (pollingStartedAtRef.current == null) {
      pollingStartedAtRef.current = Date.now();
      setPollingCortadoPorTimeout(false);
    }
    const start = pollingStartedAtRef.current;
    if (Date.now() - start > 90_000) {
      setPollingCortadoPorTimeout(true);
      return;
    }
    const timer = setTimeout(() => {
      void refresh();
    }, 5_000);
    return () => clearTimeout(timer);
  }, [autoFlag, estado, resumen, refresh]);

  // Al cruzar de 'firmado' a 'enviado' (o posterior) limpiamos el flash: si había
  // un error residual del tipo "Solo se puede enviar a SET con estado 'firmado'.
  // Estado actual: 'enviado'" (409 por race/reintento redundante), ya no aplica.
  // Cubre el screenshot del bug: badge "Enviado" + banner rojo pegado al mismo
  // tiempo. Solo UI — no toca ninguna lógica fiscal / envío / consulta.
  useEffect(() => {
    // Cast a string: 'en_proceso' aparece en runtime (consulta-lote SET) pero
    // no está en el union EstadoSifen; TS strict falla el compare sin el cast.
    const st = String(estado ?? "");
    if (
      st === "enviado" ||
      st === "en_proceso" ||
      st === "aprobado" ||
      st === "cancelado"
    ) {
      setFlash(null);
    }
  }, [estado]);

  // Cuando SIFEN aprueba el DE:
  //  1) El flash ya se limpió en el efecto de arriba al pasar a 'enviado'/aprobado.
  //  2) Intentamos abrir el KUDE en pestaña nueva. Un solo intento por montaje.
  //     Si el navegador bloquea el popup (Chrome lo hace cuando el open no
  //     viene de un user gesture), el operador tiene el botón "Imprimir KUDE"
  //     visible justo abajo del badge Aprobado.
  const kudeAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (estado !== "aprobado") return;
    if (kudeAutoOpenedRef.current) return;
    kudeAutoOpenedRef.current = true;
    try {
      window.open(`/api/facturas/${facturaId}/sifen/kude`, "_blank", "noopener");
    } catch {
      /* popup bloqueado — el botón "Imprimir KUDE" cubre este caso */
    }
  }, [estado, facturaId]);

  // El envío por correo sólo existe con el DE aprobado, así que el estado se
  // consulta recién ahí.
  useEffect(() => {
    if (estado !== "aprobado") return;
    void refreshMail();
  }, [estado, refreshMail]);

  const puedeBorrador = Boolean(resumen?.sifen_config_activa) && !fe;
  const puedeGenerarXml =
    Boolean(resumen?.sifen_config_activa) && fe != null && !XML_BLOQUEADOS.has(String(estado));
  const puedeFirmar =
    Boolean(resumen?.sifen_config_activa) &&
    fe != null &&
    Boolean(fe.xml_path?.trim()) &&
    !FIRMAR_BLOQUEADOS.has(String(estado)) &&
    estado !== "firmado";

  const puedeConsultarLote =
    Boolean(resumen?.sifen_config_activa) && Boolean(fe?.sifen_d_prot_cons_lote?.trim());

  const ultimaConsulta = fe?.sifen_ultima_respuesta_consulta_lote ?? null;

  /** El campo `error` solo aplica a fallos de envío/rechazo; no mostrar texto viejo si ya está enviado/aprobado/etc. */
  const mostrarErrorPersistido =
    Boolean(fe?.error?.trim()) && (estado === "error_envio" || estado === "rechazado");

  const deAprobado = Boolean(fe && String(estado) === "aprobado");

  const stStr = estado != null ? String(estado) : "";
  const primaryConsultarLote =
    Boolean(resumen?.sifen_config_activa) &&
    puedeConsultarLote &&
    (stStr === "enviado" || stStr === "en_proceso");
  const primaryGenerarYEnviar =
    Boolean(resumen?.sifen_config_activa) &&
    !primaryConsultarLote &&
    (!fe || ["borrador", "generado", "firmado", "error_envio"].includes(stStr));
  // El worker puede estar procesando esta misma factura mientras el operador
  // aprieta un botón. Los botones se bloquean mientras hay un trabajo activo;
  // el panel se refresca solo.
  //
  // Esto es la primera de tres barreras, y sola no alcanza: se apoya en el
  // último refresco, así que entre que el trabajo se encola y la pantalla se
  // entera hay una ventana. Las otras dos son la comprobación con datos
  // frescos dentro de ejecutarGenerarYEnviar, y el candado en el propio
  // endpoint de envío, que es el único lugar donde se puede garantizar que al
  // SET no le llegue el documento dos veces.
  const jobActivo =
    resumen?.sifen_job != null &&
    (resumen.sifen_job.estado === "pendiente" || resumen.sifen_job.estado === "procesando");
  const busy = action !== null || jobActivo;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-5 sm:p-6 w-full min-w-0">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-stretch">
        <div className="flex-1 min-w-0 space-y-5">
          <div>
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Factura electrónica (SIFEN)
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Ambiente SET: <span className="font-medium text-slate-700">{etiquetaAmbienteSet}</span>
            </p>
          </div>

          {loadingResumen && <p className="text-sm text-slate-400">Cargando…</p>}

          {!loadingResumen && resumen && <ResumenSifenCompacto resumen={resumen} debugUi={debugUi} />}

          {!loadingResumen && resumen && (
            <>
              {flash && (
                <div
                  className={`rounded-lg text-sm px-3 py-2 ${
                    flash.kind === "ok"
                      ? "bg-slate-50 border border-slate-200 text-slate-800"
                      : "bg-red-50 border border-red-200 text-red-900"
                  }`}
                >
                  {decodeXmlNumericEntities(flash.text)}
                </div>
              )}
              {pollingCortadoPorTimeout &&
              resumen.sifen_job &&
              (resumen.sifen_job.estado === "pendiente" ||
                resumen.sifen_job.estado === "procesando") ? (
                <div className="rounded-lg text-sm px-3 py-2 bg-amber-50 border border-amber-200 text-amber-900 space-y-1">
                  <p className="font-semibold">
                    El sistema sigue procesando en background.
                  </p>
                  <p className="text-xs">
                    Podés actualizar la página para ver el estado actualizado, o
                    usar los pasos manuales de abajo si preferís emitir ahora.
                  </p>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="text-xs font-semibold underline underline-offset-2 hover:no-underline"
                  >
                    Actualizar estado ahora
                  </button>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                {/* "Regenerar documento" también debe estar disponible en
                    estado 'error_envio' (rechazo local / falla al enviar):
                    el backend POST /sifen/xml lo permite (solo bloquea en
                    aprobado / cancelado), y en la práctica hace falta cuando
                    los datos del receptor cambiaron (p.ej. FELIX pasa de sin
                    RUC a contribuyente con RUC → nuevo XML B2B). */}
                {(stStr === "rechazado" || stStr === "error_envio") && puedeGenerarXml ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void regenerarDocumentoRechazado()}
                    title="Vuelve a leer los datos actuales del cliente (RUC, DV, tipo de contribuyente, dirección) y arma un XML nuevo con CDC nuevo. Úsalo tras corregir datos del cliente para que el reenvío no repita el mismo XML rechazado."
                    className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 text-sm font-semibold shadow-sm disabled:opacity-45 disabled:cursor-not-allowed hover:bg-slate-50"
                  >
                    {action === "xml" ? "Regenerando…" : "Regenerar XML desde datos actuales del cliente"}
                  </button>
                ) : null}
                {resumen.sifen_job &&
                (resumen.sifen_job.estado === "rechazado" ||
                  resumen.sifen_job.estado === "error") &&
                stStr !== "aprobado" &&
                stStr !== "cancelado" &&
                stStr !== "enviado" &&
                stStr !== "en_proceso" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reintentarJob()}
                    className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold shadow-sm disabled:opacity-45 disabled:cursor-not-allowed hover:bg-slate-800"
                  >
                    {action === "reintentar-job" ? "Reintentando…" : "Reintentar"}
                  </button>
                ) : null}
                {primaryConsultarLote ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runConsultaLote()}
                    className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold shadow-sm disabled:opacity-45 disabled:cursor-not-allowed hover:bg-slate-800"
                  >
                    {action === "consulta-lote" ? "Consultando…" : "Consultar lote"}
                  </button>
                ) : null}
                {primaryGenerarYEnviar ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void ejecutarGenerarYEnviar()}
                    className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-semibold shadow-sm disabled:opacity-45 disabled:cursor-not-allowed hover:bg-slate-800"
                  >
                    {action === "pipeline"
                      ? "Procesando…"
                      : stStr === "firmado" || (stStr === "error_envio" && fe?.xml_firmado_path?.trim())
                        ? "Enviar a SET"
                        : "Generar y enviar"}
                  </button>
                ) : null}
                {!primaryConsultarLote && puedeConsultarLote && stStr !== "enviado" && stStr !== "en_proceso" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runConsultaLote()}
                    className="text-sm font-medium text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline disabled:opacity-40"
                  >
                    {action === "consulta-lote" ? "Consultando…" : "Consultar lote"}
                  </button>
                ) : null}
              </div>

              {esAdmin && fe ? (
                <details className="group rounded-lg border border-dashed border-slate-300 bg-slate-50/70">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600 select-none list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
                    <span className="text-slate-400 transition-transform group-open:rotate-90 inline-block">▸</span>
                    Recuperar documento aprobado (SET)
                  </summary>
                  <div className="px-3 pb-3 pt-1 space-y-2 border-t border-slate-200/80">
                    <p className="text-[11px] text-slate-600 leading-snug">
                      Usá esto si la factura está <span className="font-semibold">aprobada en Marangatú</span> pero el
                      sistema quedó con un CDC rechazado (la Nota de Crédito falla con &quot;CDC inexistente&quot;).
                      Descargá el XML del comprobante desde Marangatú y subilo acá: se corrige el CDC y la NC vuelve a
                      funcionar. No re-firma ni reenvía nada.
                    </p>
                    <input
                      ref={reimportFileRef}
                      type="file"
                      accept=".xml,text/xml,application/xml"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void reimportarFirmado(f);
                      }}
                    />
                    <button
                      type="button"
                      disabled={reimportando}
                      onClick={() => reimportFileRef.current?.click()}
                      className="px-3 py-1.5 text-[11px] font-semibold rounded-md border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-40"
                    >
                      {reimportando ? "Subiendo…" : "Subir XML aprobado de Marangatú"}
                    </button>
                  </div>
                </details>
              ) : null}

              {debugUi ? (
                <details className="group rounded-lg border border-dashed border-amber-200 bg-amber-50/30">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-amber-900 select-none list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
                    <span className="text-amber-600 transition-transform group-open:rotate-90 inline-block">▸</span>
                    Debug: pasos SIFEN sueltos
                  </summary>
                  <div className="px-3 pb-3 pt-0 flex flex-wrap gap-2 border-t border-amber-100/80">
                    <button
                      type="button"
                      disabled={!puedeBorrador || busy}
                      onClick={() => run("borrador")}
                      className="px-2.5 py-1.5 text-[11px] font-semibold rounded-md border border-slate-200 bg-white text-slate-800 disabled:opacity-40 hover:bg-slate-50"
                    >
                      {action === "borrador" ? "…" : "Borrador"}
                    </button>
                    <button
                      type="button"
                      disabled={!puedeGenerarXml || busy}
                      onClick={() => run("xml")}
                      className="px-2.5 py-1.5 text-[11px] font-semibold rounded-md border border-slate-200 bg-white text-slate-800 disabled:opacity-40 hover:bg-slate-50"
                    >
                      {action === "xml" ? "…" : "XML"}
                    </button>
                    <button
                      type="button"
                      disabled={!puedeFirmar || busy}
                      onClick={() => run("firmar")}
                      className="px-2.5 py-1.5 text-[11px] font-semibold rounded-md border border-slate-200 bg-white text-slate-800 disabled:opacity-40 hover:bg-slate-50"
                    >
                      {action === "firmar" ? "…" : "Firmar"}
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        (stStr !== "firmado" &&
                          !(stStr === "error_envio" && Boolean(fe?.xml_firmado_path?.trim())))
                      }
                      onClick={() => void runEnviar()}
                      className="px-2.5 py-1.5 text-[11px] font-semibold rounded-md border border-slate-200 bg-white text-slate-800 disabled:opacity-40 hover:bg-slate-50"
                    >
                      {action === "enviar" ? "…" : "Solo enviar"}
                    </button>
                  </div>
                </details>
              ) : null}

              <div className="space-y-3 text-sm">
            {fe && resumen.cancelacion && estado === "aprobado" && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {resumen.cancelacion.puede_cancelar ? (
                  <span
                    className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200"
                    title={`Plazo configurado: ${resumen.sifen_plazo_cancelacion_horas ?? resumen.cancelacion.plazo_horas} h desde aprobación SET`}
                  >
                    Cancelable hasta {formatLimiteCancelacion(resumen.cancelacion.cancelable_hasta)}
                  </span>
                ) : resumen.cancelacion.requiere_nota_credito ? (
                  <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold bg-amber-50 text-amber-900 ring-1 ring-amber-200">
                    Requiere Nota de Crédito
                  </span>
                ) : (
                  resumen.cancelacion.motivo_bloqueo && (
                    <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium bg-slate-100 text-slate-700 ring-1 ring-slate-200">
                      {resumen.cancelacion.motivo_bloqueo}
                    </span>
                  )
                )}
              </div>
            )}
            {fe && estado === "cancelado" && (
              <div className="pt-1 space-y-2">
                {fe.sifen_cancelado_at && (
                  <p className="text-xs text-slate-600">
                    <span className="font-semibold text-slate-700">Cancelado en ERP:</span>{" "}
                    {formatLimiteCancelacion(fe.sifen_cancelado_at)}
                    {fe.sifen_cancelacion_motivo?.trim() ? (
                      <>
                        {" "}
                        — <span className="text-slate-500">Motivo:</span> {fe.sifen_cancelacion_motivo.trim()}
                      </>
                    ) : null}
                  </p>
                )}
                {/* Si la SET ya confirmó la cancelación (0600 / 4003) no hay nada
                    que reintentar: se muestra la confirmación en vez del aviso. */}
                {resumen.cancelacion_confirmada_set ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                    <p className="text-[11px] font-semibold text-emerald-900">
                      Cancelación confirmada por la SET
                    </p>
                    <p className="text-[11px] text-emerald-800 mt-0.5">
                      El documento figura anulado también en Marangatú. No hace falta ninguna acción adicional.
                    </p>
                  </div>
                ) : (
                  /* Reconciliación con SET: para facturas canceladas en el ERP pero
                     aún ACTIVAS en Marangatú (la cancelación era solo local). */
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-[11px] text-amber-900">
                      ¿Sigue <span className="font-semibold">activa en Marangatú</span>? Reenviá la cancelación a la SET.
                      Solo funciona dentro de las 48&nbsp;h de la aprobación; pasado ese plazo hay que anular con Nota de
                      Crédito.
                    </p>
                    <button
                      type="button"
                      disabled={action !== null}
                      onClick={() => void ejecutarReintentoSet()}
                      className="mt-2 px-3 py-1.5 text-[11px] font-semibold rounded-md bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-40"
                    >
                      {action === "cancelar-de" ? "Enviando a la SET…" : "Reintentar cancelación en SET"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {fe && estado === "aprobado" && (
              <div className="flex flex-wrap gap-2 pt-2">
                {/* Botón siempre visible cuando el DE aprueba — el auto-open
                    window.open() a veces lo bloquea el navegador (no viene
                    de un user gesture). Este botón sí viene de un click. */}
                <a
                  href={`/api/facturas/${facturaId}/sifen/kude`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 inline-flex items-center"
                >
                  Imprimir KUDE
                </a>
                <a
                  href={`/api/facturas/${facturaId}/sifen/documento`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center"
                  title="Descarga el XML firmado tal como se envió a la DNIT"
                >
                  Descargar XML
                </a>
              </div>
            )}
            {/* Sin configurar el envío no se esconde el bloque: si no, no hay
                forma de distinguir "está apagado" de "está roto". */}
            {fe && estado === "aprobado" && mail && !mail.configurado && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mt-2">
                <p className="text-xs font-semibold text-amber-900">
                  El envío por correo está apagado
                </p>
                <p className="text-[11px] text-amber-800 mt-1">
                  Faltan los datos del servidor de correo en la configuración del
                  servidor (SMTP_HOST, SMTP_PORT, SMTP_USER y SMTP_PASSWORD).
                  Mientras tanto la factura no se manda sola ni se puede reenviar.
                </p>
              </div>
            )}
            {fe && estado === "aprobado" && mail?.configurado && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 mt-2 space-y-2">
                <p className="text-xs font-semibold text-slate-700">Mandar la factura por correo</p>
                <p className="text-[11px] text-slate-500">
                  Se manda sola al aprobarse, con el KUDE en PDF y el XML firmado.
                  Si el correo quedó mal escrito, corregilo acá y reenviala.
                </p>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="email"
                    value={mailDestino}
                    onChange={(e) => setMailDestino(e.target.value)}
                    placeholder="correo del cliente"
                    className="flex-1 min-w-[200px] px-2 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-800"
                  />
                  <button
                    type="button"
                    disabled={mailEnviando || mailDestino.trim() === ""}
                    onClick={() => void enviarPorMail()}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-slate-800 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-900"
                  >
                    {mailEnviando ? "Enviando…" : "Enviar"}
                  </button>
                </div>
                {mail.envios.length > 0 && (
                  <ul className="text-[11px] text-slate-600 space-y-0.5 pt-1">
                    {mail.envios.map((e, i) => (
                      <li key={i} className="break-all">
                        <span className={e.ok ? "text-emerald-700" : "text-rose-700"}>
                          {e.ok ? "Enviada" : "Falló"}
                        </span>{" "}
                        a {e.destinatario}
                        {e.origen === "automatico" ? " (automático)" : ""}
                        {e.error ? ` — ${e.error}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {fe && estado === "aprobado" && resumen.cancelacion && (
              <div className="flex flex-wrap gap-2 pt-2">
                {resumen.cancelacion.puede_cancelar ? (
                  <>
                    <button
                      type="button"
                      disabled={action !== null}
                      onClick={() => {
                        setMotivoCancel("");
                        setCancelModal("cancelar");
                      }}
                      className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-700 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-rose-800"
                    >
                      Cancelar factura (DE)
                    </button>
                    <button
                      type="button"
                      disabled={action !== null}
                      onClick={() => {
                        setMotivoCancel("");
                        setCancelModal("reemitir");
                      }}
                      className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 text-slate-800 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
                    >
                      Cancelar y reemitir
                    </button>
                  </>
                ) : null}
              </div>
            )}
            {fe && (
              <>
                {!debugUi && (fe.cdc || fe.sifen_d_prot_cons_lote?.trim()) ? (
                  <details className="rounded-lg border border-slate-100 text-xs text-slate-600">
                    <summary className="cursor-pointer px-2 py-1.5 font-medium text-slate-700 select-none">
                      Referencias (DE)
                    </summary>
                    <div className="px-2 pb-2 pt-0 space-y-1.5">
                      <p className="text-[10px] text-slate-500 break-all">
                        <span className="font-medium text-slate-600">ID:</span> {fe.id}
                      </p>
                      {fe.cdc ? (
                        <p className="text-[10px] text-slate-500 break-all">
                          <span className="font-medium text-slate-600">CDC:</span> {fe.cdc}
                        </p>
                      ) : null}
                      {fe.sifen_d_prot_cons_lote?.trim() ? (
                        <p className="text-[10px] text-slate-500 break-all">
                          <span className="font-medium text-slate-600">Protocolo lote:</span>{" "}
                          {fe.sifen_d_prot_cons_lote}
                        </p>
                      ) : null}
                    </div>
                  </details>
                ) : null}
                {debugUi && fe ? (
                  <>
                    <p className="text-slate-600 text-xs">
                      <span className="text-slate-400">ID DE:</span>{" "}
                      <code className="bg-slate-100 px-1 rounded break-all">{fe.id}</code>
                    </p>
                    {fe.cdc ? (
                      <p className="text-slate-600 text-xs break-all">
                        <span className="text-slate-400">CDC:</span>{" "}
                        <code className="bg-slate-100 px-1 rounded break-all">{fe.cdc}</code>
                      </p>
                    ) : null}
                    <details className="rounded-lg border border-slate-200 bg-slate-50/50 text-xs">
                      <summary className="cursor-pointer px-3 py-2 font-semibold text-slate-600 select-none">
                        Rutas XML (storage)
                      </summary>
                      <div className="px-3 pb-3 pt-0 space-y-2 text-slate-600 break-all">
                        <p>
                          <span className="text-slate-400">xml_path:</span>{" "}
                          <code className="text-[11px]">{fe.xml_path ?? "—"}</code>
                        </p>
                        <p>
                          <span className="text-slate-400">xml_firmado_path:</span>{" "}
                          <code className="text-[11px]">{fe.xml_firmado_path ?? "—"}</code>
                        </p>
                      </div>
                    </details>
                    {ultimaConsulta ? (
                      <details className="rounded-lg border border-sky-200 bg-sky-50/50 text-xs open:shadow-sm">
                        <summary className="cursor-pointer px-3 py-2 font-semibold text-sky-950 select-none">
                          Respuesta consulta lote ({etiquetaAmbienteSet})
                        </summary>
                        <div className="px-3 pb-3 pt-0 space-y-2 max-h-[min(420px,55vh)] overflow-y-auto">
                          <p className="text-slate-700">
                            <span className="text-slate-500">dCodResLot:</span>{" "}
                            <code className="bg-white/80 px-1 rounded">
                              {ultimaConsulta.dCodResLot ?? "—"}
                            </code>
                          </p>
                          <p className="text-slate-700 break-words">
                            <span className="text-slate-500">dMsgResLot:</span>{" "}
                            {ultimaConsulta.dMsgResLot ?? "—"}
                          </p>
                          {ultimaConsulta.detallePorCdc.length > 0 && (
                            <ul className="list-disc pl-4 space-y-2 text-slate-800">
                              {ultimaConsulta.detallePorCdc.map((d) => (
                                <li key={d.cdc}>
                                  <span className="text-slate-500">CDC:</span>{" "}
                                  <code className="bg-white/80 px-1 rounded break-all">{d.cdc}</code>
                                  <br />
                                  <span className="text-slate-500">dEstRes:</span> {d.dEstRes}
                                  {d.dProtAut != null && d.dProtAut !== "" && (
                                    <>
                                      <br />
                                      <span className="text-slate-500">dProtAut:</span> {d.dProtAut}
                                    </>
                                  )}
                                  {d.grupoRes.length > 0 && (
                                    <ul className="list-circle pl-4 mt-1 space-y-0.5">
                                      {d.grupoRes.map((g, i) => (
                                        <li key={`${d.cdc}-${g.dCodRes}-${i}`}>
                                          <code>{g.dCodRes}</code> — {decodeXmlNumericEntities(g.dMsgRes)}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                          {ultimaConsulta.loteSinDetalleCdc && !ultimaConsulta.soapFault && (
                            <p className="text-amber-900 leading-snug">
                              {mensajeConsultaSinFilasPorCdc(ultimaConsulta)}
                            </p>
                          )}
                          {ultimaConsulta.soapFault && ultimaConsulta.faultString && (
                            <p className="text-red-700">Fault: {ultimaConsulta.faultString}</p>
                          )}
                        </div>
                      </details>
                    ) : null}
                  </>
                ) : null}
                {mostrarErrorPersistido && (() => {
                  const decoded = decodeXmlNumericEntities(fe.error ?? "").trim();
                  const friendly = friendlyErrorMsg({ raw: decoded, estadoSifen: String(fe.estado_sifen) });
                  return (
                    <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2 space-y-2 whitespace-pre-wrap break-words">
                      <p className="font-semibold">
                        {friendly.reconocido ? friendly.titulo : `Error: ${decoded}`}
                      </p>
                      {friendly.reconocido && (
                        <>
                          <p className="text-xs text-red-700">{friendly.detalle}</p>
                          <details className="text-xs">
                            <summary className="cursor-pointer text-red-700/80 hover:text-red-900">
                              Ver mensaje original de SET{friendly.codigo ? ` (${friendly.codigo})` : ""}
                            </summary>
                            <p className="mt-1 font-mono text-[11px] text-red-800">{decoded}</p>
                          </details>
                        </>
                      )}
                    </div>
                  );
                })()}
                {resumen.sifen_job &&
                (resumen.sifen_job.estado === "rechazado" ||
                  resumen.sifen_job.estado === "error") && (
                  <div className="rounded-lg bg-red-50 border border-red-200 text-red-900 text-xs px-3 py-2 space-y-1">
                    <p className="font-semibold text-sm">
                      {resumen.sifen_job.estado === "rechazado"
                        ? "Rechazado por SET"
                        : "Error técnico"}
                      {resumen.sifen_job.etapa
                        ? ` — etapa ${resumen.sifen_job.etapa}`
                        : ""}
                    </p>
                    {resumen.sifen_job.codigo_error_set ||
                    resumen.sifen_job.codigo_sub_error_set ? (
                      <p className="font-mono text-[11px] text-red-800">
                        Código SET:{" "}
                        {resumen.sifen_job.codigo_error_set ?? "—"}
                        {resumen.sifen_job.codigo_sub_error_set
                          ? ` [${resumen.sifen_job.codigo_sub_error_set}]`
                          : ""}
                      </p>
                    ) : null}
                    {resumen.sifen_job.mensaje_set?.trim() ? (() => {
                      const decoded = decodeXmlNumericEntities(resumen.sifen_job.mensaje_set).trim();
                      const friendly = friendlyErrorMsg({
                        raw: decoded,
                        estadoSifen: fe ? String(fe.estado_sifen) : null,
                      });
                      if (!friendly.reconocido) {
                        return (
                          <p className="whitespace-pre-wrap break-words">{decoded}</p>
                        );
                      }
                      return (
                        <div className="space-y-1.5">
                          <p className="font-semibold whitespace-pre-wrap break-words">
                            {friendly.titulo}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-[11px] leading-snug">
                            {friendly.detalle}
                          </p>
                          <details className="text-[11px]">
                            <summary className="cursor-pointer text-red-800/70 hover:text-red-900">
                              Ver mensaje original de SET{friendly.codigo ? ` (${friendly.codigo})` : ""}
                            </summary>
                            <p className="mt-1 font-mono text-[10px] text-red-800">{decoded}</p>
                          </details>
                        </div>
                      );
                    })() : null}
                    {resumen.sifen_job.estado === "error" &&
                    resumen.sifen_job.ultimo_error?.trim() ? (
                      <p className="whitespace-pre-wrap break-words">
                        {resumen.sifen_job.ultimo_error}
                      </p>
                    ) : null}
                    <p className="text-[11px] text-red-700">
                      Intentos automáticos: {resumen.sifen_job.intentos} /{" "}
                      {resumen.sifen_job.max_intentos_auto}
                    </p>
                  </div>
                )}
              </>
            )}
            </div>

              {debugUi ? (
                <details className="rounded-lg border border-dashed border-slate-200 text-xs text-slate-500">
                  <summary className="cursor-pointer px-2 py-1.5 font-medium text-slate-600 select-none">
                    Debug: payload / documento (API)
                  </summary>
                  <p className="px-2 pb-2 pt-0 flex flex-wrap gap-x-3 gap-y-1">
                    <a
                      className="text-[#0EA5E9] font-medium hover:underline"
                      href={`/api/facturas/${facturaId}/sifen/payload`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      JSON
                    </a>
                    <a
                      className="text-[#0EA5E9] font-medium hover:underline"
                      href={`/api/facturas/${facturaId}/sifen/documento`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Documento
                    </a>
                  </p>
                </details>
              ) : null}
            </>
          )}

        </div>

        <FacturaCorreccionFiscalNC
          facturaId={facturaId}
          clienteId={clienteId}
          clienteDisplay={facturaComercial.cliente_display}
          monto={facturaComercial.monto}
          saldo={facturaComercial.saldo}
          estado={facturaComercial.estado}
          moneda={facturaComercial.moneda}
          puedeCancelarDe={Boolean(resumen?.cancelacion?.puede_cancelar)}
          deAprobado={deAprobado}
          onAfterNcMutation={onComercialUpdated}
          embedded
          debugUi={debugUi}
        />
      </div>

      {cancelModal != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sifen-cancel-title"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 space-y-4 border border-slate-200">
            <h4 id="sifen-cancel-title" className="text-sm font-bold text-slate-900">
              {cancelModal === "reemitir"
                ? "Cancelar documento y continuar en cliente"
                : "Cancelar documento electrónico (ERP)"}
            </h4>
            <p className="text-xs text-slate-600 leading-relaxed">
              Se registrará la cancelación lógica del DE, la factura comercial pasará a{" "}
              <span className="font-semibold">Anulado</span> y quedará trazabilidad. No se elimina ningún registro.
              {cancelModal === "reemitir" ? " Luego podés emitir una nueva factura desde la ficha del cliente." : ""}
            </p>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Motivo (obligatorio)
              <textarea
                value={motivoCancel}
                onChange={(e) => setMotivoCancel(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]"
                placeholder="Ej.: error en datos del cliente acordado verbalmente"
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={action !== null}
                onClick={() => {
                  setCancelModal(null);
                  setMotivoCancel("");
                }}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={action !== null}
                onClick={() => void ejecutarCancelacion(cancelModal === "reemitir")}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-700 text-white hover:bg-rose-800 disabled:opacity-50"
              >
                {action === "cancelar-de" ? "Procesando…" : "Confirmar cancelación"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
