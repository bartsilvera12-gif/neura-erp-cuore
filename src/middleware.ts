import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/response";
import {
  BLOQUEO_PAGO_MENSAJE,
  BLOQUEO_PAGO_PATH,
  erpBloqueadoPorFaltaDePago,
} from "@/lib/bloqueo-pago";

/**
 * Refresca la sesión Supabase en cookies antes de Route Handlers / RSC.
 * Solo NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY (sin db.schema en getUser).
 */
export async function middleware(request: NextRequest) {
  // ===== ERP bloqueado por falta de pago (ver src/lib/bloqueo-pago.ts) =====
  if (await erpBloqueadoPorFaltaDePago(request.headers)) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(errorResponse(BLOQUEO_PAGO_MENSAJE), { status: 402 });
    }
    if (request.nextUrl.pathname !== BLOQUEO_PAGO_PATH) {
      const bloqueoUrl = request.nextUrl.clone();
      bloqueoUrl.pathname = BLOQUEO_PAGO_PATH;
      bloqueoUrl.search = "";
      return NextResponse.redirect(bloqueoUrl, 307);
    }
    return NextResponse.next({ request });
  }
  if (request.nextUrl.pathname === BLOQUEO_PAGO_PATH) {
    // Ya desbloqueado: quien tenga el aviso abierto vuelve al login.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl, 307);
  }

  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return supabaseResponse;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  await supabase.auth.getUser();

  return supabaseResponse;
}

/**
 * Excluir `/api/webhooks/*`: Meta hace GET sin cookies para verificar el webhook;
 * no debe pasar por refresh de sesión Supabase (y queda listo para proxies estrictos).
 */
export const config = {
  matcher: [
    "/((?!api/webhooks|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
