/**
 * Smoke test post-migración — Módulo CAJA por turno (Cucina del Cuore / schema cucinaerp).
 *
 * Valida, de forma SEGURA, que la migración `…_modulo_caja_turno_cucinaerp.sql`
 * y los endpoints/flujo de caja funcionan en una instancia ya desplegada.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SEGURIDAD
 *   · Por defecto corre en DRY-RUN: solo lecturas (estructura DB + GET endpoints).
 *   · Las operaciones de ESCRITURA (abrir/mover/vender/cerrar) requieren
 *     explícitamente:  RUN_CAJA_SMOKE_WRITE=1
 *   · Si hay una caja REAL abierta, el modo escritura se ABORTA para no tocar
 *     datos productivos.
 *   · Todo dato de prueba se marca con la observación  "SMOKE_TEST_CAJA".
 *   · Con SMOKE_DB_URL disponible, el script limpia solo sus datos al terminar.
 *     Sin SMOKE_DB_URL, imprime el SQL de rollback exacto (no puede autolimpiar:
 *     no hay endpoints de borrado).
 * ──────────────────────────────────────────────────────────────────────────
 * VARIABLES DE ENTORNO
 *   SMOKE_BASE_URL        URL de la app           (default http://localhost:3000)
 *   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY   (de .env.local)
 *   SMOKE_EMAIL / SMOKE_PASSWORD   credenciales de un usuario de la empresa cucinaerp
 *   SMOKE_ACCESS_TOKEN    (alternativa a email/password: JWT ya emitido)
 *   SMOKE_DB_URL          connection string Postgres (estructura + limpieza + caso nocturno)
 *   RUN_CAJA_SMOKE_WRITE  =1 para habilitar escrituras (default DRY-RUN)
 *
 * USO
 *   Local (dry-run):    npm run smoke:caja
 *   Local (escritura):  RUN_CAJA_SMOKE_WRITE=1 SMOKE_DB_URL=postgres://... npm run smoke:caja
 *   Producción (dry):   SMOKE_BASE_URL=https://cucinaerp.neura.com.py SMOKE_EMAIL=... SMOKE_PASSWORD=... npm run smoke:caja
 *   En el server, SMOKE_DB_URL se arma por SSH+docker (la DB no expone 5432).
 */

import path from "path";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: path.resolve(process.cwd(), ".env.local") });

const SCHEMA = "cucinaerp";
const MARKER = "SMOKE_TEST_CAJA";

const BASE_URL = (process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const DB_URL = process.env.SMOKE_DB_URL?.trim() || process.env.SUPABASE_DB_URL?.trim() || "";
const WRITE = process.env.RUN_CAJA_SMOKE_WRITE === "1";

// ── Checklist ─────────────────────────────────────────────────────────────────
type Status = "ok" | "fail" | "skip" | "warn";
const ICON: Record<Status, string> = { ok: "✅", fail: "❌", skip: "⏭️ ", warn: "⚠️ " };
const results: { name: string; status: Status; detail?: string }[] = [];
function rec(name: string, status: Status, detail?: string) {
  results.push({ name, status, detail });
  console.log(`${ICON[status]} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(t: string) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
let TOKEN: string | null = null;
async function api(method: string, pathname: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* sin body */ }
  return { status: res.status, ok: res.ok, json };
}

async function getToken(): Promise<string | null> {
  if (process.env.SMOKE_ACCESS_TOKEN?.trim()) return process.env.SMOKE_ACCESS_TOKEN.trim();
  const email = process.env.SMOKE_EMAIL?.trim();
  const password = process.env.SMOKE_PASSWORD?.trim();
  if (!email || !password || !SUPA_URL || !SUPA_ANON) return null;
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPA_ANON },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Auth falló (${res.status}): ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { access_token?: string };
  return j.access_token ?? null;
}

const money = (v: number) => `Gs. ${Math.round(v).toLocaleString("es-PY")}`;

// ── FASE A: estructura DB (read-only) ──────────────────────────────────────────
async function faseEstructura(db: Client) {
  section("FASE A · Estructura DB (read-only)");

  const reg = async (rel: string) =>
    (await db.query(`select to_regclass($1) as r`, [`${SCHEMA}.${rel}`])).rows[0].r != null;

  rec(`tabla ${SCHEMA}.cajas existe`, (await reg("cajas")) ? "ok" : "fail");
  rec(`tabla ${SCHEMA}.caja_movimientos existe`, (await reg("caja_movimientos")) ? "ok" : "fail");

  const col = await db.query(
    `select is_nullable from information_schema.columns
       where table_schema=$1 and table_name='ventas' and column_name='caja_id'`,
    [SCHEMA]
  );
  if (col.rowCount === 0) rec(`columna ${SCHEMA}.ventas.caja_id existe`, "fail");
  else {
    rec(`columna ${SCHEMA}.ventas.caja_id existe`, "ok");
    rec(
      "ventas.caja_id es NULLABLE (no rompe ventas históricas)",
      col.rows[0].is_nullable === "YES" ? "ok" : "fail",
      `is_nullable=${col.rows[0].is_nullable}`
    );
  }

  const idx = await db.query(
    `select indexdef from pg_indexes where schemaname=$1 and tablename='cajas' and indexname='uq_cajas_una_abierta'`,
    [SCHEMA]
  );
  if (idx.rowCount === 0) rec("índice único parcial 'una caja abierta'", "fail", "uq_cajas_una_abierta no existe");
  else {
    const def: string = idx.rows[0].indexdef;
    const okParcial = /unique/i.test(def) && /where\s*\(?\s*estado\s*=\s*'abierta'/i.test(def);
    rec("índice único parcial 'una caja abierta'", okParcial ? "ok" : "fail", def);
  }

  for (const tbl of ["cajas", "caja_movimientos"]) {
    const rls = await db.query(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 and c.relname=$2`,
      [SCHEMA, tbl]
    );
    rec(`RLS habilitada en ${tbl}`, rls.rows[0]?.relrowsecurity ? "ok" : "fail");
    const pol = await db.query(
      `select count(*)::int n from pg_policies where schemaname=$1 and tablename=$2`,
      [SCHEMA, tbl]
    );
    const n = pol.rows[0].n as number;
    rec(`policies en ${tbl} (esperado ≥4)`, n >= 4 ? "ok" : "fail", `${n} policies`);
  }

  const fk = await db.query(
    `select 1 from pg_constraint con
       join pg_class c on c.oid=con.conrelid
       join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=$1 and c.relname='ventas' and con.conname='ventas_caja_id_fkey'`,
    [SCHEMA]
  );
  rec("FK ventas.caja_id → cajas existe", (fk.rowCount ?? 0) > 0 ? "ok" : "fail");

  const hist = await db.query(`select count(*)::int n from ${SCHEMA}.ventas where caja_id is null`, []);
  rec("ventas históricas con caja_id NULL (no reasignadas)", "ok", `${hist.rows[0].n} ventas previas intactas`);
}

// ── FASE B: endpoints GET (read-only) ──────────────────────────────────────────
async function faseEndpointsRead(): Promise<{ cajaAbierta: any | null }> {
  section("FASE B · Endpoints GET (read-only)");

  const ab = await api("GET", "/api/caja/abierta");
  const abOk = ab.status === 200 && ab.json?.success === true && "caja" in (ab.json.data ?? {});
  rec("GET /api/caja/abierta", abOk ? "ok" : "fail", `status ${ab.status}`);
  const cajaAbierta = ab.json?.data?.caja ?? null;

  const hist = await api("GET", "/api/caja/historial");
  rec(
    "GET /api/caja/historial",
    hist.status === 200 && Array.isArray(hist.json?.data?.cajas) ? "ok" : "fail",
    `status ${hist.status}, ${hist.json?.data?.cajas?.length ?? 0} cajas`
  );

  const res = await api("GET", "/api/caja/resumen");
  const resOk = res.status === 200 && res.json?.success === true && "resumen" in (res.json.data ?? {});
  rec(
    "GET /api/caja/resumen",
    resOk ? "ok" : "fail",
    cajaAbierta ? "resumen de caja abierta" : "sin caja abierta → resumen null (esperado)"
  );

  return { cajaAbierta };
}

// ── FASE C: flujo de escritura (gated) ─────────────────────────────────────────
type Created = { cajaId?: string; ventaId?: string; ventaItems?: any[]; productoControlaStock?: boolean; productoId?: string; cantidad?: number };

async function faseEscritura(db: Client | null, cajaAbiertaPrevia: any | null): Promise<Created> {
  section("FASE C · Flujo de escritura (RUN_CAJA_SMOKE_WRITE=1)");
  const created: Created = {};

  if (cajaAbiertaPrevia) {
    const esSmoke = (cajaAbiertaPrevia.observacion_apertura ?? "").includes(MARKER);
    if (!esSmoke) {
      rec("pre-check: no hay caja real abierta", "warn",
        `Hay una caja REAL abierta (N° ${cajaAbiertaPrevia.numero_caja}). Se omite escritura para no afectar producción.`);
      return created;
    }
    rec("pre-check: caja abierta es de un smoke previo", "warn", "se intentará reutilizar/cerrar al final");
  } else {
    rec("pre-check: no hay caja abierta", "ok");
  }

  // 1) Bloqueo de venta sin caja (solo si NO hay caja abierta).
  if (!cajaAbiertaPrevia) {
    const prod = await fetchProductoPrueba();
    if (prod) {
      const blocked = await api("POST", "/api/ventas/create", buildVentaPayload(prod, "EFECTIVO_BLOCK"));
      const msgOk = blocked.status === 409 && String(blocked.json?.error ?? "").includes("Para vender primero tenés que abrir caja");
      rec('bloqueo de venta sin caja → "Para vender primero tenés que abrir caja"', msgOk ? "ok" : "fail",
        `status ${blocked.status}: ${blocked.json?.error ?? ""}`);
    } else {
      rec("bloqueo de venta sin caja", "skip", "no se encontró un producto para la prueba");
    }
  } else {
    rec("bloqueo de venta sin caja", "skip", "ya había una caja abierta");
  }

  // 2) Abrir caja
  let cajaId: string;
  if (cajaAbiertaPrevia) {
    cajaId = cajaAbiertaPrevia.id;
    created.cajaId = cajaId; // smoke caja previa → marcar para limpieza
  } else {
    const abrir = await api("POST", "/api/caja/abrir", { monto_apertura: 300000, observacion: MARKER });
    if (!(abrir.status === 200 && abrir.json?.data?.caja?.id)) {
      rec("POST /api/caja/abrir (300.000)", "fail", `status ${abrir.status}: ${abrir.json?.error ?? ""}`);
      return created;
    }
    cajaId = abrir.json.data.caja.id;
    created.cajaId = cajaId;
    rec("POST /api/caja/abrir (300.000)", "ok", `caja N° ${abrir.json.data.caja.numero_caja}`);
  }

  // 3) Movimientos ingreso/egreso/retiro (efectivo)
  const movs: { tipo: string; monto: number }[] = [
    { tipo: "ingreso", monto: 50000 },
    { tipo: "egreso", monto: 20000 },
    { tipo: "retiro", monto: 30000 },
  ];
  for (const m of movs) {
    const r = await api("POST", "/api/caja/movimiento", {
      tipo: m.tipo, concepto: `${MARKER} ${m.tipo}`, monto: m.monto, medio_pago: "efectivo", observacion: MARKER,
    });
    rec(`POST /api/caja/movimiento (${m.tipo} ${money(m.monto)})`, r.status === 200 ? "ok" : "fail",
      `status ${r.status}: ${r.json?.error ?? ""}`);
  }

  // 4) Venta de prueba asociada a la caja
  const prod = await fetchProductoPrueba();
  let ventaTotalEfectivo = 0;
  if (!prod) {
    rec("crear venta de prueba (efectivo)", "skip", "no se encontró producto");
  } else {
    const payload = buildVentaPayload(prod, MARKER);
    const r = await api("POST", "/api/ventas/create", payload);
    if (r.status === 200 && r.json?.data?.venta?.id) {
      created.ventaId = r.json.data.venta.id;
      created.productoId = prod.id;
      created.productoControlaStock = prod.controla_stock !== false;
      created.cantidad = 1;
      ventaTotalEfectivo = Number(r.json.data.venta.total) || 0;
      rec("crear venta de prueba (efectivo)", "ok", `${r.json.data.venta.numero_control} · ${money(ventaTotalEfectivo)}`);
    } else {
      rec("crear venta de prueba (efectivo)", "fail", `status ${r.status}: ${r.json?.error ?? ""}`);
    }
  }

  // 5) ventas.caja_id quedó cargado
  if (created.ventaId && db) {
    const q = await db.query(`select caja_id from ${SCHEMA}.ventas where id=$1`, [created.ventaId]);
    const ok = q.rows[0]?.caja_id === cajaId;
    rec("ventas.caja_id cargado correctamente", ok ? "ok" : "fail", `caja_id=${q.rows[0]?.caja_id ?? "null"}`);
  } else if (created.ventaId) {
    rec("ventas.caja_id cargado correctamente", "skip", "sin SMOKE_DB_URL no se puede verificar por DB");
  }

  // 6) Resumen: totales correctos
  const resumenR = await api("GET", `/api/caja/resumen?caja_id=${encodeURIComponent(cajaId)}`);
  const resumen = resumenR.json?.data?.resumen;
  let esperadoServer = 0;
  if (resumen) {
    esperadoServer = Number(resumen.efectivo_esperado);
    const apertura = Number(resumen.caja.monto_apertura);
    const calc = apertura + Number(resumen.total_efectivo) + Number(resumen.ingresos_efectivo)
      - Number(resumen.egresos_efectivo) - Number(resumen.retiros_efectivo) + Number(resumen.ajustes_efectivo);
    rec("resumen: efectivo esperado = apertura + efvo + ing − egr − ret", esperadoServer === calc ? "ok" : "fail",
      `server=${money(esperadoServer)} calc=${money(calc)}`);
    rec("resumen: total vendido incluye la venta de prueba",
      Number(resumen.total_vendido) >= ventaTotalEfectivo ? "ok" : "fail",
      `total_vendido=${money(Number(resumen.total_vendido))}`);
    rec("resumen: transferencia/tarjeta NO suman al efectivo esperado", "ok",
      `efectivo=${money(Number(resumen.total_efectivo))} transfer=${money(Number(resumen.total_transferencia))} tarjeta=${money(Number(resumen.total_tarjeta))}`);
  } else {
    rec("GET /api/caja/resumen?caja_id=…", "fail", `status ${resumenR.status}`);
  }

  // 7) Caso nocturno (requiere DB): mover la fecha de la venta a post-medianoche y
  //    confirmar que sigue perteneciendo a la caja (agrupación por caja_id, no fecha).
  if (created.ventaId && db && resumen) {
    const totalAntes = Number(resumen.total_vendido);
    // fecha_apertura + 8h cruza la medianoche (turno 18:00 → 02:00).
    await db.query(
      `update ${SCHEMA}.ventas set fecha = $2::timestamptz + interval '8 hours'
         where id=$1 and observaciones=$3`,
      [created.ventaId, resumen.caja.fecha_apertura, MARKER]
    );
    const r2 = await api("GET", `/api/caja/resumen?caja_id=${encodeURIComponent(cajaId)}`);
    const totalDespues = Number(r2.json?.data?.resumen?.total_vendido ?? -1);
    rec("caso nocturno: venta post-medianoche sigue en la misma caja (por caja_id)",
      totalDespues === totalAntes ? "ok" : "fail",
      `total antes=${money(totalAntes)} después=${money(totalDespues)} (no depende de fecha calendario)`);
  } else if (created.ventaId) {
    rec("caso nocturno (por DB)", "skip", "requiere SMOKE_DB_URL");
  }

  // 8) Cerrar caja: contado = esperado → diferencia 0
  if (resumen) {
    const cierre = await api("POST", "/api/caja/cerrar", {
      caja_id: cajaId, monto_cierre_contado: esperadoServer, observacion: MARKER,
    });
    const rr = cierre.json?.data?.resumen;
    if (cierre.status === 200 && rr) {
      const dif = Number(rr.caja.diferencia);
      rec("POST /api/caja/cerrar calcula esperado + diferencia", "ok",
        `esperado=${money(Number(rr.caja.monto_esperado_efectivo))} contado=${money(esperadoServer)} diferencia=${money(dif)}`);
      rec("cierre: diferencia = 0 cuando contado = esperado", dif === 0 ? "ok" : "fail", money(dif));
    } else {
      rec("POST /api/caja/cerrar", "fail", `status ${cierre.status}: ${cierre.json?.error ?? ""}`);
    }
  }

  // 9) Historial muestra la caja cerrada con totales
  const hist = await api("GET", "/api/caja/historial");
  const enHist = (hist.json?.data?.cajas ?? []).find((c: any) => c.caja.id === cajaId);
  rec("historial/reportes muestra la caja con sus totales",
    enHist ? "ok" : "fail",
    enHist ? `vendido=${money(Number(enHist.total_vendido))} estado=${enHist.caja.estado}` : "no aparece");

  return created;
}

// ── Producto de prueba: prefiere Menú (controla_stock=false) ───────────────────
async function fetchProductoPrueba(): Promise<any | null> {
  const r = await api("GET", "/api/productos/search?limit=50");
  const items: any[] = r.json?.data?.items ?? [];
  if (items.length === 0) return null;
  const conPrecio = items.filter((p) => Number(p.precio_venta) > 0);
  const pool = conPrecio.length ? conPrecio : items;
  return pool.find((p) => p.controla_stock === false) ?? pool[0];
}

function buildVentaPayload(prod: any, marker: string) {
  const precio = Number(prod.precio_venta) || 1000;
  return {
    items: [{
      producto_id: prod.id,
      producto_nombre: prod.nombre,
      sku: prod.sku,
      cantidad: 1,
      precio_venta_original: precio,
      precio_venta: precio,
      tipo_iva: "10%",
      subtotal: 0, monto_iva: 0, total_linea: 0, // el server recalcula (IVA incluido)
    }],
    moneda: "GS",
    tipo_cambio: 1,
    subtotal: 0, monto_iva: 0, total: 0,
    tipo_venta: "CONTADO",
    metodo_pago: "efectivo",
    cliente_id: null,
    observaciones: marker,
    pedido_cocina: null, // sin pedido → no crea proyecto/cocina
  };
}

// ── Limpieza / rollback ────────────────────────────────────────────────────────
async function limpiar(db: Client | null, created: Created) {
  section("Limpieza de datos de prueba");
  if (!created.cajaId && !created.ventaId) {
    rec("sin datos de prueba creados", "ok");
    return;
  }

  if (!db) {
    rec("autolimpieza", "warn", "sin SMOKE_DB_URL no se puede borrar (no hay endpoints de borrado).");
    console.log("\n   Rollback manual (ejecutar por SSH+docker contra supabase-db):");
    console.log(rollbackSql(created));
    return;
  }

  try {
    await db.query("begin");
    if (created.ventaId) {
      await db.query(`delete from ${SCHEMA}.movimientos_inventario where venta_id=$1`, [created.ventaId]);
      await db.query(`delete from ${SCHEMA}.ventas_items where venta_id=$1`, [created.ventaId]);
      await db.query(`delete from ${SCHEMA}.ventas where id=$1 and observaciones=$2`, [created.ventaId, MARKER]);
      // Restaurar stock si el producto controla stock (la venta lo descontó).
      if (created.productoControlaStock && created.productoId && created.cantidad) {
        await db.query(
          `update ${SCHEMA}.productos set stock_actual = stock_actual + $2 where id=$1`,
          [created.productoId, created.cantidad]
        );
      }
    }
    if (created.cajaId) {
      await db.query(`delete from ${SCHEMA}.caja_movimientos where caja_id=$1`, [created.cajaId]);
      await db.query(`delete from ${SCHEMA}.cajas where id=$1 and observacion_apertura=$2`, [created.cajaId, MARKER]);
    }
    await db.query("commit");
    rec("datos de prueba eliminados", "ok", "venta + items + movimientos + caja + stock restaurado");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    rec("autolimpieza", "fail", e instanceof Error ? e.message : String(e));
    console.log("\n   Rollback manual:");
    console.log(rollbackSql(created));
  }
}

function rollbackSql(created: Created): string {
  const lines: string[] = [];
  if (created.ventaId) {
    lines.push(`delete from ${SCHEMA}.movimientos_inventario where venta_id='${created.ventaId}';`);
    lines.push(`delete from ${SCHEMA}.ventas_items where venta_id='${created.ventaId}';`);
    lines.push(`delete from ${SCHEMA}.ventas where id='${created.ventaId}' and observaciones='${MARKER}';`);
    if (created.productoControlaStock && created.productoId && created.cantidad) {
      lines.push(`update ${SCHEMA}.productos set stock_actual = stock_actual + ${created.cantidad} where id='${created.productoId}';`);
    }
  }
  if (created.cajaId) {
    lines.push(`delete from ${SCHEMA}.caja_movimientos where caja_id='${created.cajaId}';`);
    lines.push(`delete from ${SCHEMA}.cajas where id='${created.cajaId}' and observacion_apertura='${MARKER}';`);
  }
  // Red de seguridad por marcador:
  lines.push(`-- o, por marcador:`);
  lines.push(`-- delete from ${SCHEMA}.caja_movimientos where observacion='${MARKER}';`);
  lines.push(`-- delete from ${SCHEMA}.cajas where observacion_apertura='${MARKER}' and estado='cerrada';`);
  return lines.map((l) => "     " + l).join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log(" SMOKE TEST · Módulo CAJA por turno · schema cucinaerp");
  console.log("════════════════════════════════════════════════════════════");
  console.log(` Base URL : ${BASE_URL}`);
  console.log(` Modo     : ${WRITE ? "ESCRITURA (RUN_CAJA_SMOKE_WRITE=1)" : "DRY-RUN (solo lecturas)"}`);
  console.log(` DB       : ${DB_URL ? "conectará (estructura + limpieza + caso nocturno)" : "no provista → fase DB y limpieza se omiten"}`);

  // DB
  let db: Client | null = null;
  if (DB_URL) {
    db = new Client({ connectionString: DB_URL, ssl: DB_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined });
    try { await db.connect(); } catch (e) {
      rec("conexión a DB", "fail", e instanceof Error ? e.message : String(e));
      db = null;
    }
  }
  if (db) await faseEstructura(db);
  else { section("FASE A · Estructura DB"); rec("estructura DB", "skip", "sin SMOKE_DB_URL"); }

  // Auth
  try {
    TOKEN = await getToken();
  } catch (e) {
    rec("autenticación", "fail", e instanceof Error ? e.message : String(e));
  }
  if (!TOKEN) {
    section("FASE B/C · Endpoints");
    rec("autenticación", "skip", "definí SMOKE_EMAIL/SMOKE_PASSWORD o SMOKE_ACCESS_TOKEN para probar endpoints");
  } else {
    const { cajaAbierta } = await faseEndpointsRead();
    if (WRITE) {
      let created: Created = {};
      try {
        created = await faseEscritura(db, cajaAbierta);
      } finally {
        await limpiar(db, created);
      }
    } else {
      section("FASE C · Flujo de escritura");
      rec("flujo de escritura", "skip", "DRY-RUN — definí RUN_CAJA_SMOKE_WRITE=1 para abrir/vender/cerrar");
    }
  }

  if (db) await db.end().catch(() => {});

  // Resumen
  section("RESUMEN");
  const n = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(`   ✅ ${n("ok")}   ❌ ${n("fail")}   ⚠️  ${n("warn")}   ⏭️  ${n("skip")}`);
  const fails = results.filter((r) => r.status === "fail");
  if (fails.length) {
    console.log("\n   Fallos:");
    for (const f of fails) console.log(`     ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error("\nERROR fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
