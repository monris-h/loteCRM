# API para socios · LotesCRM

Permite que otro lote o agencia (un "socio"):

1. **Vea y venda nuestros autos** (cobra la comisión pactada).
2. **Publique sus autos y sus ventas** en LotesCRM, para que nosotros también podamos venderlos.

```
Base:          http://<servidor>:4000/partner/v1
Autenticación: Authorization: Bearer lcrm_xxxxxxxxxx.yyyyyyyyyyyy
Formato:       JSON · precios en pesos mexicanos (MXN)
```

La llave se genera en **Socios** dentro de LotesCRM y sólo se muestra una vez.
Errores: `{ "error": "mensaje", "code": "codigo" }`.

| code | Significado |
|---|---|
| `unauthorized` | Llave inválida |
| `forbidden` | El socio no tiene ese permiso |
| `not_found` | No existe o no está compartido |
| `not_available` | El auto ya no está disponible |
| `held_by_other` | Está apartado para otro cliente |
| `below_minimum` | Precio por debajo del mínimo autorizado |
| `sold_by_lotescrm` | Nosotros ya vendimos tu auto: no lo publiques como disponible |
| `validation_error` | Datos inválidos |

## Endpoints

### `GET /me`
Datos del socio, comisión y permisos.

### `GET /inventory`
Nuestros autos compartidos (`available` y `reserved`). Con `?updated_since=2026-10-01T00:00:00Z`
devuelve todo lo que cambió desde esa fecha, incluidos los ya vendidos, para sincronizar.

```json
{ "data": [{
  "id": "8c050e3e-…", "stock_number": "STK-1000", "make": "Toyota", "model": "Corolla", "year": 2021,
  "trim": "LE", "exterior_color": "Blanco", "odometer": 40000, "transmission": "automatic",
  "fuel_type": "gasoline", "list_price": 300000, "availability": "available",
  "location_city": "Guadalajara", "location_state": "Jalisco", "photos": [] }] }
```
Nunca se exponen costos ni el precio mínimo.

### `POST /sales` · registrar una venta
Vender un auto **nuestro**:
```json
{ "vehicle_id": "8c050e3e-…", "sale_price": 295000, "reference": "TU-VENTA-1", "buyer_name": "Luis Pérez" }
```
Reportar la venta de un auto **tuyo** (publicado antes con `PUT /vehicles`):
```json
{ "vehicle_external_id": "A1", "sale_price": 205000, "reference": "TU-VENTA-2" }
```
`reference` es tu ID de venta: reenviar la misma referencia no duplica la venta.

### `GET /sales`
Tus ventas y las que nosotros hicimos de tus autos (`sale_type`: `partner_sold_ours`,
`we_sold_partner`, `partner_own`).

### `PUT /vehicles/{tu_id}` · publicar o actualizar un auto tuyo
Sólo manda lo que cambia:
```json
{ "make": "Mazda", "model": "CX-5", "year": 2022, "version": "i Grand Touring",
  "price": 420000, "odometer": 35000, "color": "Rojo", "transmission": "Automática",
  "fuel_type": "Gasolina", "availability": "available", "photos": ["https://…/cx5.jpg"] }
```
`availability`: `available`, `reserved`, `sold` o `unavailable`. Marcarlo `sold` registra tu venta
(opcional: `sold_price`, `buyer_name`). Los textos en español se normalizan solos.

### `DELETE /vehicles/{tu_id}`
Retira tu auto.

## Ejemplo con curl
```bash
curl http://localhost:4000/partner/v1/inventory -H "Authorization: Bearer lcrm_xxxx.yyyy"
```
```bash
curl -X PUT http://localhost:4000/partner/v1/vehicles/A1 -H "Authorization: Bearer lcrm_xxxx.yyyy" -H "Content-Type: application/json" -d "{\"make\":\"Kia\",\"model\":\"Rio\",\"year\":2021,\"price\":210000,\"color\":\"Gris\"}"
```

## Reglas
- Un auto apartado sólo lo puede comprar el cliente que lo apartó.
- Cada venta bloquea el auto: si dos sistemas lo venden al mismo tiempo, uno recibe `409`.
- Para mantenerte al día, consulta `GET /inventory?updated_since=…` periódicamente (por ejemplo, cada 10 minutos).
