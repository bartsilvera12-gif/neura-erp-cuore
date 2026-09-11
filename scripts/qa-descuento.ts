/**
 * Prueba del reparto del descuento entre las líneas de la venta.
 *
 * Lo que importa no es que el descuento reste bien, sino que no rompa nada de
 * lo que viene después:
 *
 *   · la suma de las líneas tiene que dar EXACTAMENTE el total con descuento.
 *     Si sobrara un guaraní, la factura electrónica no cerraría y el SET la
 *     rechaza;
 *   · el IVA se recalcula sobre el precio con descuento, no queda el de antes;
 *   · base + IVA = total en cada línea, sin arrastre de redondeo;
 *   · ninguna línea queda con precio negativo.
 *
 * Se prueban a propósito montos que redondean feo: un descuento de 3.333 sobre
 * tres líneas no se divide en partes iguales, y ahí es donde aparecen los
 * errores de un guaraní.
 *
 *   npx tsx scripts/qa-descuento.ts
 *
 * No toca la base: es sólo cálculo.
 */
import { repartirDescuento, descuentoDesdePorcentaje } from "../src/lib/ventas/descuento";
import { calcularLineaVenta } from "../src/lib/ventas/iva";

type Linea = { precio_venta: number; cantidad: number; tipo_iva: "10%" };
type Caso = { nombre: string; lineas: Linea[]; descuento: number };

const CASOS: Caso[] = [
  {
    nombre: "descuento redondo",
    lineas: [
      { precio_venta: 25000, cantidad: 2, tipo_iva: "10%" },
      { precio_venta: 5000, cantidad: 1, tipo_iva: "10%" },
    ],
    descuento: 5000,
  },
  {
    nombre: "descuento que redondea feo",
    lineas: [
      { precio_venta: 12000, cantidad: 1, tipo_iva: "10%" },
      { precio_venta: 7500, cantidad: 3, tipo_iva: "10%" },
      { precio_venta: 999, cantidad: 1, tipo_iva: "10%" },
    ],
    descuento: 3333,
  },
  {
    nombre: "10% sobre un total impar",
    lineas: [
      { precio_venta: 33333, cantidad: 1, tipo_iva: "10%" },
      { precio_venta: 6667, cantidad: 2, tipo_iva: "10%" },
    ],
    descuento: 0, // se calcula como 10%
  },
  {
    nombre: "una sola línea",
    lineas: [{ precio_venta: 10000, cantidad: 1, tipo_iva: "10%" }],
    descuento: 1234,
  },
];

let fallos = 0;
const fallar = (m: string) => { fallos++; console.log("  FALLO: " + m); };

for (const caso of CASOS) {
  const totalOriginal = caso.lineas.reduce(
    (s, l) => s + calcularLineaVenta(l.precio_venta, l.cantidad, l.tipo_iva).total_linea,
    0
  );
  const desc = caso.descuento || descuentoDesdePorcentaje(totalOriginal, 10);
  const objetivo = totalOriginal - desc;

  let suma = 0;
  let sumaBase = 0;
  let sumaIva = 0;

  for (const { linea, precioFinal } of repartirDescuento(caso.lineas, desc)) {
    const d = calcularLineaVenta(precioFinal, linea.cantidad, linea.tipo_iva);
    if (precioFinal < 0) fallar("una línea quedó con precio negativo");
    if (d.subtotal + d.monto_iva !== d.total_linea) fallar("base + IVA no da el total de la línea");
    const ivaEsperado = d.total_linea - Math.round(d.total_linea / 1.1);
    if (d.monto_iva !== ivaEsperado) fallar("el IVA no se recalculó sobre el precio con descuento");
    suma += d.total_linea;
    sumaBase += d.subtotal;
    sumaIva += d.monto_iva;
  }

  const ok = suma === objetivo;
  console.log(
    `${caso.nombre}: ${totalOriginal} − ${desc} = ${suma} (esperado ${objetivo})${ok ? "" : "   ← MAL"}`
  );
  if (!ok) fallar(`la suma de las líneas no da el total con descuento`);
  if (sumaBase + sumaIva !== suma) fallar("base + IVA no da el total de la venta");
}

console.log(`\n${fallos === 0 ? "DESCUENTO OK" : `${fallos} FALLO(S)`}`);
process.exit(fallos === 0 ? 0 : 1);
