import { consumirInsumosDeComanda } from "@/lib/recetas/server/consumo-pg";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import type {
  TipoComanda, ComandaCard, ComandaHistorialFiltros, ComandaItem, EstadoComanda } from "@/lib/comandas/types";

type Sb = ReturnType<typeof createServiceRoleClientWithDbSchema>;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const COMANDA_COLS = "id, numero, estado, created_at, sesion_id, creado_por, printed_at, print_count, sector, batch_id, tipo, detalle, es_agregado";

interface ComandaRow {
  id: string;
  numero: number | string;
  estado: string;
  created_at: string;
  sesion_id: string;
  creado_por: string | null;
  printed_at: string | null;
  print_count: number | string | null;
  sector: string | null;
  tipo?: string | null;
  detalle?: { lineas?: Array<{ antes: string; ahora?: string | null; observacion?: string | null }> } | null;
  es_agregado?: boolean | null;
  batch_id: string | null;
}

/** Resuelve el sector de producción de un set de productos (productos.sector_produccion). */
async function resolveSectoresProducto(
  sb: Sb, empresaId: string, productoIds: string[]
): Promise<Map<string, "pizzeria" | "plancha" | null>> {
  const out = new Map<string, "pizzeria" | "plancha" | null>();
  const uniq = [...new Set(productoIds.filter(Boolean))];
  if (!uniq.length) return out;
  const q = await sb.from("productos").select("id, sector_produccion").eq("empresa_id", empresaId).in("id", uniq);
  for (const r of (q.data ?? []) as Array<{ id: string; sector_produccion: string | null }>) {
    const s = r.sector_produccion;
    out.set(r.id, s === "pizzeria" || s === "plancha" ? s : null);
  }
  return out;
}

/** Ensambla ComandaCard[]: resuelve mesa (vía sesión), mozo (creado_por) e ítems. */
async function armarCards(sb: Sb, empresaId: string, comandas: ComandaRow[]): Promise<ComandaCard[]> {
  if (!comandas.length) return [];
  const comandaIds = comandas.map((c) => c.id);
  const sesionIds = [...new Set(comandas.map((c) => c.sesion_id))];

  const sQ = await sb.from("mesa_sesiones")
    .select("id, mesa_id, mozo_id, tipo, numero_pl, nombre_cliente, observacion")
    .eq("empresa_id", empresaId).in("id", sesionIds);
  const sesById = new Map<string, {
    mesa_id: string | null; mozo_id: string | null;
    tipo: "mesa" | "para_llevar"; numero_pl: number | null; nombre_cliente: string | null;
    observacion: string | null;
  }>();
  for (const s of (sQ.data ?? []) as Array<{
    id: string; mesa_id: string | null; mozo_id: string | null;
    tipo: string | null; numero_pl: number | string | null; nombre_cliente: string | null;
    observacion?: string | null;
  }>) {
    sesById.set(s.id, {
      mesa_id: s.mesa_id,
      mozo_id: s.mozo_id,
      tipo: s.tipo === "para_llevar" ? "para_llevar" : "mesa",
      numero_pl: s.numero_pl == null ? null : Number(s.numero_pl),
      nombre_cliente: s.nombre_cliente,
      observacion: s.observacion ?? null,
    });
  }

  const mesaIds = [...new Set([...sesById.values()].map((s) => s.mesa_id).filter((id): id is string => !!id))];
  const mesaNum = new Map<string, number>();
  if (mesaIds.length) {
    const mQ = await sb.from("mesas").select("id, numero").eq("empresa_id", empresaId).in("id", mesaIds);
    for (const m of (mQ.data ?? []) as Array<{ id: string; numero: number | string }>) mesaNum.set(m.id, num(m.numero));
  }

  const userIds = [...new Set(comandas.map((c) => c.creado_por).filter(Boolean) as string[])];
  const userNombre = new Map<string, string>();
  if (userIds.length) {
    try {
      const uQ = await sb.from("usuarios").select("id, nombre").in("id", userIds);
      for (const u of (uQ.data ?? []) as Array<{ id: string; nombre: string | null }>) if (u.nombre) userNombre.set(u.id, u.nombre);
    } catch { /* nombres opcionales */ }
  }

  // Los ítems de una comanda nueva se agrupan por batch (produccion_batch_id);
  // las comandas legacy (sin batch) siguen agrupadas por comanda_id.
  const batchIds = [...new Set(comandas.map((c) => c.batch_id).filter(Boolean) as string[])];
  const legacyIds = comandas.filter((c) => !c.batch_id).map((c) => c.id);

  type ItemRow = Record<string, unknown>;
  const ITEM_SEL = "id, comanda_id, producto_id, producto_nombre, cantidad, precio_unitario, observacion, total, estado, produccion_batch_id, es_mitad_mitad, mitad_1_nombre, mitad_2_nombre";
  const itemsByBatch = new Map<string, ItemRow[]>();
  const itemsByLegacyComanda = new Map<string, ItemRow[]>();
  const allProductoIds: string[] = [];

  if (batchIds.length) {
    const q = await sb.from("mesa_sesion_items").select(ITEM_SEL)
      .eq("empresa_id", empresaId).in("produccion_batch_id", batchIds)
      .order("created_at", { ascending: true });
    for (const it of (q.data ?? []) as ItemRow[]) {
      const b = String(it.produccion_batch_id);
      const list = itemsByBatch.get(b) ?? [];
      list.push(it); itemsByBatch.set(b, list);
      if (it.producto_id) allProductoIds.push(String(it.producto_id));
    }
  }
  if (legacyIds.length) {
    const q = await sb.from("mesa_sesion_items").select(ITEM_SEL)
      .eq("empresa_id", empresaId).in("comanda_id", legacyIds)
      .order("created_at", { ascending: true });
    for (const it of (q.data ?? []) as ItemRow[]) {
      const cid = String(it.comanda_id);
      const list = itemsByLegacyComanda.get(cid) ?? [];
      list.push(it); itemsByLegacyComanda.set(cid, list);
    }
  }

  const sectorByProd = await resolveSectoresProducto(sb, empresaId, allProductoIds);

  function toItem(it: ItemRow): ComandaItem {
    return {
      id: String(it.id),
      producto_nombre: (it.producto_nombre as string) ?? "",
      cantidad: num(it.cantidad),
      precio_unitario: num(it.precio_unitario),
      observacion: (it.observacion as string) ?? null,
      total: num(it.total),
      cancelado: it.estado === "cancelado",
      es_mitad_mitad: it.es_mitad_mitad === true,
      mitad_1_nombre: (it.mitad_1_nombre as string) ?? null,
      mitad_2_nombre: (it.mitad_2_nombre as string) ?? null,
    };
  }

  return comandas.map((c) => {
    const ses = sesById.get(c.sesion_id);
    const sector = c.sector === "pizzeria" || c.sector === "plancha" ? c.sector : null;

    let rows: ItemRow[];
    if (c.batch_id) {
      rows = itemsByBatch.get(c.batch_id) ?? [];
      // Plancha = solo sus ítems; pizzería = copia completa del batch.
      if (sector === "plancha") rows = rows.filter((it) => sectorByProd.get(String(it.producto_id)) === "plancha");
    } else {
      rows = itemsByLegacyComanda.get(c.id) ?? [];
    }
    const items = rows.map(toItem);
    const total = items.filter((i) => !i.cancelado).reduce((s, i) => s + i.total, 0);
    return {
      id: c.id,
      numero: num(c.numero),
      estado: c.estado as EstadoComanda,
      // Los avisos no tienen ítems propios: el detalle del cambio viaja en la
      // comanda porque no son un pedido, son un mensaje sobre uno que ya salió.
      tipo: (c.tipo === "modificacion" || c.tipo === "cancelacion" ? c.tipo : "pedido") as TipoComanda,
      es_agregado: c.es_agregado === true,
      aviso: c.detalle?.lineas ?? null,
      created_at: c.created_at,
      mesa_numero: ses && ses.mesa_id ? mesaNum.get(ses.mesa_id) ?? null : null,
      sesion_tipo: ses?.tipo ?? "mesa",
      numero_pl: ses?.numero_pl ?? null,
      nombre_cliente: ses?.nombre_cliente ?? null,
      sesion_observacion: ses?.observacion ?? null,
      mozo_nombre: c.creado_por ? userNombre.get(c.creado_por) ?? null : null,
      total,
      items,
      printed_at: c.printed_at,
      print_count: num(c.print_count),
      sector,
    };
  });
}

/** Comandas recientes (últimas `horas`, excluye canceladas) para la pantalla de impresión. */
export async function listarComandasPg(
  schema: string,
  empresaId: string,
  opts?: { estado?: EstadoComanda | null; horas?: number; tipo?: "mesa" | "para_llevar" | null }
): Promise<ComandaCard[]> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const horas = opts?.horas ?? 24;
  const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();

  let q = sb
    .from("comandas")
    .select(COMANDA_COLS)
    .eq("empresa_id", empresaId)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(300);
  if (opts?.estado) q = q.eq("estado", opts.estado);
  else q = q.neq("estado", "cancelada");

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const cards = await armarCards(sb, empresaId, (data ?? []) as unknown as ComandaRow[]);
  if (opts?.tipo) return cards.filter((c) => (c.sesion_tipo ?? "mesa") === opts.tipo);
  return cards;
}

/**
 * Historial de comandas: SOLO impresas y/o canceladas (nunca `generada`, que es
 * la cola operativa). Filtros: rango de fechas (created_at), estado, mesa, mozo y
 * número de comanda. Las reimpresas son `impresa` con print_count > 1.
 */
export async function listarComandasHistorialPg(
  schema: string,
  empresaId: string,
  f?: ComandaHistorialFiltros & { tipo?: "mesa" | "para_llevar" | null }
): Promise<ComandaCard[]> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  let q = sb
    .from("comandas")
    .select(COMANDA_COLS)
    .eq("empresa_id", empresaId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (f?.estado) q = q.eq("estado", f.estado);
  else q = q.in("estado", ["impresa", "cancelada"]);
  if (f?.desde) q = q.gte("created_at", `${f.desde}T00:00:00`);
  if (f?.hasta) q = q.lte("created_at", `${f.hasta}T23:59:59.999`);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let cards = await armarCards(sb, empresaId, (data ?? []) as unknown as ComandaRow[]);

  // Filtros resueltos sobre datos ya ensamblados (mesa/mozo/numero/tipo).
  if (f?.tipo) cards = cards.filter((c) => (c.sesion_tipo ?? "mesa") === f.tipo);
  if (f?.numero != null) cards = cards.filter((c) => c.numero === f.numero);
  if (f?.mesa != null) cards = cards.filter((c) => c.mesa_numero === f.mesa);
  if (f?.mozo) {
    const needle = f.mozo.toLowerCase();
    cards = cards.filter((c) => (c.mozo_nombre ?? "").toLowerCase().includes(needle));
  }
  return cards;
}

export async function getComandaDetallePg(
  schema: string,
  empresaId: string,
  comandaId: string
): Promise<ComandaCard | null> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const q = await sb.from("comandas").select(COMANDA_COLS).eq("empresa_id", empresaId).eq("id", comandaId).maybeSingle();
  if (q.error) throw new Error(q.error.message);
  if (!q.data) return null;
  const cards = await armarCards(sb, empresaId, [q.data as unknown as ComandaRow]);
  return cards[0] ?? null;
}

/**
 * Registra una impresión (o reimpresión): incrementa print_count, marca la
 * comanda como `impresa` y guarda printed_at/printed_by. No toca mesa, venta
 * ni caja.
 *
 * Sí descuenta los insumos de las recetas: imprimir es el momento en que el
 * pedido entra a cocina y se empieza a usar la mercadería. El descuento es
 * idempotente (ver consumirInsumosDeComanda), así que reimprimir por un papel
 * trabado no vuelve a descontar.
 *
 * Si el descuento falla, la impresión igual se registra: dejar a la cocina sin
 * su ticket por un problema de inventario sería el peor de los dos errores. El
 * fallo queda en el log para revisarlo.
 */
export async function registrarImpresionPg(
  schema: string,
  empresaId: string,
  comandaId: string,
  usuarioId: string | null
): Promise<ComandaCard> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const cur = await sb.from("comandas").select("id, estado, print_count").eq("empresa_id", empresaId).eq("id", comandaId).maybeSingle();
  if (cur.error) throw new Error(cur.error.message);
  if (!cur.data) throw new Error("Comanda no encontrada.");
  const row = cur.data as { estado: string; print_count: number | string | null };
  if (row.estado === "cancelada") throw new Error("La comanda fue cancelada; no se puede imprimir.");

  const upd = await sb
    .from("comandas")
    .update({
      estado: "impresa",
      print_count: num(row.print_count) + 1,
      printed_at: new Date().toISOString(),
      printed_by: usuarioId,
    })
    .eq("empresa_id", empresaId).eq("id", comandaId)
    .select(COMANDA_COLS).single();
  if (upd.error) throw new Error(upd.error.message);

  try {
    const consumo = await consumirInsumosDeComanda(schema, empresaId, comandaId, {
      id: usuarioId,
      nombre: null,
    });
    if (consumo.faltantes.length > 0) {
      console.warn("[comandas] insumos en negativo tras la comanda", {
        comandaId,
        faltantes: consumo.faltantes.map((f) => `${f.insumo_nombre}: ${f.stock_resultante}`),
      });
    }
  } catch (e) {
    console.error("[comandas] no se pudieron descontar los insumos", {
      comandaId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const cards = await armarCards(sb, empresaId, [upd.data as unknown as ComandaRow]);
  return cards[0];
}

/** Cancela una comanda (ticket). No toca la cuenta de la mesa ni la facturación. */
export async function cancelarComandaPg(
  schema: string,
  empresaId: string,
  comandaId: string,
  usuarioId: string | null
): Promise<ComandaCard> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const upd = await sb
    .from("comandas")
    .update({ estado: "cancelada", cancelled_at: new Date().toISOString(), cancelled_by: usuarioId })
    .eq("empresa_id", empresaId).eq("id", comandaId)
    .select(COMANDA_COLS).single();
  if (upd.error) throw new Error(upd.error.message);
  const cards = await armarCards(sb, empresaId, [upd.data as unknown as ComandaRow]);
  return cards[0];
}
