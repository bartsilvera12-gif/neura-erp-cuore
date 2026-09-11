/**
 * Clave que autoriza los descuentos.
 *
 * Se guarda hasheada con bcrypt y se compara en la base: la clave en claro
 * nunca se persiste ni se registra en un log. Quien lea la base no puede
 * aplicar descuentos, y si la base se filtra la clave no viaja con ella.
 *
 * La comparación es del lado del servidor a propósito. Si la pantalla recibiera
 * el hash para compararlo, cualquiera con la consola abierta podría saltearse
 * el paso; así lo único que viaja de vuelta es sí o no.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { Pool } from "pg";

function pool(): Pool {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool de Postgres no disponible.");
  return p;
}

export interface EstadoClaveDescuento {
  /** Hay clave cargada: sin esto no se puede descontar. */
  configurada: boolean;
  /** Tope de descuento permitido, en porcentaje del total. */
  maxPorcentaje: number;
}

export async function estadoClaveDescuentoPg(
  schemaRaw: string,
  empresaId: string
): Promise<EstadoClaveDescuento> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "empresa_descuento_config");
  const { rows } = await pool().query<{ tiene: boolean; max_porcentaje: string | number }>(
    `SELECT (clave_hash IS NOT NULL AND clave_hash <> '') AS tiene, max_porcentaje
       FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  const r = rows[0];
  return {
    configurada: r?.tiene === true,
    maxPorcentaje: r ? Number(r.max_porcentaje) || 100 : 100,
  };
}

/**
 * ¿Es correcta la clave? La comparación la hace Postgres con `crypt`, que es
 * resistente a comparaciones apuradas carácter por carácter.
 */
export async function verificarClaveDescuentoPg(
  schemaRaw: string,
  empresaId: string,
  clave: string
): Promise<boolean> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "empresa_descuento_config");
  if (typeof clave !== "string" || clave === "") return false;

  const { rows } = await pool().query<{ ok: boolean }>(
    `SELECT (clave_hash IS NOT NULL AND clave_hash = extensions.crypt($2, clave_hash)) AS ok
       FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId, clave]
  );
  return rows[0]?.ok === true;
}
