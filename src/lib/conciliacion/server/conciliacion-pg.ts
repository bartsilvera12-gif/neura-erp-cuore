import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import type {
  ConciliacionEstado, ConciliacionFiltros, ConciliacionResumen, ConciliacionRow, CuentaBancaria,
} from "@/lib/conciliacion/types";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const COLS =
  "id, venta_id, caja_id, mesa_sesion_id, cuenta_bancaria_id, medio_pago, entidad, referencia, tipo_tarjeta, monto, estado, fecha_pago, created_at, observacion, motivo_rechazo";

export async function listarCuentasBancariasPg(schema: string, empresaId: string): Promise<CuentaBancaria[]> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const q = await sb.from("cuentas_bancarias").select("id, nombre, banco, numero_cuenta, tipo, moneda, activo")
    .eq("empresa_id", empresaId).eq("activo", true).order("nombre");
  if (q.error) throw new Error(q.error.message);
  return (q.data ?? []).map((r) => {
    const x = r as Record<string, unknown>;
    return { id: String(x.id), nombre: String(x.nombre ?? ""), banco: (x.banco as string) ?? null,
      numero_cuenta: (x.numero_cuenta as string) ?? null, tipo: (x.tipo as string) ?? null, moneda: String(x.moneda ?? "PYG"), activo: x.activo !== false };
  });
}

export async function listarConciliacionPg(
  schema: string, empresaId: string, f?: ConciliacionFiltros
): Promise<{ items: ConciliacionRow[]; resumen: ConciliacionResumen }> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  let q = sb.from("conciliacion_pagos").select(COLS).eq("empresa_id", empresaId).order("created_at", { ascending: false }).limit(500);
  if (f?.estado) q = q.eq("estado", f.estado);
  if (f?.medio_pago) q = q.eq("medio_pago", f.medio_pago);
  if (f?.cuenta_bancaria_id) q = q.eq("cuenta_bancaria_id", f.cuenta_bancaria_id);
  if (f?.caja_id) q = q.eq("caja_id", f.caja_id);
  if (f?.desde) q = q.gte("created_at", `${f.desde}T00:00:00`);
  if (f?.hasta) q = q.lte("created_at", `${f.hasta}T23:59:59.999`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // Resolver venta (numero_control), caja (numero), cuenta (nombre), mesa (numero vía sesión).
  const ventaIds = [...new Set(rows.map((r) => r.venta_id).filter(Boolean) as string[])];
  const cajaIds = [...new Set(rows.map((r) => r.caja_id).filter(Boolean) as string[])];
  const cuentaIds = [...new Set(rows.map((r) => r.cuenta_bancaria_id).filter(Boolean) as string[])];
  const sesIds = [...new Set(rows.map((r) => r.mesa_sesion_id).filter(Boolean) as string[])];

  const ventaNum = new Map<string, string>();
  if (ventaIds.length) {
    const v = await sb.from("ventas").select("id, numero_control").in("id", ventaIds);
    for (const x of (v.data ?? []) as Array<{ id: string; numero_control: string }>) ventaNum.set(x.id, x.numero_control);
  }
  const cajaNum = new Map<string, number>();
  if (cajaIds.length) {
    const v = await sb.from("cajas").select("id, numero_caja").in("id", cajaIds);
    for (const x of (v.data ?? []) as Array<{ id: string; numero_caja: number | string }>) cajaNum.set(x.id, num(x.numero_caja));
  }
  const cuentaNom = new Map<string, string>();
  if (cuentaIds.length) {
    const v = await sb.from("cuentas_bancarias").select("id, nombre").in("id", cuentaIds);
    for (const x of (v.data ?? []) as Array<{ id: string; nombre: string }>) cuentaNom.set(x.id, x.nombre);
  }
  const sesMesa = new Map<string, string>();
  if (sesIds.length) {
    const v = await sb.from("mesa_sesiones").select("id, mesa_id").in("id", sesIds);
    for (const x of (v.data ?? []) as Array<{ id: string; mesa_id: string }>) sesMesa.set(x.id, x.mesa_id);
  }
  const mesaIds = [...new Set([...sesMesa.values()])];
  const mesaNum = new Map<string, number>();
  if (mesaIds.length) {
    const v = await sb.from("mesas").select("id, numero").in("id", mesaIds);
    for (const x of (v.data ?? []) as Array<{ id: string; numero: number | string }>) mesaNum.set(x.id, num(x.numero));
  }

  const items: ConciliacionRow[] = rows.map((r) => {
    const sesId = (r.mesa_sesion_id as string) ?? null;
    const mesaId = sesId ? sesMesa.get(sesId) : undefined;
    return {
      id: String(r.id),
      venta_id: String(r.venta_id),
      numero_control: ventaNum.get(String(r.venta_id)) ?? null,
      mesa_numero: mesaId ? mesaNum.get(mesaId) ?? null : null,
      caja_numero: r.caja_id ? cajaNum.get(String(r.caja_id)) ?? null : null,
      caja_id: (r.caja_id as string) ?? null,
      medio_pago: r.medio_pago as ConciliacionRow["medio_pago"],
      entidad: (r.entidad as string) ?? null,
      cuenta_nombre: r.cuenta_bancaria_id ? cuentaNom.get(String(r.cuenta_bancaria_id)) ?? null : null,
      cuenta_bancaria_id: (r.cuenta_bancaria_id as string) ?? null,
      referencia: (r.referencia as string) ?? null,
      tipo_tarjeta: (r.tipo_tarjeta as string) ?? null,
      monto: num(r.monto),
      estado: r.estado as ConciliacionEstado,
      fecha_pago: (r.fecha_pago as string) ?? null,
      created_at: r.created_at as string,
      observacion: (r.observacion as string) ?? null,
      motivo_rechazo: (r.motivo_rechazo as string) ?? null,
    };
  });

  const resumen: ConciliacionResumen = {
    total_pendiente: items.filter((i) => i.estado === "pendiente").reduce((s, i) => s + i.monto, 0),
    total_aprobado: items.filter((i) => i.estado === "aprobado").reduce((s, i) => s + i.monto, 0),
    total_rechazado: items.filter((i) => i.estado === "rechazado").reduce((s, i) => s + i.monto, 0),
    cantidad: items.length,
    transferencia_total: items.filter((i) => i.medio_pago === "transferencia").reduce((s, i) => s + i.monto, 0),
    tarjeta_total: items.filter((i) => i.medio_pago === "tarjeta").reduce((s, i) => s + i.monto, 0),
  };
  return { items, resumen };
}

/** Aprueba o rechaza una conciliación. No toca la venta (solo el estado de conciliación). */
export async function resolverConciliacionPg(params: {
  schema: string; empresaId: string; id: string;
  accion: "aprobar" | "rechazar"; usuarioId: string | null; motivo?: string | null;
}): Promise<ConciliacionRow> {
  const sb = createServiceRoleClientWithDbSchema(params.schema);
  const patch: Record<string, unknown> = params.accion === "aprobar"
    ? { estado: "aprobado", aprobado_por: params.usuarioId, aprobado_at: new Date().toISOString(), rechazado_por: null, rechazado_at: null, motivo_rechazo: null }
    : { estado: "rechazado", rechazado_por: params.usuarioId, rechazado_at: new Date().toISOString(), motivo_rechazo: params.motivo || null };
  const upd = await sb.from("conciliacion_pagos").update(patch)
    .eq("empresa_id", params.empresaId).eq("id", params.id).select("id").single();
  if (upd.error) throw new Error(upd.error.message);
  const { items } = await listarConciliacionPg(params.schema, params.empresaId);
  const found = items.find((i) => i.id === params.id);
  if (!found) throw new Error("Conciliación no encontrada tras actualizar.");
  return found;
}
