import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLookups } from '../App.jsx';
import { api } from '../api.js';
import ContactPicker from '../components/ContactPicker.jsx';
import VehicleForm from '../components/VehicleForm.jsx';
import {
  Empty, ErrorBox, Field, Loading, Modal, Select, StatusBadge, useAction, useAsync, useForm,
} from '../components/ui.jsx';
import {
  BODY_TYPE, CONDITION, COST_CATEGORY, DRIVETRAIN, FUEL, LEAD_STATUS, PAYMENT_METHOD, SALE_STATUS, SALE_TYPE, TRANSMISSION,
  VEHICLE_STATUS, date, dateTime, km, money, num,
} from '../format.js';

// Etiqueta del botón para cada transición manual
const ACTION_LABEL = {
  reconditioning: 'Enviar a preparación', available: 'Poner a la venta', on_hold: 'Pausar',
  archived: 'Dar de baja', incoming: 'Marcar en tránsito',
};

export default function VehicleDetail() {
  const { id } = useParams();
  const { lots } = useLookups();
  const { data: v, loading, error, reload } = useAsync(() => api.get(`/vehicles/${id}`), [id]);
  const [tab, setTab] = useState('ficha');
  const [modal, setModal] = useState(null);
  const [run, busy] = useAction();

  if (loading && !v) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const cur = v.currency;
  const changeStatus = (status) => run(() => api.post(`/vehicles/${id}/status`, { status }), `Estado: ${VEHICLE_STATUS[status]}`).then((ok) => ok && reload());

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link to="/inventario">Inventario</Link> / <span className="mono">{v.stock_number}</span></div>
          <h1 style={{ marginTop: 6 }}>{v.make} {v.model} {v.year} <span className="muted" style={{ fontWeight: 500 }}>{v.trim}</span></h1>
          <div className="row" style={{ marginTop: 8 }}>
            <StatusBadge status={v.status} />
            {v.is_own
              ? <span className="muted">{v.lot_name ? `${v.lot_code} · ${v.lot_name}` : 'Sin lote'}</span>
              : <span className="badge plain info">Socio · {v.owner_partner_name}</span>}
            <span className="muted">· {v.days_in_stock} días en inventario</span>
          </div>
        </div>
        <div className="row">
          {v.allowed_transitions.map((s) => (
            <button key={s} className={s === 'archived' ? 'btn-danger' : ''} disabled={busy} onClick={() => changeStatus(s)}>
              {ACTION_LABEL[s] ?? VEHICLE_STATUS[s]}
            </button>
          ))}
          {v.status === 'available' && <button onClick={() => setModal('reserve')}>Apartar</button>}
          {['available', 'reserved'].includes(v.status) && <button className="btn-primary" onClick={() => setModal('sell')}>Registrar venta</button>}
        </div>
      </div>

      {!v.is_own && (
        <div className="alert info" style={{ marginBottom: 16 }}>
          Vehículo de <b>{v.owner_partner_name}</b>{v.partner_external_id && <> (su ID: <span className="mono">{v.partner_external_id}</span>)</>}.
          {' '}Sus datos y su estado los controla el socio desde su sistema; aquí puedes apartarlo y venderlo a comisión.
          {v.status === 'reserved' && !v.reservation && <> <b>Está apartado en el sistema del socio.</b></>}
        </div>
      )}
      {v.reservation && (
        <div className="alert warn" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span>Apartado para <b>{v.reservation.contact_name}</b> con anticipo de {money(v.reservation.deposit_amount, cur)} · vence {dateTime(v.reservation.expires_at)}</span>
          <button className="btn-sm" onClick={() => run(() => api.post(`/reservations/${v.reservation.id}/cancel`, { reason: 'Cancelado desde ficha' }), 'Apartado cancelado').then((ok) => ok && reload())}>
            Cancelar apartado
          </button>
        </div>
      )}
      {v.sale && (
        <div className="alert info" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span>
            {SALE_TYPE[v.sale.sale_type]} <b className="mono">{v.sale.sale_number}</b>
            {v.sale.selling_partner_name ? <> por <b>{v.sale.selling_partner_name}</b></> : null}
            {v.sale.contact_name ? <> a <b>{v.sale.contact_name}</b></> : null} por {money(v.sale.sale_price - v.sale.discount_amount, cur)}
            {v.sale.commission_amount ? ` · comisión ${money(v.sale.commission_amount, cur)}` : ''} · {SALE_STATUS[v.sale.status]}
          </span>
          {v.sale.status === 'pending' && v.sale.sale_type !== 'partner_own' && (
            <span className="row">
              <button className="btn-sm" onClick={() => run(() => api.post(`/sales/${v.sale.id}/deliver`), 'Vehículo entregado').then((ok) => ok && reload())}>Marcar entregado</button>
              <button className="btn-sm btn-danger" onClick={() => setModal('cancelSale')}>Cancelar venta</button>
            </span>
          )}
        </div>
      )}

      <div className="vehicle-hero" style={{ marginBottom: 16 }}>
        <div className="photo">
          {v.media[0] ? <img src={v.media[0].url} alt={`${v.make} ${v.model}`} /> : <span>{BODY_TYPE[v.body_type] ?? 'Sin foto'}</span>}
        </div>
        <div className="card">
          <div className="money-strip" style={{ marginBottom: 16 }}>
            <div><div className="k">Precio de lista</div><div className="v">{money(v.list_price, cur)}</div><div className="small muted">mín. {money(v.min_price, cur)}</div></div>
            {v.is_own
              ? <div><div className="k">Costo total</div><div className="v">{money(v.total_cost, cur)}</div><div className="small muted">compra {money(v.acquisition_cost, cur)} + {money(v.extra_costs, cur)}</div></div>
              : <div><div className="k">Costo</div><div className="v">—</div><div className="small muted">vehículo de socio: ganamos la comisión</div></div>}
            <div><div className="k">Margen esperado</div><div className="v" style={{ color: v.expected_margin < 0 ? 'var(--bad)' : undefined }}>{v.list_price && v.total_cost > 0 ? money(v.expected_margin, cur) : '—'}</div><div className="small muted">{v.list_price && v.total_cost ? `${((v.expected_margin / v.list_price) * 100).toFixed(1)}% sobre precio` : ''}</div></div>
            <div><div className="k">Valor de mercado</div><div className="v">{money(v.market_value, cur)}</div><div className="small muted">{v.market_valued_at ? `valuado ${date(v.market_valued_at)}` : 'sin comparables'}</div></div>
          </div>
          {v.is_own && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row">
                <button className="btn-sm" onClick={() => setModal('edit')}>Editar ficha</button>
                {!['sold', 'delivered', 'archived'].includes(v.status) && <button className="btn-sm" onClick={() => setModal('transfer')}>Trasladar de lote</button>}
                {!['delivered', 'archived'].includes(v.status) && <button className="btn-sm" onClick={() => setModal('cost')}>+ Costo</button>}
                <button className="btn-sm" onClick={() => setModal('photo')}>+ Foto</button>
              </div>
              <label className="check small" title="Los socios con permiso de lectura verán y podrán vender este vehículo">
                <input type="checkbox" checked={v.syndicate} disabled={busy}
                  onChange={(e) => run(() => api.patch(`/vehicles/${id}`, { syndicate: e.target.checked }),
                    e.target.checked ? 'Compartido con socios' : 'Retirado de socios').then((ok) => ok && reload())} />
                Compartir con socios
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="tabs">
        {[['ficha', 'Ficha técnica'], ['costos', `Costos (${v.costs.length})`], ['mercado', 'Mercado'], ['bitacora', `Bitácora (${v.events.length})`], ['leads', `Interesados (${v.leads.length})`]].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'ficha' && <Specs v={v} />}
      {tab === 'costos' && <Costs v={v} onChange={reload} />}
      {tab === 'mercado' && <Market v={v} onChange={reload} />}
      {tab === 'bitacora' && <Timeline v={v} lots={lots} />}
      {tab === 'leads' && (
        <div className="card flush">
          {v.leads.length === 0 ? <Empty>Nadie ha mostrado interés aún.</Empty> : (
            <table><tbody>{v.leads.map((l) => (
              <tr key={l.id}><td>{l.contact_name}</td><td><StatusBadge status={l.status} label={LEAD_STATUS[l.status]} /></td><td className="muted">{date(l.created_at)}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      )}

      {modal === 'edit' && <VehicleForm vehicle={v} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal === 'reserve' && <ReserveModal v={v} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'sell' && <SellModal v={v} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'transfer' && <TransferModal v={v} lots={lots} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'cost' && <CostModal v={v} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'photo' && <PhotoModal v={v} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'cancelSale' && <CancelSaleModal sale={v.sale} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </>
  );
}

function Specs({ v }) {
  const rows = [
    ['VIN', v.vin ? <span className="mono">{v.vin}</span> : '—'], ['Placas', v.plate_number], ['Condición', CONDITION[v.condition]],
    ['Kilometraje', km(v.odometer, v.odometer_unit)], ['Carrocería', BODY_TYPE[v.body_type]], ['Transmisión', TRANSMISSION[v.transmission]],
    ['Combustible', FUEL[v.fuel_type]], ['Tracción', DRIVETRAIN[v.drivetrain]], ['Motor', v.engine],
    ['Cilindros', v.cylinders], ['Puertas', v.doors], ['Asientos', v.seats],
    ['Color exterior', v.exterior_color], ['Color interior', v.interior_color], ['Situación legal', v.title_status],
    ['Fecha de compra', date(v.acquired_at)], ['Publicado', date(v.listed_at)], ['Vendido', date(v.sold_at)],
  ];
  const extra = Object.entries(v.attributes ?? {}).filter(([, val]) => typeof val !== 'object');
  return (
    <div className="grid g2">
      <div className="card">
        <div className="specs">
          {rows.map(([k, val]) => <div className="spec" key={k}><div className="k">{k}</div><div className="v">{val ?? '—'}</div></div>)}
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Equipamiento</h3>
        <div className="row" style={{ gap: 6 }}>
          {v.features.length ? v.features.map((f) => <span className="badge plain" key={f}>{f}</span>) : <span className="muted">Sin registrar</span>}
        </div>
        {v.description && <><h3 style={{ margin: '18px 0 8px' }}>Descripción</h3><p style={{ margin: 0 }}>{v.description}</p></>}
        {extra.length > 0 && (
          <>
            <h3 style={{ margin: '18px 0 8px' }}>Campos del sistema origen</h3>
            <div className="specs">{extra.map(([k, val]) => <div className="spec" key={k}><div className="k">{k}</div><div className="v">{String(val)}</div></div>)}</div>
          </>
        )}
      </div>
    </div>
  );
}

function Costs({ v, onChange }) {
  const [run] = useAction();
  return (
    <div className="card flush">
      {v.costs.length === 0 ? <Empty>Sin costos adicionales.</Empty> : (
        <table>
          <thead><tr><th>Fecha</th><th>Categoría</th><th>Descripción</th><th>Proveedor</th><th className="right">Monto</th><th /></tr></thead>
          <tbody>
            {v.costs.map((c) => (
              <tr key={c.id}>
                <td>{date(c.incurred_at)}</td><td>{COST_CATEGORY[c.category]}</td><td>{c.description}</td><td className="muted">{c.vendor}</td>
                <td className="right">{money(c.amount, v.currency)}</td>
                <td className="right"><button className="btn-sm btn-ghost btn-danger" onClick={() => run(() => api.del(`/vehicles/${v.id}/costs/${c.id}`), 'Costo eliminado').then(onChange)}>Quitar</button></td>
              </tr>
            ))}
            <tr><td colSpan={4} className="right"><b>Total adicional</b></td><td className="right"><b>{money(v.extra_costs, v.currency)}</b></td><td /></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function Market({ v, onChange }) {
  const [win, setWin] = useState(1);
  const comps = useAsync(() => api.get(`/vehicles/${v.id}/comparables?year_window=${win}`), [v.id, win, v.market_valued_at]);
  const [run, busy] = useAction();
  const val = v.valuations[0];

  // escala común para el rango de mercado y nuestro precio
  const lo = Math.min(val?.value_low ?? Infinity, v.list_price ?? Infinity) * 0.97;
  const hi = Math.max(val?.value_high ?? 0, v.list_price ?? 0) * 1.03;
  const pos = (x) => `${((x - lo) / (hi - lo)) * 100}%`;

  return (
    <div className="grid g3">
      <div className="card">
        <div className="card-head">
          <h2>Valuación</h2>
          <button className="btn-sm" disabled={busy} onClick={() => run(() => api.post(`/vehicles/${v.id}/valuate`), 'Valuación actualizada').then(onChange)}>Recalcular</button>
        </div>
        {!val ? <p className="muted">No hay comparables suficientes. Ejecuta una fuente de mercado en “Ingesta de mercado”.</p> : (
          <>
            <div className="range" aria-label="Rango de mercado">
              <div className="band tip" style={{ left: pos(val.value_low), width: `calc(${pos(val.value_high)} - ${pos(val.value_low)})` }}
                data-tip={`P25–P75: ${money(val.value_low)} – ${money(val.value_high)}`} />
              <div className="mid" style={{ left: pos(val.value_mid) }} />
              {v.list_price && <div className="pin tip" style={{ left: pos(v.list_price) }} data-tip={`Nuestro precio: ${money(v.list_price)}`} />}
            </div>
            <div className="row small" style={{ justifyContent: 'space-between' }}>
              <span>P25 {money(val.value_low)}</span><b>Mediana {money(val.value_mid)}</b><span>P75 {money(val.value_high)}</span>
            </div>
            <p className="small muted" style={{ marginTop: 12 }}>
              {val.sample_size} comparables · ventana ±{val.details?.year_window} año(s) · {date(val.valued_at)}.
              Precios ajustados por año (±6%) y kilometraje (±1% por 10 mil km). El punto naranja es nuestro precio.
            </p>
            {v.status !== 'sold' && v.status !== 'delivered' && v.list_price !== val.value_mid && (
              <button className="btn-sm" style={{ marginTop: 6 }} disabled={busy}
                onClick={() => run(() => api.patch(`/vehicles/${v.id}`, { list_price: val.value_mid, price_note: 'Precio ajustado a mediana de mercado' }), 'Precio actualizado').then(onChange)}>
                Usar mediana como precio ({money(val.value_mid)})
              </button>
            )}
          </>
        )}
      </div>
      <div className="card flush span2">
        <div className="card-head">
          <h2>Comparables</h2>
          <Select value={String(win)} onChange={(x) => setWin(Number(x))} options={{ 0: 'Mismo año', 1: '±1 año', 2: '±2 años', 3: '±3 años' }} />
        </div>
        <div className="table-wrap" style={{ marginTop: 10, maxHeight: 420 }}>
          <table>
            <thead><tr><th>Anuncio</th><th>Fuente</th><th className="right">Año</th><th className="right">Km</th><th className="right">Precio</th><th className="right">Ajustado</th></tr></thead>
            <tbody>
              {(comps.data ?? []).map((c) => (
                <tr key={c.listing_id}>
                  <td>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : c.title}<div className="cell-sub">visto {date(c.last_seen_at)}</div></td>
                  <td className="muted small">{c.source_code}</td>
                  <td className="right">{c.year}</td>
                  <td className="right">{num(c.odometer_km)}</td>
                  <td className="right">{money(c.price)}</td>
                  <td className="right"><b>{money(c.adjusted_price)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          {comps.data?.length === 0 && <Empty>Sin comparables en esa ventana.</Empty>}
        </div>
      </div>
    </div>
  );
}

function Timeline({ v }) {
  const describe = (e) => {
    switch (e.event_type) {
      case 'created': return `Alta en inventario (${VEHICLE_STATUS[e.to_status]})`;
      case 'status_change': return `${VEHICLE_STATUS[e.from_status]} → ${VEHICLE_STATUS[e.to_status]}`;
      case 'lot_transfer': return `Traslado ${e.from_lot_code ?? 'sin lote'} → ${e.to_lot_code ?? 'sin lote'}`;
      case 'price_change': return `Precio ${money(e.old_price)} → ${money(e.new_price)}`;
      default: return e.event_type;
    }
  };
  return (
    <div className="card">
      <ul className="timeline">
        {v.events.map((e) => (
          <li key={e.id}>
            <div><b>{describe(e)}</b></div>
            <div className="small muted">{dateTime(e.created_at)}{e.user_name ? ` · ${e.user_name}` : ''}{e.notes ? ` · ${e.notes}` : ''}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------- Modales ----------------
function ReserveModal({ v, onClose, onDone }) {
  const [f, set] = useForm({ contact_id: '', deposit_amount: '5000', days: '3', notes: '' });
  const [run, busy] = useAction();
  const submit = () => run(() => api.post('/reservations', { ...f, vehicle_id: v.id }), 'Vehículo apartado').then((ok) => ok && onDone());
  return (
    <Modal size="sm" title="Apartar vehículo" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!f.contact_id || busy} onClick={submit}>Apartar</button></>}>
      <div className="grid">
        <Field label="Cliente"><ContactPicker value={f.contact_id} onChange={set('contact_id')} /></Field>
        <div className="grid g2">
          <Field label="Anticipo"><input inputMode="decimal" value={f.deposit_amount} onChange={set('deposit_amount')} /></Field>
          <Field label="Vigencia (días)"><input type="number" min="1" value={f.days} onChange={set('days')} /></Field>
        </div>
        <Field label="Notas"><input value={f.notes} onChange={set('notes')} /></Field>
        <p className="small muted" style={{ margin: 0 }}>Al vencer, el apartado se libera automáticamente y el vehículo vuelve a “Disponible”.</p>
      </div>
    </Modal>
  );
}

function SellModal({ v, onClose, onDone }) {
  const r = v.reservation;
  const [f, set] = useForm({
    contact_id: r?.contact_id ?? '', sale_price: String(v.list_price ?? ''), discount_amount: '0', fees_amount: '0',
    down_payment: '', payment_method: 'cash', financing_institution: '', financing_term_months: '', notes: '',
    has_trade: false, trade_make: '', trade_model: '', trade_year: '', trade_odometer: '', trade_value: '',
  });
  const [flags, setFlags] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/sales', {
        vehicle_id: v.id, contact_id: f.contact_id, lead_id: r?.lead_id ?? null,
        sale_price: f.sale_price, discount_amount: f.discount_amount, fees_amount: f.fees_amount,
        down_payment: f.down_payment, payment_method: f.payment_method,
        financing_institution: f.financing_institution, financing_term_months: f.financing_term_months, notes: f.notes,
        trade_in: f.has_trade ? { make: f.trade_make, model: f.trade_model, year: f.trade_year, odometer: f.trade_odometer, value: f.trade_value } : null,
        ...flags,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const net = Number(f.sale_price || 0) - Number(f.discount_amount || 0);
  const profit = net - (v.total_cost ?? 0);
  const needs = error?.details?.requires;

  return (
    <Modal title={`Registrar venta · ${v.stock_number}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!f.contact_id || busy} onClick={submit}>{busy ? 'Guardando…' : 'Confirmar venta'}</button></>}>
      <div className="grid">
        <Field label="Cliente">
          <ContactPicker value={f.contact_id} onChange={set('contact_id')} initialLabel={r?.contact_name} />
        </Field>
        <div className="form-grid">
          <Field label="Precio de venta"><input inputMode="decimal" value={f.sale_price} onChange={set('sale_price')} /></Field>
          <Field label="Descuento"><input inputMode="decimal" value={f.discount_amount} onChange={set('discount_amount')} /></Field>
          <Field label="Trámites / comisiones"><input inputMode="decimal" value={f.fees_amount} onChange={set('fees_amount')} /></Field>
          <Field label="Forma de pago"><Select value={f.payment_method} onChange={set('payment_method')} options={PAYMENT_METHOD} /></Field>
          <Field label="Enganche / pago inicial"><input inputMode="decimal" value={f.down_payment} onChange={set('down_payment')} /></Field>
          {f.payment_method === 'financing' && <>
            <Field label="Financiera"><input value={f.financing_institution} onChange={set('financing_institution')} /></Field>
            <Field label="Plazo (meses)"><input type="number" value={f.financing_term_months} onChange={set('financing_term_months')} /></Field>
          </>}
        </div>
        {v.is_own ? (
          <div className="alert info small">
            Neto {money(net)} · costo {money(v.total_cost)} · utilidad estimada <b>{money(profit)}</b>
            {v.min_price ? ` · mínimo autorizado ${money(v.min_price)}` : ''}
            {r?.deposit_amount ? ` · se aplicará el anticipo de ${money(r.deposit_amount)}` : ''}
          </div>
        ) : (
          <div className="alert info small">
            Vehículo de <b>{v.owner_partner_name}</b>: la venta se le notifica en automático y nuestra utilidad es la comisión pactada sobre {money(net)}.
          </div>
        )}
        <label className="check"><input type="checkbox" checked={f.has_trade} onChange={set('has_trade')} /> Recibe auto a cuenta</label>
        {f.has_trade && (
          <div className="form-grid">
            <Field label="Marca"><input value={f.trade_make} onChange={set('trade_make')} /></Field>
            <Field label="Modelo"><input value={f.trade_model} onChange={set('trade_model')} /></Field>
            <Field label="Año"><input type="number" value={f.trade_year} onChange={set('trade_year')} /></Field>
            <Field label="Km"><input inputMode="numeric" value={f.trade_odometer} onChange={set('trade_odometer')} /></Field>
            <Field label="Valor a cuenta"><input inputMode="decimal" value={f.trade_value} onChange={set('trade_value')} /></Field>
          </div>
        )}
        <Field label="Notas"><input value={f.notes} onChange={set('notes')} /></Field>
        {error && (
          <div className="alert">
            {error.message}
            {needs && (
              <div style={{ marginTop: 8 }}>
                <label className="check">
                  <input type="checkbox" checked={Boolean(flags[needs])} onChange={(e) => setFlags({ ...flags, [needs]: e.target.checked })} />
                  {needs === 'approve_below_min' ? 'Autorizo vender por debajo del mínimo' : 'Vender aunque esté apartado para otro cliente'}
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function TransferModal({ v, lots, onClose, onDone }) {
  const [lot, setLot] = useState('');
  const [run, busy] = useAction();
  return (
    <Modal size="sm" title="Trasladar de lote" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!lot || busy}
        onClick={() => run(() => api.post(`/vehicles/${v.id}/transfer`, { lot_id: lot }), 'Vehículo trasladado').then((ok) => ok && onDone())}>Trasladar</button></>}>
      <Field label="Lote destino">
        <select value={lot} onChange={(e) => setLot(e.target.value)}>
          <option value="">Selecciona…</option>
          {lots.filter((l) => l.id !== v.lot_id && l.is_active).map((l) => (
            <option key={l.id} value={l.id}>{l.code} · {l.name} ({l.units_in_stock}{l.capacity ? `/${l.capacity}` : ''})</option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function CostModal({ v, onClose, onDone }) {
  const [f, set] = useForm({ category: 'reconditioning', amount: '', description: '', vendor: '', incurred_at: new Date().toISOString().slice(0, 10) });
  const [run, busy] = useAction();
  return (
    <Modal size="sm" title="Agregar costo" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!f.amount || busy}
        onClick={() => run(() => api.post(`/vehicles/${v.id}/costs`, f), 'Costo agregado').then((ok) => ok && onDone())}>Guardar</button></>}>
      <div className="grid g2">
        <Field label="Categoría"><Select value={f.category} onChange={set('category')} options={COST_CATEGORY} /></Field>
        <Field label="Monto"><input inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Descripción"><input value={f.description} onChange={set('description')} /></Field>
        <Field label="Proveedor"><input value={f.vendor} onChange={set('vendor')} /></Field>
        <Field label="Fecha"><input type="date" value={f.incurred_at} onChange={set('incurred_at')} /></Field>
      </div>
    </Modal>
  );
}

function PhotoModal({ v, onClose, onDone }) {
  const [url, setUrl] = useState('');
  const [run, busy] = useAction();
  return (
    <Modal size="sm" title="Agregar foto" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!url || busy}
        onClick={() => run(() => api.post(`/vehicles/${v.id}/media`, { url, is_primary: v.media.length === 0 }), 'Foto agregada').then((ok) => ok && onDone())}>Agregar</button></>}>
      <Field label="URL de la imagen"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>
    </Modal>
  );
}

function CancelSaleModal({ sale, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  return (
    <Modal size="sm" title={`Cancelar venta ${sale.sale_number}`} onClose={onClose}
      footer={<><button onClick={onClose}>Volver</button><button className="btn-primary" disabled={busy}
        onClick={() => run(() => api.post(`/sales/${sale.id}/cancel`, { reason }), 'Venta cancelada').then((ok) => ok && onDone())}>Cancelar venta</button></>}>
      <p style={{ marginTop: 0 }}>El vehículo regresa a “Disponible”. Si hubo auto a cuenta, se da de baja del inventario.</p>
      <Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
