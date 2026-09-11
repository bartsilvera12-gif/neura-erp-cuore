# Impresión térmica de comandas — Cucina del Cuore

Utilitario único para tickets/comandas térmicas 80mm (schema `cucinaerp`).
**No es comprobante fiscal** — no toca SIFEN, timbrado ni XML.

## Archivos

- `thermal-ticket.ts` — funciones puras de construcción de ticket:
  - `normalizeComandaData(input)` → normaliza datos crudos de venta/pedido.
  - `buildComandaTicketHtml(data, opts)` → `<section>` 80/58mm imprimible.
  - `wrapTicketDocument(secciones, opts)` → documento HTML completo con CSS `@page size: 80mm auto`.
  - `buildComandaTicketText(data, opts)` → texto plano monoespaciado.
  - `buildComandaEscPosPayload(data, opts)` → texto + comandos de corte ESC/POS.
  - `ESC_POS`, `escposCutCommand(partial)` → abstracción de bytes de corte.

## Endpoints (no fiscales)

`GET /api/ventas/[id]/ticket`

| Query                         | Resultado                                                        |
|-------------------------------|-----------------------------------------------------------------|
| *(sin params)*                | HTML 80mm, copia cliente.                                        |
| `?mode=comandas`              | HTML: copia cliente + comanda pizzería + comanda plancha.        |
| `?w=58` / `?w=80`             | Ancho del papel.                                                 |
| `?auto=1`                     | Auto-`window.print()` al cargar.                                 |
| `?format=text`               | Texto plano (QA / inspección, sin bytes de control).            |
| `?format=escpos` o `?escpos=1`| Payload ESC/POS con `INIT` + corte parcial (bytes de control).  |

El ancho/sector de comanda se calcula por categoría del producto (primary) o por
prefijo de SKU (fallback): pizzería = `PIZ-`/categorías pizzas·lompizzas;
plancha = `HAM-`/`LOM-`/`PAN-`/`PAP-`/`ESP-`/categorías hamburguesas·lomitos·etc.

## Conexión con impresora física autocortante (pendiente de definir hardware)

El HTML imprime bien desde Chrome (Ctrl+P → seleccionar la térmica, márgenes "Ninguno",
tamaño 80mm). Para **impresión directa con autocorte** sin diálogo, elegir UNA vía:

1. **QZ Tray** (recomendado, Windows + navegador): instalar QZ Tray en la PC de caja,
   incluir el cliente JS y enviar `buildComandaEscPosPayload(...)` como raw a la cola
   de impresión. QZ se encarga del puerto USB/red.
2. **Agente local HTTP**: pequeño servicio Node con `node-escpos` / `escpos-usb` en la
   PC de caja; el ERP hace `fetch('http://localhost:PUERTO/print', { body: payload })`
   con el resultado de `?format=escpos`.
3. **WebUSB** (Chrome): `navigator.usb.requestDevice(...)` + `transferOut` del payload.
   Requiere permiso del usuario por dispositivo; sin diálogo de impresión.

En los tres casos el payload ya viene listo: `?format=escpos` devuelve
`ESC @` (init) + texto monoespaciado + `GS V 1` (corte parcial / autocorte 80mm).
Si la impresora usa otro set de comandos, reemplazar **sólo** `escposCutCommand()`
y las constantes `ESC_POS` en `thermal-ticket.ts`.
