import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type {
  ComandaEnvioResult, MesaConResumen, MesaDetalle, MesaSesion, MesaSesionItem,
  ParaLlevarConResumen,
} from "./types";

type Ok<T> = { success: true } & T;
type Err = { success: false; error: string };

async function call<T>(url: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<Ok<T> | Err> {
  try {
    const res = await fetchWithSupabaseSession(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { success?: boolean; data?: T; error?: string };
    if (!res.ok || !json.success || !json.data) return { success: false, error: json.error ?? `Error (${res.status}).` };
    return { success: true, ...(json.data as T) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Error de red." };
  }
}

export async function getMesas(): Promise<MesaConResumen[]> {
  const r = await call<{ mesas: MesaConResumen[] }>("/api/mesas", "GET");
  return r.success ? r.mesas : [];
}

/**
 * Mesas + el número más alto en uso, para proponer desde dónde seguir numerando.
 *
 * Devuelve `error` en vez de una lista vacía cuando la llamada falla. La
 * distinción importa: la pantalla refresca sola cada 15 segundos y, si un fallo
 * pasajero se traducía en `[]`, el salón entero desaparecía y aparecía el cartel
 * "Todavía no hay mesas cargadas" — con las mesas intactas en la base.
 */
export async function getMesasConUltimoNumero(
  incluirInactivas = false
): Promise<{ mesas: MesaConResumen[]; ultimoNumero: number; error?: string }> {
  const url = incluirInactivas ? "/api/mesas?incluirInactivas=1" : "/api/mesas";
  const r = await call<{ mesas: MesaConResumen[]; ultimoNumero: number }>(url, "GET");
  if (!r.success) return { mesas: [], ultimoNumero: 0, error: r.error };
  return { mesas: r.mesas, ultimoNumero: r.ultimoNumero ?? 0 };
}

/** Alta de mesas numeradas de `desde` a `desde + cantidad - 1`. */
export async function crearMesas(
  desde: number,
  cantidad: number,
  nombre?: string | null
): Promise<{ ok: true; creadas: number[]; existentes: number[] } | { ok: false; error: string }> {
  const r = await call<{ creadas: number[]; existentes: number[] }>("/api/mesas", "POST", {
    desde,
    cantidad,
    nombre: nombre ?? null,
  });
  return r.success
    ? { ok: true, creadas: r.creadas, existentes: r.existentes }
    : { ok: false, error: r.error };
}

export async function getMesaDetalle(mesaId: string): Promise<MesaDetalle | null> {
  const r = await call<{ detalle: MesaDetalle }>(`/api/mesas/${encodeURIComponent(mesaId)}`, "GET");
  return r.success ? r.detalle : null;
}

export interface MitadItemPayload {
  precio_unitario?: number;
  display_name?: string;
  mitad?: { producto1_id: string; producto2_id: string; nombre1: string; nombre2: string };
}

export function agregarItemMesa(
  mesaId: string,
  payload: { producto_id: string; cantidad: number; observacion: string | null } & MitadItemPayload
) {
  return call<{ item: MesaSesionItem }>(`/api/mesas/${encodeURIComponent(mesaId)}/items`, "POST", payload);
}

export function actualizarItemMesa(
  itemId: string,
  payload: {
    cantidad?: number;
    observacion?: string | null;
    cancelar?: boolean;
    producto_id?: string;
    precio_unitario?: number | null;
    display_name?: string | null;
    mitad?: MitadItemPayload["mitad"] | null;
  }
) {
  return call<{ item: MesaSesionItem }>(`/api/mesas/items/${encodeURIComponent(itemId)}`, "PATCH", payload);
}

/**
 * Manda a cocina los pendientes de una cuenta, por id de sesión.
 *
 * La pantalla de cobro trabaja con la sesión y no con la mesa, y necesita poder
 * comandar lo que se agrega ahí sin volver al salón.
 */
export function enviarComandaSesion(sesionId: string) {
  return call<ComandaEnvioResult>(`/api/mesas/sesiones/${encodeURIComponent(sesionId)}/comanda`, "POST", {});
}

/** Envía los ítems pendientes a producción (comandas por sector). La mesa sigue ocupada. */
export function enviarComandaMesa(mesaId: string) {
  return call<ComandaEnvioResult>(`/api/mesas/${encodeURIComponent(mesaId)}/comanda`, "POST", {});
}

/** Pedir cuenta / enviar a caja para cobrar (la mesa pasa a por_cobrar). */
export function enviarMesaACaja(mesaId: string) {
  return call<{ sesion: unknown }>(`/api/mesas/${encodeURIComponent(mesaId)}/enviar-caja`, "POST", {});
}

export function cancelarCuentaMesa(mesaId: string) {
  return call<{ ok: boolean }>(`/api/mesas/${encodeURIComponent(mesaId)}/cancelar`, "POST", {});
}

export async function getMesasPorCobrar(): Promise<MesaConResumen[]> {
  const r = await call<{ mesas: MesaConResumen[] }>("/api/mesas/por-cobrar", "GET");
  return r.success ? r.mesas : [];
}

export interface PagoConciliacionInput {
  referencia?: string | null;
  entidad?: string | null;
  tipo_tarjeta?: string | null;
  cuenta_bancaria_id?: string | null;
  fecha_pago?: string | null;
  observacion?: string | null;
}

/** Una forma de pago del cobro de una mesa. */
export interface PagoMesaInput {
  metodo_pago: "efectivo" | "tarjeta" | "transferencia" | "qr";
  monto: number;
  referencia?: string | null;
  cuenta_bancaria_id?: string | null;
}

/** Descuento autorizado que viaja con el cobro. */
export interface DescuentoCobroInput {
  monto: number;
  motivo: string | null;
  /** La clave va para que el servidor la revalide: no confía en la pantalla. */
  clave: string;
}

export function facturarMesa(
  sesionId: string,
  metodoPago: "efectivo" | "tarjeta" | "transferencia" | "qr",
  pago?: PagoConciliacionInput | null,
  /** Cobro repartido. Vacío = una sola forma de pago por el total. */
  pagos?: PagoMesaInput[],
  descuento?: DescuentoCobroInput | null
) {
  return call<{ ventaId: string; numeroControl: string | null; yaFacturada: boolean }>(
    `/api/mesas/sesiones/${encodeURIComponent(sesionId)}/facturar`,
    "POST",
    { metodo_pago: metodoPago, pago: pago ?? null, pagos: pagos ?? [], descuento: descuento ?? null }
  );
}

// ── PARA LLEVAR ───────────────────────────────────────────────────────────────

/** Crea una nueva sesión "Para llevar" (opcional: nombre del cliente). */
/**
 * Crea una sesión "Para llevar".
 *
 * La nota va impresa en la comanda de cocina: ahí se escribe "delivery" o
 * "retira 21:00", que es lo que decide si hay que llamar a un repartidor.
 */
export function crearParaLlevar(nombreCliente: string | null, observacion: string | null = null) {
  return call<{ sesion: MesaSesion }>("/api/mesas/para-llevar", "POST", {
    nombre_cliente: nombreCliente,
    observacion,
  });
}

/** Lista sesiones PL activas (abierta/por_cobrar) para el listado en /mesas. */
/**
 * Pedidos para llevar abiertos.
 *
 * `null` cuando la llamada falla, para poder distinguirlo de "no hay ninguno":
 * la pantalla refresca sola cada 15 segundos y un vacío indistinguible borraba
 * los pedidos en curso ante cualquier tropiezo del servidor.
 */
export async function getParaLlevarActivas(): Promise<ParaLlevarConResumen[] | null> {
  const r = await call<{ items: ParaLlevarConResumen[] }>("/api/mesas/para-llevar", "GET");
  return r.success ? r.items : null;
}

/** Detalle de una sesión PL. */
export async function getParaLlevarDetalle(sesionId: string): Promise<{ sesion: MesaSesion; items: MesaSesionItem[]; total: number } | null> {
  const r = await call<{ detalle: { sesion: MesaSesion; items: MesaSesionItem[]; total: number } }>(
    `/api/mesas/pl/${encodeURIComponent(sesionId)}`, "GET"
  );
  return r.success ? r.detalle : null;
}

export function agregarItemPL(
  sesionId: string,
  payload: { producto_id: string; cantidad: number; observacion: string | null } & MitadItemPayload
) {
  return call<{ item: MesaSesionItem }>(`/api/mesas/pl/${encodeURIComponent(sesionId)}/items`, "POST", payload);
}

export function enviarComandaPL(sesionId: string) {
  return call<ComandaEnvioResult>(`/api/mesas/pl/${encodeURIComponent(sesionId)}/comanda`, "POST", {});
}

/** Deja el pedido Para llevar en la lista de pendientes de caja. */
export function enviarPLACaja(sesionId: string) {
  return call<{ sesion: MesaSesion }>(`/api/mesas/pl/${encodeURIComponent(sesionId)}/enviar-caja`, "POST", {});
}

export function cancelarPL(sesionId: string) {
  return call<{ ok: boolean }>(`/api/mesas/pl/${encodeURIComponent(sesionId)}/cancelar`, "POST", {});
}

/**
 * Cancela la cuenta viva de una mesa y la deja libre. No factura ni cobra.
 *
 * Va por mesa y no por sesión porque el endpoint busca la cuenta abierta de esa
 * mesa; una mesa tiene una sola cuenta viva a la vez.
 */
export function cancelarMesa(mesaId: string) {
  return call<{ ok: boolean }>(`/api/mesas/${encodeURIComponent(mesaId)}/cancelar`, "POST", {});
}
