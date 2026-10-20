import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Empty, ErrorBox, Field, Modal, Select, StatusBadge, useAction, useAsync, useForm } from '../components/ui.jsx';
import { PAYMENT_METHOD, SALE_STATUS, SALE_TYPE, date, dateTime, money, relative } from '../format.js';

export default function Sales() {
  const [tab, setTab] = useState('sales');
  const [status, setStatus] = useState('');
  const [saleType, setSaleType] = useState('');
  const sales = useAsync(() => api.get(`/sales${qs({ status, sale_type: saleType })}`), [status, saleType]);
  const reservations = useAsync(() => api.get('/reservations'), []);
  const [payFor, setPayFor] = useState(null);
  const [run] = useAction();

  // Las ventas que un socio hace de su propio inventario sólo se reflejan: no cuentan como ingreso
  const counted = (sales.data ?? []).filter((s) => s.status !== 'cancelled' && s.sale_type !== 'partner_own');
  const totals = counted.reduce((acc, s) => ({
    revenue: acc.revenue + (['direct', 'partner_sold_ours'].includes(s.sale_type) ? s.sale_price - s.discount_amount : 0),
    profit: acc.profit + (s.gross_profit ?? 0),
    due: acc.due + Math.max(0, s.balance_due),
    commissions: acc.commissions + (s.sale_type === 'partner_sold_ours' ? s.commission_amount ?? 0 : 0),
  }), { revenue: 0, profit: 0, due: 0, commissions: 0 });

  return (
    <>
      <div className="page-head">
        <div><h1>Ventas y apartados</h1><p>Las ventas se registran desde la ficha de cada vehículo.</p></div>
        <Link className="btn btn-primary" to="/inventario?status=available">Vender un vehículo</Link>
      </div>
      <div className="tabs">
        <button className={tab === 'sales' ? 'active' : ''} onClick={() => setTab('sales')}>Ventas</button>
        <button className={tab === 'res' ? 'active' : ''} onClick={() => setTab('res')}>Apartados activos ({reservations.data?.length ?? 0})</button>
      </div>

      {tab === 'sales' && (
        <>
          <div className="grid g4" style={{ marginBottom: 16 }}>
            <div className="card stat"><span className="label">Ingreso neto</span><span className="value">{money(totals.revenue)}</span></div>
            <div className="card stat"><span className="label">Utilidad bruta</span><span className="value">{money(totals.profit)}</span><span className="sub">incluye comisiones cobradas</span></div>
            <div className="card stat"><span className="label">Comisiones a pagar a socios</span><span className="value">{money(totals.commissions)}</span></div>
            <div className="card stat"><span className="label">Saldo por cobrar</span><span className="value">{money(totals.due)}</span></div>
          </div>
          <div className="filters">
            <Select value={status} onChange={setStatus} options={SALE_STATUS} placeholder="Todos los estados" />
            <Select value={saleType} onChange={setSaleType} options={SALE_TYPE} placeholder="Todos los tipos" />
          </div>
          <ErrorBox error={sales.error} />
          <div className="card flush">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Venta</th><th>Vehículo</th><th>Tipo</th><th>Cliente</th><th>Pago</th><th className="right">Neto</th><th className="right">Comisión</th><th className="right">Utilidad</th><th className="right">Saldo</th><th>Estado</th><th /></tr></thead>
                <tbody>
                  {sales.data?.map((s) => (
                    <tr key={s.id} style={s.sale_type === 'partner_own' ? { opacity: 0.75 } : undefined}>
                      <td><span className="mono">{s.sale_number}</span><div className="cell-sub">{date(s.sale_date)} · {s.selling_partner_name ?? s.salesperson_name ?? '—'}</div></td>
                      <td><Link to={`/inventario/${s.vehicle_id}`}>{s.vehicle_label}</Link><div className="cell-sub mono">{s.stock_number}{s.trade_in_stock_number ? ` · a cuenta ${s.trade_in_stock_number}` : ''}</div></td>
                      <td>
                        <span className={`badge plain ${s.sale_type === 'direct' ? '' : 'info'}`}>{SALE_TYPE[s.sale_type]}</span>
                        {(s.selling_partner_name || s.owner_partner_name) && <div className="cell-sub">{s.selling_partner_name ?? s.owner_partner_name}</div>}
                      </td>
                      <td>{s.contact_name ?? <span className="muted">—</span>}</td>
                      <td>{PAYMENT_METHOD[s.payment_method]}{s.financing_institution ? <div className="cell-sub">{s.financing_institution}</div> : null}</td>
                      <td className="right">{money(s.sale_price - s.discount_amount, s.currency)}</td>
                      <td className="right">
                        {s.commission_amount
                          ? <span title={s.sale_type === 'partner_sold_ours' ? 'A pagar al socio' : 'A cobrar al socio'}>{s.sale_type === 'partner_sold_ours' ? '−' : '+'}{money(s.commission_amount, s.currency)}</span>
                          : '—'}
                      </td>
                      <td className="right">{money(s.gross_profit, s.currency)}</td>
                      <td className="right">{s.status === 'cancelled' || s.sale_type === 'partner_own' ? '—' : money(s.balance_due, s.currency)}</td>
                      <td><StatusBadge status={s.status} label={SALE_STATUS[s.status]} /></td>
                      <td className="right nowrap">
                        {s.status !== 'cancelled' && s.sale_type !== 'partner_own' && s.balance_due > 0 && <button className="btn-sm" onClick={() => setPayFor(s)}>+ Pago</button>}
                        {s.status === 'pending' && s.sale_type !== 'partner_own' && <button className="btn-sm" onClick={() => run(() => api.post(`/sales/${s.id}/deliver`), 'Entregado').then(sales.reload)}>Entregar</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sales.data?.length === 0 && <Empty>Sin ventas.</Empty>}
            </div>
          </div>
        </>
      )}

      {tab === 'res' && (
        <div className="card flush">
          <table>
            <thead><tr><th>Vehículo</th><th>Cliente</th><th className="right">Anticipo</th><th>Vence</th><th>Registró</th><th /></tr></thead>
            <tbody>
              {reservations.data?.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/inventario/${r.vehicle_id}`}>{r.vehicle_label}</Link><div className="cell-sub mono">{r.stock_number}</div></td>
                  <td>{r.contact_name}</td>
                  <td className="right">{money(r.deposit_amount, r.currency)}</td>
                  <td><span className={`badge plain ${r.expiring_soon ? 'warn' : ''}`}>{relative(r.expires_at)}</span><div className="cell-sub">{dateTime(r.expires_at)}</div></td>
                  <td className="muted">{r.user_name ?? '—'}</td>
                  <td className="right"><button className="btn-sm btn-danger" onClick={() => run(() => api.post(`/reservations/${r.id}/cancel`, {}), 'Apartado cancelado').then(reservations.reload)}>Cancelar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {reservations.data?.length === 0 && <Empty>Sin apartados activos.</Empty>}
        </div>
      )}

      {payFor && <PaymentModal sale={payFor} onClose={() => setPayFor(null)} onDone={() => { setPayFor(null); sales.reload(); }} />}
    </>
  );
}

function PaymentModal({ sale, onClose, onDone }) {
  const [f, set] = useForm({ amount: String(sale.balance_due), method: 'transfer', reference: '' });
  const [run, busy] = useAction();
  return (
    <Modal size="sm" title={`Pago a ${sale.sale_number}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy}
        onClick={() => run(() => api.post(`/sales/${sale.id}/payments`, f), 'Pago registrado').then((ok) => ok && onDone())}>Registrar</button></>}>
      <div className="grid">
        <p className="muted" style={{ margin: 0 }}>Saldo actual {money(sale.balance_due)}</p>
        <Field label="Monto"><input inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Método"><Select value={f.method} onChange={set('method')} options={{ cash: 'Efectivo', transfer: 'Transferencia', card: 'Tarjeta', check: 'Cheque', financing: 'Financiera', other: 'Otro' }} /></Field>
        <Field label="Referencia"><input value={f.reference} onChange={set('reference')} /></Field>
      </div>
    </Modal>
  );
}
