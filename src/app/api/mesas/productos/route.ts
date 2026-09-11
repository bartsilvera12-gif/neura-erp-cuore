import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { signProductoImagen } from "@/lib/inventario/imagen-storage";
import { successResponse, errorResponse } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** Escapa %/_ del término para que no se interpreten en ILIKE. */
function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

interface ProductoMesa {
  id: string;
  nombre: string;
  sku: string;
  precio_venta: number;
  categoria: string | null;
  imagen_url: string | null;
  controla_stock: boolean;
  /** Solo si controla_stock (reventa). Para menú/elaborado es null. */
  stock_actual: number | null;
  tipo_visual: "reventa" | "menu";
  sector_produccion: string;
}

/**
 * GET /api/mesas/productos?search=&categoria_id=&tipo=todos|reventa|menu&limit=
 *
 * Catálogo de productos pedibles en mesa: vendibles + activos, SIN insumos /
 * materia prima. Fuente propia del módulo Mesas (no depende de filtros de
 * inventario). Devuelve TODOS los candidatos (no se corta en 100) y datos frescos.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const sb = createServiceRoleClientWithDbSchema(schema);

    const url = new URL(request.url);
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
    const categoriaId = url.searchParams.get("categoria_id");
    const tipo = url.searchParams.get("tipo"); // todos | reventa | menu
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "500", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 500;

    let q = sb
      .from("productos")
      .select("id, nombre, sku, precio_venta, stock_actual, controla_stock, imagen_path, imagen_url, categoria_principal_id, sector_produccion")
      .eq("empresa_id", auth.empresa_id)
      .eq("activo", true)
      .eq("es_vendible", true)
      .eq("es_insumo", false);

    if (search.length > 0) {
      const pat = `%${escapeIlike(search)}%`;
      q = q.or(`nombre.ilike.${pat},sku.ilike.${pat}`);
    }
    if (categoriaId) q = q.eq("categoria_principal_id", categoriaId);
    if (tipo === "reventa") q = q.eq("controla_stock", true);
    else if (tipo === "menu") q = q.eq("controla_stock", false);

    q = q.order("nombre", { ascending: true }).limit(limit);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    type Row = Record<string, unknown>;
    const rows = (data ?? []) as unknown as Row[];

    // Resolver nombre de categoría (categorias_productos) en un solo query.
    const catIds = [...new Set(rows.map((r) => r.categoria_principal_id).filter(Boolean) as string[])];
    const catById = new Map<string, string>();
    if (catIds.length > 0) {
      const cQ = await sb.from("categorias_productos").select("id, nombre").in("id", catIds);
      if (!cQ.error) {
        for (const c of (cQ.data ?? []) as Array<{ id: string; nombre: string | null }>) {
          if (c.nombre) catById.set(c.id, c.nombre);
        }
      }
    }

    // Firmar imágenes de los primeros N (optimización; el resto usa imagen_url cruda).
    const SIGN_TOP = 40;
    const signed = await Promise.all(
      rows.slice(0, SIGN_TOP).map((r) =>
        r.imagen_path ? signProductoImagen(sb, r.imagen_path as string, 3600) : Promise.resolve(null)
      )
    );

    const items: ProductoMesa[] = rows.map((r, i) => {
      const ctrl = r.controla_stock !== false;
      const catId = (r.categoria_principal_id as string | null) ?? null;
      return {
        id: String(r.id),
        nombre: String(r.nombre ?? ""),
        sku: String(r.sku ?? ""),
        precio_venta: Number(r.precio_venta ?? 0),
        categoria: catId ? catById.get(catId) ?? null : null,
        imagen_url: (i < SIGN_TOP ? signed[i] : null) ?? (r.imagen_url as string | null) ?? null,
        controla_stock: ctrl,
        stock_actual: ctrl ? Number(r.stock_actual ?? 0) : null,
        tipo_visual: ctrl ? "reventa" : "menu",
        sector_produccion: String(r.sector_produccion ?? "ninguno"),
      };
    });

    return NextResponse.json(successResponse({ items, count: items.length }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudieron cargar los productos.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
