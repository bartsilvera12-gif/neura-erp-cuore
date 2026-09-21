import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import type { Impresora, SectorImpresora } from "@/lib/impresoras/types";

type Sb = ReturnType<typeof createServiceRoleClientWithDbSchema>;

const COLS = "id, sector, nombre, ip, puerto, ancho_mm, activo";

function mapImpresora(r: Record<string, unknown>): Impresora {
  const anchoRaw = Number(r.ancho_mm);
  return {
    id: String(r.id),
    sector: r.sector as SectorImpresora,
    nombre: (r.nombre as string) ?? null,
    ip: String(r.ip),
    puerto: Number(r.puerto),
    ancho_mm: anchoRaw === 58 ? 58 : 80,
    activo: r.activo !== false,
  };
}

/** Devuelve las 3 impresoras de la empresa (pizzeria / plancha / caja). */
export async function listarImpresorasPg(
  schema: string,
  empresaId: string,
): Promise<Impresora[]> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const q = await sb.from("impresoras").select(COLS)
    .eq("empresa_id", empresaId)
    .order("sector", { ascending: true });
  if (q.error) throw new Error(q.error.message);
  return (q.data ?? []).map((r) => mapImpresora(r as Record<string, unknown>));
}

/** Devuelve la impresora asignada a un sector, o null si nunca se cargó. */
export async function getImpresoraPorSectorPg(
  schema: string,
  empresaId: string,
  sector: SectorImpresora,
): Promise<Impresora | null> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const q = await sb.from("impresoras").select(COLS)
    .eq("empresa_id", empresaId).eq("sector", sector).maybeSingle();
  if (q.error) throw new Error(q.error.message);
  return q.data ? mapImpresora(q.data as Record<string, unknown>) : null;
}

/**
 * Guarda la config de una impresora (upsert por (empresa, sector)). Si no
 * existía la fila, se crea; si ya existía, se actualiza. La IP se guarda
 * tal cual — la validación de formato la hace el frontend antes de mandar.
 */
export async function guardarImpresoraPg(params: {
  schema: string;
  empresaId: string;
  sector: SectorImpresora;
  ip: string;
  puerto: number;
  nombre?: string | null;
  ancho_mm?: 58 | 80;
  activo?: boolean;
}): Promise<Impresora> {
  const sb = createServiceRoleClientWithDbSchema(params.schema);
  const existente = await getImpresoraPorSectorPg(params.schema, params.empresaId, params.sector);
  const patch = {
    ip: params.ip.trim(),
    puerto: params.puerto,
    nombre: params.nombre ?? null,
    ancho_mm: params.ancho_mm ?? 80,
    activo: params.activo ?? true,
    updated_at: new Date().toISOString(),
  };
  if (existente) {
    const upd = await sb.from("impresoras").update(patch)
      .eq("empresa_id", params.empresaId).eq("id", existente.id)
      .select(COLS).single();
    if (upd.error) throw new Error(upd.error.message);
    return mapImpresora(upd.data as Record<string, unknown>);
  }
  const ins = await sb.from("impresoras").insert({
    empresa_id: params.empresaId,
    sector: params.sector,
    ...patch,
  }).select(COLS).single();
  if (ins.error) throw new Error(ins.error.message);
  return mapImpresora(ins.data as Record<string, unknown>);
}
