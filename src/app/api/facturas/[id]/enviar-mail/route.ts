import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { errorResponse, successResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { enviarFacturaMail } from "@/lib/facturacion/server/enviar-factura-mail";
import { mailConfigurado } from "@/lib/mail/enviar-mail";

/**
 * GET /api/facturas/[id]/enviar-mail
 * Estado del envío: si el correo está configurado, a qué dirección se mandaría
 * y qué pasó con los intentos anteriores. Lo usa el panel para decidir si
 * ofrece el botón y qué texto muestra.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getFacturasSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const { id } = await params;
    const fid = (id ?? "").trim();
    if (!fid) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    const { data: fac } = await supabase
      .from("facturas")
      .select("cliente_email, cliente_id")
      .eq("id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();
    if (!fac) {
      return NextResponse.json(errorResponse("Factura no encontrada."), { status: 404 });
    }

    const row = fac as { cliente_email: string | null; cliente_id: string | null };
    let destinatario = (row.cliente_email ?? "").trim();
    if (!destinatario && row.cliente_id) {
      const { data: cli } = await supabase
        .from("clientes")
        .select("email")
        .eq("id", row.cliente_id)
        .eq("empresa_id", auth.empresa_id)
        .maybeSingle();
      destinatario = ((cli as { email?: string | null } | null)?.email ?? "").trim();
    }

    const { data: envios } = await supabase
      .from("factura_email_envios")
      .select("destinatario, origen, ok, error, created_at")
      .eq("factura_id", fid)
      .eq("empresa_id", auth.empresa_id)
      .order("created_at", { ascending: false })
      .limit(5);

    return NextResponse.json(
      successResponse({
        configurado: mailConfigurado(),
        destinatario: destinatario || null,
        envios: envios ?? [],
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/**
 * POST /api/facturas/[id]/enviar-mail
 * Manda (o reenvía) la factura al cliente. Body opcional: `{ email }` para
 * mandarla a otra dirección sin tocar la ficha del cliente — el caso típico es
 * que el correo se haya tipeado mal al cobrar.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getFacturasSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const { id } = await params;
    const fid = (id ?? "").trim();
    if (!fid) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    let email: string | null = null;
    try {
      const body = (await request.json()) as { email?: unknown } | null;
      const v = body?.email;
      if (typeof v === "string" && v.trim() !== "") email = v.trim();
    } catch {
      /* sin body: se usa el correo que ya tiene la factura */
    }

    const res = await enviarFacturaMail({
      supabase,
      empresaId: auth.empresa_id,
      facturaId: fid,
      origen: "manual",
      destinatarioOverride: email,
      enviadoPor: auth.usuarioCatalogId ?? auth.user.id,
    });

    if (!res.ok) {
      // 409 y no 500: el envío no se pudo hacer por el estado de la factura o
      // por falta de datos, no por una falla del servidor.
      const status = res.codigo === "error" ? 500 : 409;
      return NextResponse.json(errorResponse(res.message), { status });
    }

    return NextResponse.json(
      successResponse({ destinatario: res.destinatario, message: res.message })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
