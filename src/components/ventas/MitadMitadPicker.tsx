"use client";

import BuscadorLista, { coincideBusqueda } from "@/components/ui/BuscadorLista";
import { AlertTriangle, Pizza, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  etiquetaPorciones,
  nombreMitadMitad,
  porcionesDeNombre,
  saborCorto,
} from "@/lib/ventas/pizza-porciones";

interface PizzaItem {
  id: string;
  nombre: string;
  sku: string;
  precio_venta: number;
}

/** Resultado normalizado de una pizza mitad y mitad (precio = max de ambos sabores). */
export interface MitadMitadResult {
  producto_id: string;   // sabor más caro (define sector + precio)
  sku: string;
  display_name: string;  // "Pizza mitad y mitad 12 porciones"
  precio_unitario: number;
  mitad: { producto1_id: string; producto2_id: string; nombre1: string; nombre2: string };
}

function formatGs(v: number) { return `Gs. ${Math.round(v).toLocaleString("es-PY")}`; }

/**
 * Modal para armar una pizza MITAD y MITAD: dos sabores de pizzería; el precio
 * final es el del sabor MÁS CARO (max, nunca promedio ni suma).
 *
 * Las dos mitades tienen que ser de la MISMA medida. No es una regla de
 * negocio caprichosa: media pizza de 12 porciones no entra en una de 8, no hay
 * forma de armarla, y si se cargaba igual la cocina recibía un pedido
 * imposible y el precio salía del sabor más caro, que podía ser el chico.
 */
export default function MitadMitadPicker({
  open, onClose, onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (r: MitadMitadResult) => void;
}) {
  const [pizzas, setPizzas] = useState<PizzaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [s1, setS1] = useState("");
  const [s2, setS2] = useState("");
  const [busqueda, setBusqueda] = useState("");

  useEffect(() => {
    if (!open) return;
    setS1(""); setS2(""); setBusqueda(""); setError(null); setLoading(true);
    fetch("/api/productos/search?sector=pizzeria&limit=100", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success) {
          const items = (j.data?.items ?? []) as PizzaItem[];
          setPizzas(items.slice().sort((a, b) => a.nombre.localeCompare(b.nombre)));
        } else setError(j?.error ?? "No se pudieron cargar las pizzas.");
      })
      .catch(() => setError("Error de red al cargar pizzas."))
      .finally(() => setLoading(false));
  }, [open]);

  // Solo entran los productos que declaran medida en el nombre. El sector
  // pizzería también tiene bordes y cajas: no son sabores y no se pueden partir
  // por la mitad.
  const sabores = useMemo(
    () => pizzas.filter((p) => porcionesDeNombre(p.nombre) != null),
    [pizzas]
  );
  const descartados = pizzas.length - sabores.length;

  const p1 = useMemo(() => sabores.find((p) => p.id === s1) ?? null, [sabores, s1]);
  const p2 = useMemo(() => sabores.find((p) => p.id === s2) ?? null, [sabores, s2]);

  // La medida elegida: la fija la primera mitad que se haya seleccionado.
  const medida = porcionesDeNombre(p1?.nombre) ?? porcionesDeNombre(p2?.nombre);

  const visibles = useMemo(
    () => sabores.filter((p) => coincideBusqueda(busqueda, p.nombre, p.sku)),
    [sabores, busqueda]
  );

  const precio = Math.max(p1?.precio_venta ?? 0, p2?.precio_venta ?? 0);
  const mismaMedida =
    !p1 || !p2 || porcionesDeNombre(p1.nombre) === porcionesDeNombre(p2.nombre);
  const valido = !!p1 && !!p2 && mismaMedida;

  function elegir(lado: 1 | 2, p: PizzaItem) {
    const n = porcionesDeNombre(p.nombre);
    if (lado === 1) {
      setS1(p.id);
      // Si la otra mitad quedaba de otra medida, se suelta: es preferible que
      // el cajero vuelva a elegirla a dejar una combinación imposible armada.
      if (p2 && porcionesDeNombre(p2.nombre) !== n) setS2("");
    } else {
      setS2(p.id);
      if (p1 && porcionesDeNombre(p1.nombre) !== n) setS1("");
    }
  }

  function confirmar() {
    if (!valido || !p1 || !p2) return;
    const caro = (p1.precio_venta >= p2.precio_venta) ? p1 : p2;
    onConfirm({
      producto_id: caro.id,
      sku: caro.sku,
      // La medida va dentro del nombre para que llegue sola a la comanda, al
      // ticket y a la factura.
      display_name: nombreMitadMitad(porcionesDeNombre(p1.nombre)),
      precio_unitario: precio,
      mitad: { producto1_id: p1.id, producto2_id: p2.id, nombre1: p1.nombre, nombre2: p2.nombre },
    });
  }

  /** Lista de sabores de una mitad, con las otras medidas bloqueadas. */
  function ListaSabores({ lado, seleccionado }: { lado: 1 | 2; seleccionado: string }) {
    const otra = lado === 1 ? p2 : p1;
    const medidaFijada = porcionesDeNombre(otra?.nombre);
    return (
      <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
        {visibles.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-slate-400">Ningún sabor coincide.</p>
        ) : (
          visibles.map((p) => {
            const n = porcionesDeNombre(p.nombre);
            const bloqueado = medidaFijada != null && n !== medidaFijada;
            const activo = seleccionado === p.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={bloqueado}
                onClick={() => elegir(lado, p)}
                title={bloqueado ? `Las dos mitades tienen que ser de ${etiquetaPorciones(medidaFijada)}.` : undefined}
                className={`flex w-full items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 ${
                  activo
                    ? "bg-emerald-50 font-semibold text-emerald-800"
                    : bloqueado
                      ? "cursor-not-allowed bg-slate-50 text-slate-300"
                      : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span>
                  {saborCorto(p.nombre)}
                  <span className={`ml-1.5 text-[11px] ${bloqueado ? "text-slate-300" : "text-slate-400"}`}>
                    {etiquetaPorciones(n)}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-xs text-slate-500">{formatGs(p.precio_venta)}</span>
              </button>
            );
          })
        )}
      </div>
    );
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center bg-slate-900/60 px-3 pt-12 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <h3 className="text-base font-semibold text-slate-800"><Pizza className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> Pizza mitad y mitad</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="inline h-4 w-4 align-[-0.125em]" aria-hidden /></button>
        </div>
        <div className="space-y-3 p-4">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}</div>}
          {loading ? (
            <p className="py-6 text-center text-sm text-slate-400">Cargando pizzas…</p>
          ) : (
            <>
              {/* Solo entran los productos del sector pizzería. Sin este aviso,
                  una pizza cargada con sector "ninguno" simplemente no aparece y
                  no hay forma de saber por qué. */}
              {sabores.length < 2 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {sabores.length === 0
                    ? "No hay pizzas con medida cargadas en el sector Pizzería."
                    : "Solo hay una pizza con medida en el sector Pizzería, y hacen falta dos sabores."}{" "}
                  Acá aparecen los productos con sector de producción <strong>Pizzería</strong> cuyo nombre
                  diga las porciones (ej: <em>PIZZA HAWAIANA 8 PORCIONES</em>). Se cambia desde
                  Inventario → Menú.
                </div>
              )}

              <BuscadorLista
                valor={busqueda}
                onChange={setBusqueda}
                placeholder="Buscar sabor…"
                mostrando={visibles.length}
                total={sabores.length}
              />

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Mitad 1 — sabor {p1 && <span className="text-emerald-700">· {saborCorto(p1.nombre)}</span>}
                  </label>
                  <ListaSabores lado={1} seleccionado={s1} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    Mitad 2 — sabor {p2 && <span className="text-emerald-700">· {saborCorto(p2.nombre)}</span>}
                  </label>
                  <ListaSabores lado={2} seleccionado={s2} />
                </div>
              </div>

              {medida != null && (
                <p className="text-xs text-slate-500">
                  Medida: <strong className="text-slate-700">{etiquetaPorciones(medida)}</strong>. Las dos
                  mitades tienen que ser de la misma medida.
                </p>
              )}

              {descartados > 0 && (
                <p className="text-[11px] text-slate-400">
                  {descartados} producto(s) del sector Pizzería quedaron afuera porque el nombre no dice
                  las porciones (bordes, cajas y demás).
                </p>
              )}

              {valido && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                  <p className="font-semibold text-slate-800">{nombreMitadMitad(porcionesDeNombre(p1!.nombre))}</p>
                  <p className="text-xs text-slate-600">½ {saborCorto(p1!.nombre)} + ½ {saborCorto(p2!.nombre)}</p>
                  <p className="mt-1 text-xs text-slate-500">Precio = sabor más caro</p>
                  <p className="text-lg font-extrabold tabular-nums text-slate-900">{formatGs(precio)}</p>
                </div>
              )}

              <button
                type="button"
                onClick={confirmar}
                disabled={!valido}
                className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                {!p1 || !p2 ? "Elegí los dos sabores" : "Agregar pizza mitad y mitad"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
