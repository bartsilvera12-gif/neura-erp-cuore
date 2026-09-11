/**
 * Verifica que el receptor armado en el mostrador — sin ficha de cliente —
 * pase el armador del payload SIFEN en los tres casos que ofrece la caja.
 *
 * Importa porque el armador rechaza un receptor con RUC que no venga marcado
 * como contribuyente (la SET devuelve 0301 [1264] y se pierde el envío). El
 * receptor mínimo no marcaba nada, así que una factura con RUC tipeado en la
 * caja se frenaba antes de salir.
 *
 * No toca la base: llama al armador con datos armados a mano.
 */
import { validateAndBuildSifenPayload } from "@/lib/sifen/build-payload";

const CONFIG = {
  ruc: "80012345-6",
  razon_social: "LA CARIBENA SA",
  direccion_fiscal: "Avda. Siempre Viva 123",
  timbrado_numero: "12345678",
  timbrado_fecha_inicio_vigencia: "2026-01-01",
  actividad_economica_codigo: "56100",
  actividad_economica_descripcion: "Restaurantes",
  establecimiento: "001",
  punto_expedicion: "001",
  csc: "ABCD1234",
  activo: true,
  ambiente: "test",
  emisor_telefono: "021 000 000",
  emisor_email: "facturacion@cucinadelcoure.com.py",
} as unknown as Parameters<typeof validateAndBuildSifenPayload>[0]["config"];

const ITEMS = [
  {
    descripcion: "PIZZA MARGARITA 8 PORCIONES",
    cantidad: 1,
    precio_unitario: 55000,
    subtotal: 50000,
    iva: 5000,
    total: 55000,
    tipo_iva: "10%",
  },
] as unknown as Parameters<typeof validateAndBuildSifenPayload>[0]["items"];

const FACTURA = {
  id: "00000000-0000-0000-0000-000000000001",
  cliente_id: "",
  numero_factura: "FAC-000001",
  fecha: "2026-08-27",
  tipo: "contado",
  moneda: "GS",
  monto: 55000,
  saldo: 0,
} as unknown as Parameters<typeof validateAndBuildSifenPayload>[0]["factura"];

/** Igual que el receptor mínimo que arma load-factura-payload. */
function receptorMostrador(opts: {
  razon: string;
  ruc: string;
  documento: string;
}) {
  const { razon, ruc, documento } = opts;
  if (!razon && !ruc && !documento) return null;
  return {
    id: "",
    empresa: ruc ? razon || null : null,
    nombre_contacto: null,
    nombre: razon || null,
    ruc: ruc || null,
    documento: documento || null,
    direccion: null,
    telefono: null,
    email: null,
    pais: null,
    es_contribuyente: ruc ? true : false,
  } as unknown as Parameters<typeof validateAndBuildSifenPayload>[0]["cliente"];
}

const CASOS = [
  {
    nombre: "Con RUC (contribuyente)",
    receptor: receptorMostrador({ razon: "PANADERIA SAN JUAN SRL", ruc: "80012345-6", documento: "" }),
  },
];

// La caja factura siempre a un RUC: es la regla del local. Sin RUC se cobra con
// ticket, así que no hay caso de cédula ni de receptor sin datos que probar.

let fallos = 0;
for (const caso of CASOS) {
  const out = validateAndBuildSifenPayload({
    factura: FACTURA,
    items: ITEMS,
    cliente: caso.receptor,
    config: CONFIG,
    // El armador exige que ya exista el borrador electrónico: se simula uno.
    facturaElectronica: {
      id: "00000000-0000-0000-0000-000000000009",
      estado_sifen: "borrador",
      sifen_regeneracion_seq: 0,
    } as unknown as Parameters<typeof validateAndBuildSifenPayload>[0]["facturaElectronica"],
  });
  if (!out.ok) {
    fallos++;
    console.log(`FALLO — ${caso.nombre}: ${out.error}`);
    continue;
  }
  const r = out.payload.receptor as Record<string, unknown>;
  console.log(
    `OK    — ${caso.nombre}: contribuyente=${r.es_contribuyente_py} ruc=${r.ruc ?? "—"} doc=${r.documento ?? "—"} nombre=${r.nombre ?? "—"}`
  );
}

console.log(fallos === 0 ? "\nEL RECEPTOR DEL MOSTRADOR ARMA OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
