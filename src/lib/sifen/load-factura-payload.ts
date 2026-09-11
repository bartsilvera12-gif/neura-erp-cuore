import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  validateAndBuildSifenPayload,
  type BuildSifenPayloadInput,
} from "./build-payload";
import type { AmbienteSifen, SifenFacturaPayloadBase } from "./types";

export type LoadSifenPayloadFailure =
  | { status: 400; message: string }
  | { status: 404; message: string };

export type LoadSifenPayloadResult =
  | { ok: true; payload: SifenFacturaPayloadBase; ambiente: AmbienteSifen }
  | { ok: false; error: LoadSifenPayloadFailure };

function ambienteDesdeConfigRow(raw: unknown): AmbienteSifen {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "produccion" ? "produccion" : "test";
}

/**
 * Carga factura, ítems, cliente, config SIFEN y borrador electrónico;
 * valida y devuelve el payload base ERP (sin eventos de auditoría).
 */
export async function loadValidatedSifenPayload(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaId: string
): Promise<LoadSifenPayloadResult> {
  const fid = facturaId.trim();

  const { data: factura, error: errFactura } = await supabase
    .from("facturas")
    .select("id, cliente_id, numero_factura, fecha, tipo, moneda, monto, saldo, cliente_razon_social, cliente_ruc, cliente_documento, cliente_email")
    .eq("id", fid)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (errFactura) {
    return { ok: false, error: { status: 400, message: errFactura.message } };
  }
  if (!factura) {
    return { ok: false, error: { status: 404, message: "Factura no encontrada" } };
  }

  const clienteId = (factura.cliente_id as string | null) ?? null;

  const [itemsRes, clienteRes, configRes, electronicaRes] = await Promise.all([
    supabase
      .from("factura_items")
      .select("descripcion, cantidad, precio_unitario, subtotal, iva, total")
      .eq("factura_id", fid)
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: true }),
    // Solo consultamos clientes si la factura tiene cliente_id real. Cuando la
    // factura viene del puente venta→factura sin cliente (venta a consumidor final),
    // usamos las columnas denormalizadas (cliente_razon_social + cliente_ruc)
    // para armar un receptor mínimo para SIFEN.
    clienteId
      ? supabase
          .from("clientes")
          .select(
            "id, empresa, nombre_contacto, nombre, nombre_facturacion, ruc, documento, tipo_cliente, es_contribuyente, direccion, telefono, email, pais, sifen_receptor_extranjero, sifen_codigo_pais, sifen_tipo_doc_receptor, sifen_receptor_manual, sifen_receptor_naturaleza, sifen_ti_ope, sifen_num_id_de, sifen_direccion_de, sifen_num_casa_de, sifen_descripcion_tipo_doc"
          )
          .eq("id", clienteId)
          .eq("empresa_id", empresaId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as { data: null; error: null }),
    supabase
      .from("empresa_sifen_config")
      .select(
        "ruc, razon_social, direccion_fiscal, timbrado_numero, timbrado_fecha_inicio_vigencia, actividad_economica_codigo, actividad_economica_descripcion, establecimiento, punto_expedicion, csc, activo, ambiente, emisor_telefono, emisor_email"
      )
      .eq("empresa_id", empresaId)
      .maybeSingle(),
    supabase
      .from("factura_electronica")
      .select("id, estado_sifen, sifen_regeneracion_seq")
      .eq("factura_id", fid)
      .eq("empresa_id", empresaId)
      .maybeSingle(),
  ]);

  if (itemsRes.error) {
    return { ok: false, error: { status: 400, message: itemsRes.error.message } };
  }
  if (clienteRes.error) {
    return { ok: false, error: { status: 400, message: clienteRes.error.message } };
  }
  if (configRes.error) {
    return { ok: false, error: { status: 400, message: configRes.error.message } };
  }
  if (electronicaRes.error) {
    return { ok: false, error: { status: 400, message: electronicaRes.error.message } };
  }

  // Establecimiento y punto de expedición vienen de la configuración de la
  // empresa. En la instancia de referencia se resolvían por sucursal; acá hay
  // un solo local y un solo punto.
  const configRow = configRes.data as Record<string, unknown> | null;
  const configConSucursal = configRow;

  // Si no hay clientes.id, armamos un receptor mínimo a partir de los campos
  // denormalizados de la factura (cliente_razon_social + cliente_ruc). Esto
  // habilita el flujo SIFEN para ventas a "consumidor final" con datos manuales.
  let clienteInput: BuildSifenPayloadInput["cliente"];
  if (clienteRes.data) {
    clienteInput = clienteRes.data as BuildSifenPayloadInput["cliente"];
  } else {
    const razon = typeof factura.cliente_razon_social === "string" ? factura.cliente_razon_social.trim() : "";
    const rucSnap = typeof factura.cliente_ruc === "string" ? factura.cliente_ruc.trim() : "";
    const docSnap = typeof factura.cliente_documento === "string" ? factura.cliente_documento.trim() : "";
    if (razon || rucSnap || docSnap) {
      clienteInput = {
        id: "",
        empresa: rucSnap ? razon || null : null,
        nombre_contacto: null,
        nombre: razon || null,
        ruc: rucSnap || null,
        documento: docSnap || null,
        direccion: null,
        telefono: null,
        email:
          typeof factura.cliente_email === "string" && factura.cliente_email.trim()
            ? factura.cliente_email.trim()
            : null,
        pais: null,
        // Con RUC el receptor va como contribuyente (B2B); con cédula, como
        // consumidor final identificado (B2C). El armador rechaza un RUC que no
        // venga marcado, para no gastar un envío que la SET devolvería.
        es_contribuyente: rucSnap ? true : false,
      };
    } else {
      clienteInput = null;
    }
  }

  const buildInput: BuildSifenPayloadInput = {
    factura: {
      id: factura.id as string,
      cliente_id: (factura.cliente_id as string | null) ?? "",
      numero_factura: factura.numero_factura as string,
      fecha: factura.fecha as string,
      tipo: factura.tipo as string,
      moneda: factura.moneda as string,
      monto: factura.monto,
      saldo: factura.saldo,
    },
    items: (itemsRes.data ?? []) as BuildSifenPayloadInput["items"],
    cliente: clienteInput,
    config: configConSucursal as BuildSifenPayloadInput["config"],
    facturaElectronica: electronicaRes.data as BuildSifenPayloadInput["facturaElectronica"],
  };

  const built = validateAndBuildSifenPayload(buildInput);
  if (!built.ok) {
    return { ok: false, error: { status: 400, message: built.error } };
  }

  return {
    ok: true,
    payload: built.payload,
    ambiente: ambienteDesdeConfigRow(configRes.data?.ambiente),
  };
}
