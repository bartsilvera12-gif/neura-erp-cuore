/**
 * Cuánto tarda una factura electrónica, etapa por etapa.
 *
 * Sirve para discutir la velocidad con números en vez de impresiones, y para
 * ver qué parte del tiempo es nuestra y cuál es del SET:
 *
 *   cola / xml / firmar  → nuestro
 *   enviar / consulta    → del SET
 *
 * `consulta` en cero o vacío significa que el documento se resolvió por el
 * canal sincrónico, que es lo que se busca. Si aparece con valores altos, el
 * envío está cayendo al camino de lote.
 *
 * Sólo lee.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const LIMITE = Number(process.argv.find((a) => /^\d+$/.test(a)) || 20);

const seg = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();

  const { rows } = await c.query(`
    SELECT f.numero_factura, j.estado,
           round(extract(epoch from (j.started_at - j.created_at)) * 1000)::int AS cola,
           j.tiempo_xml_ms, j.tiempo_firmar_ms, j.tiempo_enviar_ms,
           j.tiempo_consulta_ms, j.tiempo_total_ms
      FROM ${S}.sifen_jobs j
      LEFT JOIN ${S}.facturas f ON f.id = j.factura_id
     ORDER BY j.created_at DESC
     LIMIT ${LIMITE}`);

  if (rows.length === 0) {
    console.log("Todavía no hay trabajos registrados.");
    await c.end();
    return;
  }

  console.table(rows.map((r) => ({
    factura: r.numero_factura,
    estado: r.estado,
    cola: seg(r.cola),
    xml: seg(r.tiempo_xml_ms),
    firmar: seg(r.tiempo_firmar_ms),
    enviar: seg(r.tiempo_enviar_ms),
    consulta: seg(r.tiempo_consulta_ms),
    total: seg(r.tiempo_total_ms),
  })));

  const ok = rows.filter((r) => r.estado === "aprobado" && r.tiempo_total_ms != null);
  if (ok.length > 0) {
    const prom = (k) => Math.round(ok.reduce((a, b) => a + (b[k] || 0), 0) / ok.length);
    const nuestro = prom("cola") + prom("tiempo_xml_ms") + prom("tiempo_firmar_ms");
    const delSet = prom("tiempo_enviar_ms") + prom("tiempo_consulta_ms");
    console.log(`\nSobre ${ok.length} factura(s) aprobada(s):`);
    console.log(`  nuestro:  cola ${seg(prom("cola"))} + xml ${seg(prom("tiempo_xml_ms"))} + firmar ${seg(prom("tiempo_firmar_ms"))} = ${seg(nuestro)}`);
    console.log(`  del SET:  enviar ${seg(prom("tiempo_enviar_ms"))} + consulta ${seg(prom("tiempo_consulta_ms"))} = ${seg(delSet)}`);
    console.log(`  total:    ${seg(prom("tiempo_total_ms"))}`);
  }

  // Se cuentan DOCUMENTOS distintos y separando aprobados de rechazados. Contar
  // eventos engañaba: un mismo documento reintentado tres veces aparecía como
  // "3 resueltos por el sincrónico" cuando en realidad eran tres rechazos del
  // mismo, y el canal no había aprobado ninguno.
  const via = await c.query(`
    SELECT count(DISTINCT factura_electronica_id) FILTER (
             WHERE detalle->>'origen' = 'api_enviar_sincronico'
               AND detalle->>'estado_sifen_nuevo' = 'aprobado')::int AS sinc_ok,
           count(DISTINCT factura_electronica_id) FILTER (
             WHERE detalle->>'origen' = 'api_enviar_sincronico'
               AND detalle->>'estado_sifen_nuevo' = 'rechazado')::int AS sinc_rechazo
      FROM ${S}.factura_electronica_evento`);
  console.log(
    `\nDocumentos APROBADOS por el canal sincrónico: ${via.rows[0].sinc_ok}` +
      ` · rechazados por ese canal: ${via.rows[0].sinc_rechazo}`
  );

  // Desglose del tramo de envío, si el documento ya se emitió con la versión
  // que lo registra. Responde si el envío se va en el storage o en el SET.
  const det = await c.query(`
    SELECT f.numero_factura,
           (e.detalle->>'ms_descarga_xml')::int         AS xml_ms,
           (e.detalle->>'ms_descarga_certificado')::int AS cert_ms,
           (e.detalle->>'ms_llamada_set')::int         AS set_ms
      FROM ${S}.factura_electronica_evento e
      JOIN ${S}.factura_electronica fe ON fe.id = e.factura_electronica_id
      JOIN ${S}.facturas f ON f.id = fe.factura_id
     WHERE e.detalle->>'ms_llamada_set' IS NOT NULL
     ORDER BY e.created_at DESC LIMIT 8`);
  if (det.rows.length > 0) {
    console.log(`
Dentro del envío (descargas nuestras vs llamada al SET):`);
    console.table(det.rows.map((r) => ({
      factura: r.numero_factura,
      'descarga XML': seg(r.xml_ms),
      'descarga cert.': seg(r.cert_ms),
      'llamada al SET': seg(r.set_ms),
    })));
  }

  await c.end();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
