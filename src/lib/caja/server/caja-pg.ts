import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import type {
  Caja,
  CajaDetalle,
  CajaMovimiento,
  CajaResumen,
  EstadoCaja,
  EstadoCuentaLomiteria,
  MedioPagoCaja,
  TipoMovimientoCaja,
  VentaDeCaja,
} from "@/lib/caja/types";

// ── Helpers de mapeo ──────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

interface CajaRow {
  id: string;
  numero_caja: number | string;
  estado: string;
  abierta_por: string | null;
  cerrada_por: string | null;
  fecha_apertura: string;
  fecha_cierre: string | null;
  monto_apertura: number | string;
  monto_cierre_contado: number | string | null;
  monto_esperado_efectivo: number | string | null;
  diferencia: number | string | null;
  observacion_apertura: string | null;
  observacion_cierre: string | null;
}

function mapCaja(r: CajaRow): Caja {
  return {
    id: r.id,
    numero_caja: num(r.numero_caja),
    estado: (r.estado === "cerrada" ? "cerrada" : "abierta") as EstadoCaja,
    abierta_por: r.abierta_por,
    cerrada_por: r.cerrada_por,
    fecha_apertura: r.fecha_apertura,
    fecha_cierre: r.fecha_cierre,
    monto_apertura: num(r.monto_apertura),
    monto_cierre_contado: r.monto_cierre_contado == null ? null : num(r.monto_cierre_contado),
    monto_esperado_efectivo: r.monto_esperado_efectivo == null ? null : num(r.monto_esperado_efectivo),
    diferencia: r.diferencia == null ? null : num(r.diferencia),
    observacion_apertura: r.observacion_apertura,
    observacion_cierre: r.observacion_cierre,
  };
}

const CAJA_COLS =
  "id, numero_caja, estado, abierta_por, cerrada_por, fecha_apertura, fecha_cierre, monto_apertura, monto_cierre_contado, monto_esperado_efectivo, diferencia, observacion_apertura, observacion_cierre";

// ── Lecturas ──────────────────────────────────────────────────────────────────

/** Caja abierta actual de la empresa (o null si no hay ninguna abierta). */
export async function getCajaAbiertaPg(schema: string, empresaId: string): Promise<Caja | null> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const q = await sb
    .from("cajas")
    .select(CAJA_COLS)
    .eq("empresa_id", empresaId)
    .eq("estado", "abierta")
    .order("fecha_apertura", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (q.error) throw new Error(q.error.message);
  return q.data ? mapCaja(q.data as unknown as CajaRow) : null;
}

/** Historial de cajas (más recientes primero) con sus totales calculados. */
export async function listarCajasPg(
  schema: string,
  empresaId: string,
  limit = 100
): Promise<CajaResumen[]> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const q = await sb
    .from("cajas")
    .select(CAJA_COLS)
    .eq("empresa_id", empresaId)
    .order("fecha_apertura", { ascending: false })
    .limit(limit);
  if (q.error) throw new Error(q.error.message);
  const cajas = (q.data ?? []) as unknown as CajaRow[];
  const resumenes: CajaResumen[] = [];
  for (const row of cajas) {
    resumenes.push(await computeResumen(sb, empresaId, mapCaja(row)));
  }
  await attachUsuarioNombres(sb, resumenes);
  return resumenes;
}

/** Resumen/arqueo de UNA caja por id. */
export async function getResumenCajaPg(
  schema: string,
  empresaId: string,
  cajaId: string
): Promise<CajaResumen | null> {
  const sb = createServiceRoleClientWithDbSchema(schema);
  const q = await sb
    .from("cajas")
    .select(CAJA_COLS)
    .eq("empresa_id", empresaId)
    .eq("id", cajaId)
    .maybeSingle();
  if (q.error) throw new Error(q.error.message);
  if (!q.data) return null;
  const resumen = await computeResumen(sb, empresaId, mapCaja(q.data as unknown as CajaRow));
  await attachUsuarioNombres(sb, [resumen]);
  return resumen;
}

/** Detalle de una caja para reportes: arqueo + movimientos + ventas asociadas. */
export async function getCajaDetallePg(
  schema: string,
  empresaId: string,
  cajaId: string
): Promise<CajaDetalle | null> {
  const resumen = await getResumenCajaPg(schema, empresaId, cajaId);
  if (!resumen) return null;

  const sb = createServiceRoleClientWithDbSchema(schema);
  const vQ = await sb
    .from("ventas")
    .select("id, numero_control, fecha, metodo_pago, total")
    .eq("empresa_id", empresaId)
    .eq("caja_id", cajaId)
    .neq("estado", "anulada")
    .order("fecha", { ascending: true });
  if (vQ.error) throw new Error(vQ.error.message);
  const rows = (vQ.data ?? []) as unknown as Array<{
    id: string;
    numero_control: string;
    fecha: string;
    metodo_pago: string | null;
    total: number | string;
  }>;

  // Conteo de ítems por venta (ventas_items) para el detalle.
  const ids = rows.map((r) => r.id);
  const countByVenta = new Map<string, number>();
  if (ids.length) {
    const iQ = await sb.from("ventas_items").select("venta_id").eq("empresa_id", empresaId).in("venta_id", ids);
    if (!iQ.error) {
      for (const it of (iQ.data ?? []) as Array<{ venta_id: string }>) {
        countByVenta.set(it.venta_id, (countByVenta.get(it.venta_id) ?? 0) + 1);
      }
    }
  }

  const ventas: VentaDeCaja[] = rows.map((r) => ({
    id: r.id,
    numero_control: r.numero_control,
    fecha: r.fecha,
    metodo_pago:
      r.metodo_pago === "tarjeta" ? "tarjeta"
      : r.metodo_pago === "transferencia" ? "transferencia"
      : r.metodo_pago === "efectivo" ? "efectivo"
      : null,
    total: num(r.total),
    cantidad_items: countByVenta.get(r.id) ?? 0,
  }));

  // Conciliación bancaria de esta caja (transfer/tarjeta, pendiente/aprobada).
  const conciliacion = { transferencia_pendiente: 0, transferencia_aprobada: 0, tarjeta_pendiente: 0, tarjeta_aprobada: 0 };
  const cQ = await sb.from("conciliacion_pagos").select("medio_pago, estado, monto").eq("empresa_id", empresaId).eq("caja_id", cajaId);
  if (!cQ.error) {
    for (const x of (cQ.data ?? []) as Array<{ medio_pago: string; estado: string; monto: number | string }>) {
      const m = num(x.monto);
      if (x.medio_pago === "transferencia" && x.estado === "pendiente") conciliacion.transferencia_pendiente += m;
      else if (x.medio_pago === "transferencia" && x.estado === "aprobado") conciliacion.transferencia_aprobada += m;
      else if (x.medio_pago === "tarjeta" && x.estado === "pendiente") conciliacion.tarjeta_pendiente += m;
      else if (x.medio_pago === "tarjeta" && x.estado === "aprobado") conciliacion.tarjeta_aprobada += m;
    }
  }

  return { resumen, ventas, conciliacion };
}

/**
 * Estado de cuenta de la lomitería: agrega sobre cajas CERRADAS cuyo fecha_cierre
 * cae en [desde, hasta] (fechas yyyy-mm-dd, inclusivas). Se basa en caja/turno,
 * no en fecha calendario de cada venta.
 */
export async function getEstadoCuentaPg(
  schema: string,
  empresaId: string,
  desde: string | null,
  hasta: string | null
): Promise<EstadoCuentaLomiteria> {
  const cajas = await listarCajasPg(schema, empresaId, 300);
  const dStart = desde ? new Date(`${desde}T00:00:00`) : null;
  const dEnd = hasta ? new Date(`${hasta}T23:59:59.999`) : null;

  const cerradas = cajas.filter((c) => {
    if (c.caja.estado !== "cerrada" || !c.caja.fecha_cierre) return false;
    const f = new Date(c.caja.fecha_cierre);
    if (dStart && f < dStart) return false;
    if (dEnd && f > dEnd) return false;
    return true;
  });

  let total_vendido = 0, total_efectivo = 0, total_transferencia = 0, total_tarjeta = 0, total_qr = 0;
  let total_egresos = 0, total_retiros = 0, diferencias_acumuladas = 0;
  for (const c of cerradas) {
    total_vendido += c.total_vendido;
    total_efectivo += c.total_efectivo;
    total_transferencia += c.total_transferencia;
    total_tarjeta += c.total_tarjeta;
    total_qr += c.total_qr;
    total_egresos += c.egresos_efectivo;
    total_retiros += c.retiros_efectivo;
    diferencias_acumuladas += c.caja.diferencia ?? 0;
  }
  const n = cerradas.length;

  return {
    desde, hasta,
    cajas_cerradas: n,
    total_vendido, total_efectivo, total_transferencia, total_tarjeta, total_qr,
    total_egresos, total_retiros, diferencias_acumuladas,
    promedio_vendido: n ? Math.round(total_vendido / n) : 0,
    neto_estimado: total_vendido - total_egresos - total_retiros,
  };
}

type Sb = ReturnType<typeof createServiceRoleClientWithDbSchema>;

/**
 * Resuelve nombres de usuario (apertura/cierre) desde el catálogo central
 * `cucinaerp.usuarios`. Lectura best-effort: si falla, los nombres quedan null.
 */
async function attachUsuarioNombres(sb: Sb, resumenes: CajaResumen[]): Promise<void> {
  const ids = new Set<string>();
  for (const r of resumenes) {
    if (r.caja.abierta_por) ids.add(r.caja.abierta_por);
    if (r.caja.cerrada_por) ids.add(r.caja.cerrada_por);
  }
  if (ids.size === 0) return;
  try {
    const q = await sb.schema(SUPABASE_APP_SCHEMA).from("usuarios").select("id, nombre").in("id", [...ids]);
    if (q.error || !q.data) return;
    const byId = new Map<string, string>();
    for (const u of q.data as Array<{ id: string; nombre: string | null }>) {
      if (u.nombre) byId.set(u.id, u.nombre);
    }
    for (const r of resumenes) {
      r.abierta_por_nombre = r.caja.abierta_por ? byId.get(r.caja.abierta_por) ?? null : null;
      r.cerrada_por_nombre = r.caja.cerrada_por ? byId.get(r.caja.cerrada_por) ?? null : null;
    }
  } catch {
    /* nombres opcionales */
  }
}

/**
 * Calcula los totales de una caja a partir de sus ventas (por metodo_pago) y de
 * sus movimientos manuales. El efectivo esperado es la verdad del arqueo:
 *   apertura + ventas efectivo + ingresos efectivo − egresos efectivo
 *   − retiros efectivo + ajustes efectivo.
 * Tarjeta y transferencia suman al total vendido pero NO al efectivo esperado.
 */
async function computeResumen(sb: Sb, empresaId: string, caja: Caja): Promise<CajaResumen> {
  // Ventas de la caja (excluye anuladas).
  const vQ = await sb
    .from("ventas")
    .select("id, total, metodo_pago, estado")
    .eq("empresa_id", empresaId)
    .eq("caja_id", caja.id)
    .neq("estado", "anulada");
  if (vQ.error) throw new Error(vQ.error.message);
  const ventas = (vQ.data ?? []) as unknown as Array<{
    id: string;
    total: number | string;
    metodo_pago: string | null;
  }>;

  // El reparto por método sale del detalle de cobro y no de `metodo_pago`:
  // una venta cobrada 60.000 en efectivo y 40.000 por transferencia tiene un
  // solo método guardado, y contarla entera de un lado descuadra el arqueo por
  // plata que nunca entró al cajón.
  const pagosPorVenta = new Map<string, Array<{ metodo: string; monto: number }>>();
  const idsVentas = ventas.map((v) => v.id);
  if (idsVentas.length) {
    const pQ = await sb
      .from("ventas_pagos_detalle")
      .select("venta_id, metodo_pago, monto")
      .eq("empresa_id", empresaId)
      .in("venta_id", idsVentas);
    if (pQ.error) throw new Error(pQ.error.message);
    for (const p of (pQ.data ?? []) as Array<{ venta_id: string; metodo_pago: string; monto: number | string }>) {
      const lista = pagosPorVenta.get(p.venta_id) ?? [];
      lista.push({ metodo: p.metodo_pago, monto: num(p.monto) });
      pagosPorVenta.set(p.venta_id, lista);
    }
  }

  let totalVendido = 0;
  let totalEfectivo = 0;
  let totalTarjeta = 0;
  let totalTransferencia = 0;
  let totalQr = 0;
  for (const v of ventas) {
    const t = num(v.total);
    totalVendido += t;
    // Sin detalle (ventas anteriores a que existiera) se cae al método único.
    const lineas = pagosPorVenta.get(v.id) ?? [{ metodo: v.metodo_pago ?? "efectivo", monto: t }];
    for (const l of lineas) {
      if (l.metodo === "tarjeta") totalTarjeta += l.monto;
      else if (l.metodo === "transferencia") totalTransferencia += l.monto;
      // El QR no entra al cajón: se controla contra la liquidación del
      // proveedor, no contra el arqueo de efectivo.
      else if (l.metodo === "qr") totalQr += l.monto;
      else totalEfectivo += l.monto; // efectivo o método no especificado → efectivo
    }
  }

  // Movimientos manuales.
  const mQ = await sb
    .from("caja_movimientos")
    .select("id, caja_id, tipo, concepto, monto, medio_pago, usuario_id, observacion, created_at")
    .eq("empresa_id", empresaId)
    .eq("caja_id", caja.id)
    .order("created_at", { ascending: true });
  if (mQ.error) throw new Error(mQ.error.message);
  const movsRows = (mQ.data ?? []) as unknown as Array<{
    id: string;
    caja_id: string;
    tipo: string;
    concepto: string;
    monto: number | string;
    medio_pago: string | null;
    usuario_id: string | null;
    observacion: string | null;
    created_at: string;
  }>;

  let ingresosEf = 0;
  let egresosEf = 0;
  let retirosEf = 0;
  let ajustesEf = 0;
  const movimientos: CajaMovimiento[] = movsRows.map((m) => {
    const medio = (m.medio_pago ?? "efectivo") as MedioPagoCaja;
    const tipo = m.tipo as TipoMovimientoCaja;
    const monto = num(m.monto);
    if (medio === "efectivo") {
      if (tipo === "ingreso") ingresosEf += monto;
      else if (tipo === "egreso") egresosEf += monto;
      else if (tipo === "retiro") retirosEf += monto;
      else if (tipo === "ajuste") ajustesEf += monto; // signado: + sube, − baja
    }
    return {
      id: m.id,
      caja_id: m.caja_id,
      tipo,
      concepto: m.concepto,
      monto,
      medio_pago: medio,
      usuario_id: m.usuario_id,
      observacion: m.observacion,
      created_at: m.created_at,
    };
  });

  const efectivoEsperado =
    caja.monto_apertura + totalEfectivo + ingresosEf - egresosEf - retirosEf + ajustesEf;

  return {
    caja,
    abierta_por_nombre: null,
    cerrada_por_nombre: null,
    cantidad_ventas: ventas.length,
    total_vendido: totalVendido,
    total_efectivo: totalEfectivo,
    total_qr: totalQr,
    total_tarjeta: totalTarjeta,
    total_transferencia: totalTransferencia,
    ingresos_efectivo: ingresosEf,
    egresos_efectivo: egresosEf,
    retiros_efectivo: retirosEf,
    ajustes_efectivo: ajustesEf,
    efectivo_esperado: efectivoEsperado,
    movimientos,
  };
}

// ── Escrituras ────────────────────────────────────────────────────────────────

/** Abre una caja. Falla si ya hay una abierta (índice único parcial en DB). */
export async function abrirCajaPg(params: {
  schema: string;
  empresaId: string;
  montoApertura: number;
  observacion: string | null;
  usuarioId: string | null;
}): Promise<Caja> {
  const sb = createServiceRoleClientWithDbSchema(params.schema);

  const yaAbierta = await getCajaAbiertaPg(params.schema, params.empresaId);
  if (yaAbierta) {
    throw new Error("Ya hay una caja abierta. Cerrala antes de abrir una nueva.");
  }

  // numero_caja secuencial por empresa (best-effort; el índice único protege duplicados).
  const maxQ = await sb
    .from("cajas")
    .select("numero_caja")
    .eq("empresa_id", params.empresaId)
    .order("numero_caja", { ascending: false })
    .limit(1);
  if (maxQ.error) throw new Error(maxQ.error.message);
  const lastNum = num((maxQ.data?.[0] as { numero_caja?: number | string } | undefined)?.numero_caja);
  const numeroCaja = lastNum + 1;

  const ins = await sb
    .from("cajas")
    .insert({
      empresa_id: params.empresaId,
      numero_caja: numeroCaja,
      estado: "abierta",
      abierta_por: params.usuarioId,
      monto_apertura: Math.round(params.montoApertura),
      observacion_apertura: params.observacion,
    })
    .select(CAJA_COLS)
    .single();
  if (ins.error) {
    // 23505 = unique_violation (otra caja abierta o numero_caja en carrera).
    if (ins.error.code === "23505") {
      throw new Error("Ya hay una caja abierta. Cerrala antes de abrir una nueva.");
    }
    throw new Error(ins.error.message);
  }
  return mapCaja(ins.data as unknown as CajaRow);
}

/** Registra un movimiento manual en la caja abierta. */
export async function registrarMovimientoPg(params: {
  schema: string;
  empresaId: string;
  cajaId: string;
  tipo: TipoMovimientoCaja;
  concepto: string;
  monto: number;
  medioPago: MedioPagoCaja;
  observacion: string | null;
  usuarioId: string | null;
}): Promise<CajaMovimiento> {
  const sb = createServiceRoleClientWithDbSchema(params.schema);

  // La caja debe existir, pertenecer a la empresa y estar abierta.
  const cQ = await sb
    .from("cajas")
    .select("id, estado")
    .eq("empresa_id", params.empresaId)
    .eq("id", params.cajaId)
    .maybeSingle();
  if (cQ.error) throw new Error(cQ.error.message);
  if (!cQ.data) throw new Error("Caja no encontrada en esta empresa.");
  if ((cQ.data as { estado: string }).estado !== "abierta") {
    throw new Error("La caja está cerrada; no se pueden registrar movimientos.");
  }

  const ins = await sb
    .from("caja_movimientos")
    .insert({
      empresa_id: params.empresaId,
      caja_id: params.cajaId,
      tipo: params.tipo,
      concepto: params.concepto.trim(),
      monto: Math.round(params.monto),
      medio_pago: params.medioPago,
      usuario_id: params.usuarioId,
      observacion: params.observacion,
    })
    .select("id, caja_id, tipo, concepto, monto, medio_pago, usuario_id, observacion, created_at")
    .single();
  if (ins.error) throw new Error(ins.error.message);
  const m = ins.data as unknown as {
    id: string;
    caja_id: string;
    tipo: string;
    concepto: string;
    monto: number | string;
    medio_pago: string | null;
    usuario_id: string | null;
    observacion: string | null;
    created_at: string;
  };
  return {
    id: m.id,
    caja_id: m.caja_id,
    tipo: m.tipo as TipoMovimientoCaja,
    concepto: m.concepto,
    monto: num(m.monto),
    medio_pago: (m.medio_pago ?? "efectivo") as MedioPagoCaja,
    usuario_id: m.usuario_id,
    observacion: m.observacion,
    created_at: m.created_at,
  };
}

/** Cierra la caja: calcula efectivo esperado y diferencia, y persiste el arqueo. */
export async function cerrarCajaPg(params: {
  schema: string;
  empresaId: string;
  cajaId: string;
  montoCierreContado: number;
  observacion: string | null;
  usuarioId: string | null;
}): Promise<CajaResumen> {
  const sb = createServiceRoleClientWithDbSchema(params.schema);

  const resumen = await getResumenCajaPg(params.schema, params.empresaId, params.cajaId);
  if (!resumen) throw new Error("Caja no encontrada en esta empresa.");
  if (resumen.caja.estado !== "abierta") {
    throw new Error("La caja ya está cerrada.");
  }

  const contado = Math.round(params.montoCierreContado);
  const esperado = Math.round(resumen.efectivo_esperado);
  const diferencia = contado - esperado;

  const upd = await sb
    .from("cajas")
    .update({
      estado: "cerrada",
      cerrada_por: params.usuarioId,
      fecha_cierre: new Date().toISOString(),
      monto_cierre_contado: contado,
      monto_esperado_efectivo: esperado,
      diferencia,
      observacion_cierre: params.observacion,
    })
    .eq("empresa_id", params.empresaId)
    .eq("id", params.cajaId)
    .eq("estado", "abierta")
    .select(CAJA_COLS)
    .single();
  if (upd.error) throw new Error(upd.error.message);

  return {
    ...resumen,
    caja: mapCaja(upd.data as unknown as CajaRow),
    efectivo_esperado: esperado,
  };
}
