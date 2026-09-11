import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/clientes/buscar?q=
 *
 * Búsqueda liviana para la caja: nombre, RUC o cédula, y nada más. El listado
 * completo de clientes trae la ficha entera y varios enriquecimientos, que en
 * el mostrador — con el cliente esperando — no hacen falta y se pagan caro.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
    if (q.length < 2) return NextResponse.json(successResponse({ clientes: [] }));

    const schema = assertAllowedChatDataSchema(
      await fetchDataSchemaForEmpresaId(tenant.auth.empresa_id)
    );
    const pool = getChatPostgresPool();
    if (!pool) throw new Error("Pool de Postgres no disponible.");
    const t = quoteSchemaTable(schema, "clientes");

    const { rows } = await pool.query<{
      id: string;
      nombre: string | null;
      empresa: string | null;
      nombre_facturacion: string | null;
      ruc: string | null;
      documento: string | null;
      email: string | null;
      es_contribuyente: boolean | null;
    }>(
      `SELECT id, nombre, empresa, nombre_facturacion, ruc, documento, email, es_contribuyente
         FROM ${t}
        WHERE empresa_id = $1::uuid
          AND deleted_at IS NULL
          AND (
            COALESCE(nombre_facturacion, '') ILIKE '%' || $2 || '%'
            OR COALESCE(empresa, '') ILIKE '%' || $2 || '%'
            OR COALESCE(nombre, '') ILIKE '%' || $2 || '%'
            OR COALESCE(ruc, '') ILIKE '%' || $2 || '%'
            OR COALESCE(documento, '') ILIKE '%' || $2 || '%'
          )
        ORDER BY COALESCE(nombre_facturacion, empresa, nombre)
        LIMIT 15`,
      [tenant.auth.empresa_id, q]
    );

    return NextResponse.json(
      successResponse({
        clientes: rows.map((r) => ({
          id: r.id,
          // El nombre que va en la factura tiene prioridad sobre el comercial.
          razon_social: r.nombre_facturacion || r.empresa || r.nombre || "",
          ruc: r.ruc,
          documento: r.documento,
          email: r.email,
          es_contribuyente: r.es_contribuyente === true,
        })),
      })
    );
  } catch (err) {
    console.error("[/api/clientes/buscar]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo buscar clientes."), { status: 500 });
  }
}
