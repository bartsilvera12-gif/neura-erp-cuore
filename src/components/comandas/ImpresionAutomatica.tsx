"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Printer } from "lucide-react";
import { comandasPrintUrl, imprimirComanda } from "@/lib/comandas/storage";
import type { ComandaCard } from "@/lib/comandas/types";

/**
 * Modo cocina: imprimir las comandas nuevas sin que nadie apriete nada.
 *
 * Cómo funciona: cuando entra una comanda que no estaba, se marca impresa en el
 * servidor y se carga el ticket en un iframe oculto que se manda a imprimir
 * solo. Con Chrome abierto con `--kiosk-printing` sale directo al papel; sin ese
 * flag, cada comanda abre el diálogo de impresión de Windows y hay que
 * confirmar, que es peor que el botón. Por eso el aviso está a la vista.
 *
 * Se activa por dispositivo (queda en el navegador de esa PC) y no por usuario:
 * el que tiene que imprimir es el equipo de la cocina, no la caja, que abre la
 * misma pantalla y no quiere papel saliendo del otro lado del local.
 *
 * Sólo entran las comandas que aparecen DESPUÉS de encender el modo: al
 * encenderlo se anota lo que ya estaba y eso no se imprime. Si no, prender el
 * interruptor con la cola acumulada largaba de golpe todo lo viejo.
 */

const CLAVE = "caribena.comandas.impresion-automatica";

interface Registro {
  id: string;
  numero: number;
  hora: string;
  ok: boolean;
  detalle?: string;
}

export default function ImpresionAutomatica({
  pendientes,
  cargando,
  onImpresa,
  onEstado,
}: {
  pendientes: ComandaCard[];
  /** El listado todavía no llegó: no se toma la foto inicial con datos a medias. */
  cargando: boolean;
  /** Para refrescar el listado cuando una comanda pasa a impresa. */
  onImpresa: () => void;
  /** Avisa si el modo quedó encendido, para refrescar más seguido. */
  onEstado?: (activo: boolean) => void;
}) {
  const [activo, setActivo] = useState(false);
  const [registro, setRegistro] = useState<Registro[]>([]);
  const [ultimaRevision, setUltimaRevision] = useState<Date | null>(null);
  /**
   * Comandas que esta pantalla no tiene que imprimir: las que ya estaban
   * cuando se encendió el modo, más las que ya se atendieron.
   *
   * Antes esto era una comparación de fechas: imprimir lo creado después de
   * encender. Fallaba, y feo, porque la fecha de la comanda la pone el servidor
   * y la de "ahora" la ponía la PC de la cocina. Con el reloj de esa PC unos
   * minutos adelantado —cosa comunísima en una máquina de local— TODA comanda
   * nueva parecía vieja y no se imprimía ninguna, sin ningún error a la vista.
   *
   * Comparar identidades en vez de relojes no depende de la hora de nadie.
   */
  const atendidasRef = useRef<Set<string>>(new Set());
  /** La foto inicial ya se tomó: recién ahí lo que aparece es nuevo de verdad. */
  const inicializadoRef = useRef(false);
  const trabajandoRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // El interruptor se recuerda en el dispositivo: la PC de cocina se reinicia y
  // nadie se acuerda de volver a prenderlo.
  useEffect(() => {
    try {
      if (localStorage.getItem(CLAVE) === "1") {
        setActivo(true);
        onEstado?.(true);
      }
    } catch { /* navegador sin storage: queda apagado */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alternar = useCallback((v: boolean) => {
    setActivo(v);
    onEstado?.(v);
    atendidasRef.current = new Set();
    inicializadoRef.current = false;
    try { localStorage.setItem(CLAVE, v ? "1" : "0"); } catch { /* da igual */ }
  }, [onEstado]);

  /**
   * Imprime un lote de comandas en un solo trabajo.
   *
   * Todas juntas y no de a una: un pedido con pizza y hamburguesa genera dos
   * comandas, y dos `window.print()` seguidos en el mismo navegador se pisan —
   * sale una sola, o salen mezcladas. En un único documento van separadas por
   * corte de página y salen las dos.
   */
  const imprimirLote = useCallback(async (lote: ComandaCard[]) => {
    const hora = new Date().toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" });

    // Primero se registra cada impresión. Si esto falla, esa comanda no entra
    // al papel: seguiría figurando pendiente y saldría de nuevo en cada
    // refresco, una y otra vez.
    const marcadas: ComandaCard[] = [];
    for (const c of lote) {
      const r = await imprimirComanda(c.id);
      if (r.success) marcadas.push(c);
      else setRegistro((p) => [{ id: c.id, numero: c.numero, hora, ok: false, detalle: r.error }, ...p].slice(0, 12));
    }
    if (marcadas.length === 0) return;

    const marco = iframeRef.current;
    if (!marco) return;
    await new Promise<void>((resolve) => {
      const listo = () => { marco.removeEventListener("load", listo); resolve(); };
      marco.addEventListener("load", listo);
      // El documento lleva `auto=1`: se manda a imprimir solo al terminar de
      // cargar, dentro del propio iframe.
      marco.removeAttribute("srcdoc");
      marco.src = comandasPrintUrl(marcadas.map((c) => c.id));
      // Red lenta o ticket que no carga: no se cuelga la cola.
      setTimeout(resolve, 10000);
    });
    setRegistro((p) => [
      ...marcadas.map((c) => ({ id: c.id, numero: c.numero, hora, ok: true })),
      ...p,
    ].slice(0, 12));
  }, []);

  useEffect(() => {
    if (!activo || trabajandoRef.current) return;

    // La hora de la última revisión queda a la vista: si Chrome deja la ventana
    // en segundo plano frena los temporizadores, la pantalla se congela sin
    // avisar y no hay forma de saber que dejó de mirar. Un reloj quieto sí se
    // nota.
    if (!cargando) setUltimaRevision(new Date());

    // Primera pasada: se anota lo que ya estaba y no se imprime nada. Sin esto,
    // encender el interruptor con la cola acumulada largaba de golpe todo lo
    // viejo. Se espera a que el listado esté cargado: absorber una lista vacía
    // que todavía no llegó no anota nada, y después entra todo igual.
    if (!inicializadoRef.current) {
      if (cargando) return;
      for (const c of pendientes) atendidasRef.current.add(c.id);
      inicializadoRef.current = true;
      return;
    }

    const nuevas = pendientes.filter((c) => !atendidasRef.current.has(c.id));
    if (nuevas.length === 0) return;

    trabajandoRef.current = true;
    void (async () => {
      // De la más vieja a la más nueva, para que salgan en el orden en que se
      // pidieron.
      const lote = nuevas.slice().reverse();
      for (const c of lote) atendidasRef.current.add(c.id);
      try { await imprimirLote(lote); } catch { /* queda en el registro como falla */ }
      trabajandoRef.current = false;
      onImpresa();
    })();
  }, [activo, cargando, pendientes, imprimirLote, onImpresa]);

  /**
   * Prueba de impresión, sin tocar ninguna comanda.
   *
   * Sirve para separar dos fallas que desde afuera se ven igual: que el
   * navegador no esté imprimiendo (falta el flag, la impresora no es la
   * predeterminada) o que no estén entrando comandas. Si este papel sale, el
   * camino hasta la ticketera funciona.
   */
  function probar() {
    const marco = iframeRef.current;
    if (!marco) return;
    const ahora = new Date().toLocaleString("es-PY");
    marco.removeAttribute("src");
    marco.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; size: 80mm auto; }
      body { font-family: ui-monospace, monospace; width: 80mm; padding: 6mm 4mm; }
      h1 { font-size: 15px; text-align: center; margin: 0 0 6px; }
      p { font-size: 12px; margin: 4px 0; }
    </style></head><body>
      <h1>PRUEBA DE IMPRESIÓN</h1>
      <p>Si estás leyendo esto en papel, la impresión automática funciona.</p>
      <p>${ahora}</p>
      <script>setTimeout(function(){window.print();},300);<\/script>
    </body></html>`;
  }

  const fallas = registro.filter((r) => !r.ok).length;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={activo}
            onChange={(e) => alternar(e.target.checked)}
            className="h-4 w-4 accent-emerald-600"
          />
          <Printer className="h-4 w-4 text-slate-500" aria-hidden />
          Impresión automática
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${
            activo ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}>
            {activo ? "Encendida" : "Apagada"}
          </span>
        </label>
        <div className="flex items-center gap-3">
          {activo && ultimaRevision && (
            <p className="text-xs text-slate-500">
              Última revisión:{" "}
              <span className="tabular-nums font-medium text-slate-700">
                {ultimaRevision.toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </p>
          )}
          {registro.length > 0 && (
            <p className="text-xs text-slate-500">
              {registro.length} impresa(s) en este turno
              {fallas > 0 && <span className="ml-1 font-semibold text-red-600">· {fallas} con error</span>}
            </p>
          )}
          <button
            type="button"
            onClick={probar}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Probar impresión
          </button>
        </div>
      </div>

      {activo ? (
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Las comandas que entren a partir de ahora se imprimen solas en <strong>esta</strong> PC. Dejá
          la pantalla abierta. Para que salgan sin diálogo, Chrome tiene que estar abierto con{" "}
          <code className="rounded bg-slate-100 px-1">--kiosk-printing</code>.{" "}
          <strong>Si la impresora falla, nadie va a avisar</strong>: mirá el papel, no la pantalla.
        </p>
      ) : (
        <p className="mt-2 text-[11px] leading-snug text-slate-400">
          Encendela sólo en la PC de la cocina. Las comandas viejas no se imprimen: sólo las que
          entren después de encenderla.
        </p>
      )}

      {registro.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px]">
          {registro.map((r) => (
            <li key={`${r.id}-${r.hora}`} className={r.ok ? "text-slate-500" : "text-red-600"}>
              {r.hora} · Comanda N°{r.numero} ·{" "}
              {r.ok ? "enviada a la impresora" : `ERROR: ${r.detalle ?? "no se pudo"}`}
              {!r.ok && <AlertTriangle className="ml-1 inline h-3 w-3 align-[-0.125em]" aria-hidden />}
            </li>
          ))}
        </ul>
      )}

      {/* El ticket se carga acá y se imprime solo.
          Fuera de la pantalla pero con tamaño real: un iframe de 0×0 (o con
          display:none) imprime en blanco en Chrome, que fue exactamente lo que
          pasó la primera vez. Tiene que existir y tener alto y ancho. */}
      <iframe
        ref={iframeRef}
        title="Impresión de comandas"
        aria-hidden
        tabIndex={-1}
        style={{ position: "fixed", left: "-10000px", top: 0, width: "400px", height: "600px", border: 0 }}
      />
    </div>
  );
}
