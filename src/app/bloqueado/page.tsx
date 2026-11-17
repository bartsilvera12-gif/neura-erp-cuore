import Image from "next/image";
import { redirect } from "next/navigation";
import { BLOQUEO_PAGO_MENSAJE, ERP_BLOQUEADO_POR_FALTA_DE_PAGO } from "@/lib/bloqueo-pago";

/** Aviso de acceso suspendido por falta de pago. El middleware manda acá todo el ERP. */
export default function BloqueadoPage() {
  // Ya desbloqueado: quien tenga esta pestaña abierta vuelve al login.
  if (!ERP_BLOQUEADO_POR_FALTA_DE_PAGO) redirect("/login");

  return (
    <div className="zentra-login-bg flex min-h-dvh w-full flex-col items-center justify-center px-4 py-5">
      <div className="flex w-full max-w-sm flex-col items-center gap-4">
        <div className="w-full max-w-[15rem]">
          <Image
            src="/brand/zentra-logo-official.png"
            alt="ZENTRA"
            width={480}
            height={264}
            priority
            className="h-auto w-full max-h-[4.75rem] object-contain object-center"
          />
        </div>

        <div className="w-full rounded-2xl border border-white/20 bg-white/[0.97] p-6 text-center shadow-[0_24px_48px_-12px_rgba(0,0,0,0.38)]">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600" aria-hidden>
            !
          </div>
          <h1 className="mb-2 text-lg font-semibold text-[#0F172A]">Acceso suspendido por falta de pago</h1>
          <p className="text-sm text-slate-600">{BLOQUEO_PAGO_MENSAJE}</p>
        </div>
      </div>
    </div>
  );
}
