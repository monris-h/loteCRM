# LotesCRM

CRM sencillo para un lote de autos en México: inventario, clientes, prospectos, apartados y ventas.
Los datos de los vehículos (marca, modelo, año, versión, color, kilometraje, transmisión y precio) se
obtienen **haciendo scraping de sitios de agencias y concesionarias** y de **APIs públicas gratuitas**,
y desde ahí se agregan al inventario con un clic.

| Capa | Tecnología |
|---|---|
| Base de datos | PostgreSQL 18 (Docker) |
| Backend | Node.js 20+ · Express 5 · `pg` · cheerio (scraping) |
| Frontend | Vite 7 · React 19 |

## Arranque

```bash
docker compose up -d
```
```bash
cd backend && cp .env.example .env && npm install && npm run db:migrate && npm run db:seed
```
```bash
npm run dev
```
```bash
cd frontend && npm install && npm run dev
```

- API: http://localhost:4000 · App: http://localhost:5173
- `npm run db:seed` registra las fuentes de datos **y ejecuta la ingesta** (tarda unos minutos:
  el scraper hace pausas entre páginas). No crea datos ficticios.
- `npm run ingest` vuelve a correr las fuentes activas. `npm run db:reset` deja la BD vacía.

## De dónde salen los datos

| Fuente | Tipo | Qué aporta |
|---|---|---|
| **Concesionarias en seminuevos.com** (Guadalajara, Monterrey, Puebla, Querétaro) | Scraping | Precio, marca, modelo, año, km y ciudad del listado; color, versión, transmisión, combustible, tracción y puertas desde la ficha de cada auto |
| **Sitio de una agencia** (plantilla) | Scraping | Lee los datos estructurados `schema.org/Car` que publican muchos sitios de agencias, sin configurar selectores. Si el sitio no los tiene, se usa el modo de selectores CSS |
| **NHTSA vPIC** | API pública gratuita, sin llave | Catálogo de marcas y modelos; decodificador de VIN en el alta de vehículos (con VINs mexicanos puede devolver datos parciales) |

No hay una API pública y gratuita con precios de autos en México (Libro Azul y Autométrica son de
paga), por eso los precios salen del scraping. El scraper respeta `robots.txt` y su `Crawl-delay`,
hace pausas entre peticiones, se identifica con `SCRAPER_USER_AGENT` y se detiene si el sitio
responde 403/429. **Antes de usarlo fuera de clase, revisa los términos de uso de cada sitio.**

Para agregar otra agencia: *Autos de agencias → + Nueva fuente*, elige la plantilla y pon la URL de su
página de seminuevos (admite `{page}` para paginar).

### Flujo

1. *Autos de agencias* → **Ejecutar** una fuente.
2. Revisa la tabla de vehículos encontrados (precio, color, km, transmisión, agencia).
3. Selecciónalos → **Agregar al inventario**: se crean como "En tránsito" con todos sus datos y el
   precio del anuncio como precio de lista sugerido.
4. En el inventario ajustas el costo y el precio, y lo pones a la venta.

Los anuncios también sirven para **valuar** tu inventario: cada vehículo muestra su valor de mercado
(mediana de autos parecidos, ajustada por año y kilometraje).

## Base de datos

[db/migrations/001_schema.sql](db/migrations/001_schema.sql) y [002_inventory_logic.sql](db/migrations/002_inventory_logic.sql).

- **vehicles**: VIN, número de inventario, marca/modelo (catálogo), año, versión, color, km, transmisión,
  combustible, condición, estado, costo, precio de lista y precio mínimo. `attributes` (jsonb) guarda
  cualquier dato extra de otro sistema.
- **contacts**, **leads**, **activities**, **reservations** (apartados), **sales**, **sale_payments**.
- **market_listings**: autos encontrados por scraping/API; `vehicle_id` indica si ya se pasó al inventario.
- **partners**: socios conectados por API.
- **external_refs** e **import_batches**: para migrar desde otro sistema (CSV/JSON) sin duplicar.

## Lógica de inventario

```
En tránsito → En preparación → Disponible ⇄ En pausa
                                   │
                                   ├─→ Apartado ─→ Vendido ─→ Entregado
                                   └─────────────→ Vendido
```

- Los cambios de estado se validan en la base de datos (trigger), y cada cambio queda en la bitácora.
- Un auto sólo tiene **un apartado activo** y **una venta vigente** (índices únicos). Los apartados
  vencen solos.
- Vender por debajo del **precio mínimo** pide autorización.
- **Costo real** = compra + reacondicionamiento; la utilidad se calcula al vender.
- No se publica un auto sin precio de lista.

## Socios (otros sistemas)

Otro lote o agencia se conecta con una llave de API para:
- ver y **vender nuestros autos compartidos** (cobra la comisión pactada), y
- **publicar sus autos y sus ventas** aquí, para que nosotros también los vendamos.

Sus autos aparecen en el inventario marcados como "Socio" y su estado lo controla el socio. Si un
sistema ya vendió un auto, el otro recibe un error en lugar de venderlo dos veces. Guía para el
desarrollador del socio: [docs/API_SOCIOS.md](docs/API_SOCIOS.md).

## Conectar el endpoint de otro sistema

Si un socio (o una agencia) tiene su propia API, en *Conectar sistema externo*:

1. Pega la URL de su endpoint JSON (con `{page}` si pagina) y sus encabezados (p.ej. su llave).
2. **Probar conexión**: LotesCRM encuentra sola la lista de autos dentro de la respuesta, aunque venga
   anidada (`resultado.autos`), y sugiere qué campo suyo corresponde a cada uno de los nuestros: precio,
   marca, modelo, año, versión, color, km, transmisión, combustible, VIN, disponibilidad, fotos, ciudad.
   La detección usa nombres en español e inglés (`precio_venta`, `listPrice`, `marca.nombre`, `brand`…) y
   valida el tipo de valor (un año entre 1950 y 2100, un VIN de 17 caracteres, URLs de imágenes…).
3. Revisa la vista previa ya normalizada (`"$245,000.00"` → 245000, `"Automática"` → automática,
   `"White"` → Blanco) y cómo se traducen sus estados (`DISPONIBLE`, `VENDIDO`…) a los nuestros.
4. **Guardar e importar**: sus autos se empatan en la BD como inventario del socio (o como autos
   encontrados). La conexión queda guardada y se puede **sincronizar** cuando quieras; volver a
   sincronizar actualiza sin duplicar, y si marca un auto como vendido se refleja su venta.

Código: [backend/src/services/autoMap.js](backend/src/services/autoMap.js) (detección y mapeo) y
[backend/src/ingestion/providers/externalApi.js](backend/src/ingestion/providers/externalApi.js) (lectura y empate).

## Migrar desde otro sistema

*Migrar / importar*: sube un CSV o JSON, revisa el mapeo de columnas que se sugiere solo (entiende
nombres en español como "Marca", "Kilometraje", "Precio") y simula antes de importar.

> No hay inicio de sesión: el usuario que actúa se elige en la barra lateral. Es una práctica escolar.
