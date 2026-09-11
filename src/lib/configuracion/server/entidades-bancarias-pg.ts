import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import type { EntidadBancaria } from "@/lib/configuracion/entidades-bancarias";

const COLS = "id, nombre, banco, numero_cuenta, tipo, moneda, activo";
const clean = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t.slice(0, 200) : null;
};
const TIPOS = ["banco", "pos", "billetera", "qr", "otro"];

function map(r: Record<string, unknown>): EntidadBancaria {
  return {
    id: String(r.id),
    nombre: String(r.nombre ?? ""),
    banco: (r.banco as string) ?? null,
    numero_cuenta: (r.numero_cuenta as string) ?? null,
    tipo: (r.tipo as string) ?? null,
    moneda: String(r.moneda ?? "PYG"),
    activo: r.activo !== false,
  };
}

export async function listEntidadesPg(schema: string, empresaId: string, incluirInactivas = false): Promise<EntidadBancaria[]> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  let q = sb.from("cuentas_bancarias").select(COLS).eq("empresa_id", empresaId).order("activo", { ascending: false }).order("nombre");
  if (!incluirInactivas) q = q.eq("activo", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => map(r as Record<string, unknown>));
}

export async function createEntidadPg(schema: string, empresaId: string, input: {
  nombre: string; banco?: string | null; numero_cuenta?: string | null; tipo?: string | null; moneda?: string | null;
}): Promise<EntidadBancaria> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const nombre = clean(input.nombre);
  if (!nombre) throw new Error("El nombre de la entidad es obligatorio.");
  const tipo = input.tipo && TIPOS.includes(input.tipo) ? input.tipo : null;
  const ins = await sb.from("cuentas_bancarias").insert({
    empresa_id: empresaId, nombre, banco: clean(input.banco), numero_cuenta: clean(input.numero_cuenta),
    tipo, moneda: clean(input.moneda) || "PYG",
  }).select(COLS).single();
  if (ins.error) throw new Error(ins.error.message);
  return map(ins.data as Record<string, unknown>);
}

export async function updateEntidadPg(schema: string, empresaId: string, id: string, input: {
  nombre?: string; banco?: string | null; numero_cuenta?: string | null; tipo?: string | null; moneda?: string | null; activo?: boolean;
}): Promise<EntidadBancaria> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const patch: Record<string, unknown> = {};
  if (input.nombre !== undefined) {
    const n = clean(input.nombre);
    if (!n) throw new Error("El nombre no puede quedar vacío.");
    patch.nombre = n;
  }
  if (input.banco !== undefined) patch.banco = clean(input.banco);
  if (input.numero_cuenta !== undefined) patch.numero_cuenta = clean(input.numero_cuenta);
  if (input.tipo !== undefined) patch.tipo = input.tipo && TIPOS.includes(input.tipo) ? input.tipo : null;
  if (input.moneda !== undefined) patch.moneda = clean(input.moneda) || "PYG";
  if (input.activo !== undefined) patch.activo = input.activo;
  if (Object.keys(patch).length === 0) throw new Error("Nada para actualizar.");

  const upd = await sb.from("cuentas_bancarias").update(patch)
    .eq("empresa_id", empresaId).eq("id", id).select(COLS).single();
  if (upd.error) throw new Error(upd.error.message);
  return map(upd.data as Record<string, unknown>);
}

/**
 * Elimina la entidad si NO tiene conciliaciones asociadas; si las tiene, la
 * DESACTIVA (no se borra para preservar el historial/auditoría).
 */
export async function eliminarEntidadPg(schema: string, empresaId: string, id: string): Promise<{ eliminada: boolean; desactivada: boolean }> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const refs = await sb.from("conciliacion_pagos").select("id", { count: "exact", head: true })
    .eq("empresa_id", empresaId).eq("cuenta_bancaria_id", id);
  if (refs.error) throw new Error(refs.error.message);
  if ((refs.count ?? 0) > 0) {
    const upd = await sb.from("cuentas_bancarias").update({ activo: false }).eq("empresa_id", empresaId).eq("id", id).select("id").single();
    if (upd.error) throw new Error(upd.error.message);
    return { eliminada: false, desactivada: true };
  }
  const del = await sb.from("cuentas_bancarias").delete().eq("empresa_id", empresaId).eq("id", id).select("id").single();
  if (del.error) throw new Error(del.error.message);
  return { eliminada: true, desactivada: false };
}
