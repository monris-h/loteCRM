import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorBox, Loading, StatusBadge, useAsync } from '../components/ui.jsx';
import { LEAD_STATUS, date, money, num, relative } from '../format.js';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function VerticalBars({ data, value, label, format }) {
  const max = Math.max(...data.map(value), 1);
  return (
    <div className="bars-v baseline" style={{ borderTop: 0 }}>
      {data.map((d) => (
        <div className="col tip" key={label(d)} data-tip={`${label(d)}: ${format(value(d))}`}>
          <span className="val">{value(d) > 0 ? format(value(d), true) : ''}</span>
          <div className="bar" style={{ height: `${(value(d) / max) * 100}%` }} />
          <span className="lbl">{label(d)}</span>
        </div>
      ))}
    </div>
  );
}

function HorizontalBars({ data, value, label, format = num }) {
  const max = Math.max(...data.map(value), 1);
  return (
    <div className="bars-h">
      {data.map((d) => (
        <div className="r tip" key={label(d)} data-tip={`${label(d)}: ${format(value(d))}`}>
          <span className="nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label(d)}</span>
          <div className="track"><div className="fill" style={{ width: `${(value(d) / max) * 100}%` }} /></div>
          <span className="right" style={{ fontVariantNumeric: 'tabular-nums' }}>{format(value(d))}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { data, loading, error } = useAsync(() => api.get('/dashboard/summary'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const { stock, month_sales: ms, sales_trend: trend, aging, leads_funnel: funnel, by_lot: lots,
    by_status: byStatus, reservations, attention, top_models: top, partners: net } = data;
  const potential = stock.inventory_list_value - stock.inventory_cost;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tablero</h1>
          <p>{date(new Date(), { dateStyle: 'full' })}</p>
        </div>
        <Link className="btn btn-primary" to="/inventario?nuevo=1">+ Vehículo</Link>
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <span className="label">Unidades en inventario</span>
          <span className="value">{num(stock.units)}</span>
          <span className="sub">{num(stock.available)} disponibles para venta</span>
        </div>
        <div className="card stat">
          <span className="label">Inversión en inventario</span>
          <span className="value">{money(stock.inventory_cost, 'MXN', { compact: true })}</span>
          <span className="sub">Margen potencial {money(potential, 'MXN', { compact: true })}</span>
        </div>
        <div className="card stat">
          <span className="label">Días promedio en piso</span>
          <span className="value">{num(stock.avg_days_in_stock)}</span>
          <span className="sub">{num(aging.find((a) => a.bucket === '90+')?.units ?? 0)} unidades con +90 días</span>
        </div>
        <div className="card stat">
          <span className="label">Ventas del mes</span>
          <span className="value">{num(ms.units)} <span style={{ fontSize: 15, fontWeight: 500 }}>uds</span></span>
          <span className="sub">{money(ms.revenue)} · utilidad {money(ms.gross_profit)}{ms.via_partners > 0 ? ` · ${ms.via_partners} vía socios` : ''}</span>
        </div>
      </div>

      {net.active_partners > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Socios</h2><Link className="small" to="/socios">Administrar</Link></div>
          <div className="grid g4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <div className="stat"><span className="label">Socios activos</span><span className="value" style={{ fontSize: 20 }}>{num(net.active_partners)}</span></div>
            <div className="stat"><span className="label">Nuestros autos compartidos</span><span className="value" style={{ fontSize: 20 }}>{num(net.shared_vehicles)}</span></div>
            <div className="stat"><span className="label">Autos de socios disponibles</span><span className="value" style={{ fontSize: 20 }}>{num(net.partner_vehicles_available)}</span></div>
            <div className="stat"><span className="label">Comisiones a cobrar (mes)</span><span className="value" style={{ fontSize: 20 }}>{money(net.commissions_receivable)}</span></div>
            <div className="stat"><span className="label">Comisiones a pagar (mes)</span><span className="value" style={{ fontSize: 20 }}>{money(net.commissions_payable)}</span></div>
          </div>
        </div>
      )}

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <div className="card span2">
          <div className="card-head"><h2>Utilidad bruta por mes</h2><span className="muted small">últimos 6 meses</span></div>
          <VerticalBars
            data={trend}
            value={(d) => d.gross_profit}
            label={(d) => `${MONTHS[Number(d.month.slice(5)) - 1]} ${d.month.slice(2, 4)}`}
            format={(v, compact) => money(v, 'MXN', { compact })}
          />
          <div className="row small muted" style={{ marginTop: 12, gap: 18 }}>
            {trend.map((t) => <span key={t.month}>{t.month.slice(5)}: {num(t.units)} uds · {money(t.revenue, 'MXN', { compact: true })}</span>)}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Antigüedad del inventario</h2></div>
          <HorizontalBars data={aging} value={(d) => d.units} label={(d) => `${d.bucket} días`} />
          <h3 style={{ marginTop: 22, marginBottom: 10 }}>Por estado</h3>
          <div className="row" style={{ gap: 6 }}>
            {byStatus.filter((s) => s.units > 0).map((s) => (
              <Link key={s.status} to={`/inventario?status=${s.status}`} style={{ textDecoration: 'none' }}>
                <StatusBadge status={s.status} label={`${s.label} · ${s.units}`} />
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head"><h2>Embudo de prospectos</h2><Link className="small" to="/leads">Ver</Link></div>
          <HorizontalBars data={funnel} value={(d) => d.leads} label={(d) => LEAD_STATUS[d.status]} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Ocupación de lotes</h2></div>
          <div className="grid" style={{ gap: 14 }}>
            {lots.map((l) => {
              const pct = l.capacity ? Math.min(100, (l.units / l.capacity) * 100) : 0;
              return (
                <div key={l.id}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                    <span><b>{l.code}</b> <span className="muted">{l.name}</span></span>
                    <span className="small">{l.units}{l.capacity ? ` / ${l.capacity}` : ''}</span>
                  </div>
                  {l.capacity ? <div className={`meter ${pct > 85 ? 'hot' : ''}`}><div style={{ width: `${pct}%` }} /></div> : null}
                </div>
              );
            })}
          </div>
          <h3 style={{ marginTop: 22, marginBottom: 10 }}>Modelos con más unidades</h3>
          <HorizontalBars data={top.slice(0, 5)} value={(d) => d.units} label={(d) => `${d.make} ${d.model}`} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Apartados activos</h2><Link className="small" to="/ventas">Ver</Link></div>
          {reservations.length === 0 && <p className="muted">Sin apartados.</p>}
          {reservations.map((r) => (
            <Link key={r.id} to={`/inventario/${r.vehicle_id}`} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line-2)', textDecoration: 'none' }}>
              <span>
                <div className="cell-title">{r.vehicle_label}</div>
                <div className="cell-sub">{r.contact_name}</div>
              </span>
              <span className={`badge ${new Date(r.expires_at) - Date.now() < 86400000 ? 'warn' : 'plain'}`}>vence {relative(r.expires_at)}</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="card flush">
        <div className="card-head">
          <h2>Requieren atención</h2>
          <span className="muted small">Precio &gt;8% sobre mercado o más de 90 días en piso</span>
        </div>
        {attention.length === 0 ? <p className="empty">Todo en orden.</p> : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Vehículo</th><th className="right">Precio</th><th className="right">Mercado</th><th className="right">vs. mercado</th><th className="right">Días</th></tr></thead>
              <tbody>
                {attention.map((v) => (
                  <tr key={v.id} className="click" onClick={() => navigate(`/inventario/${v.id}`)}>
                    <td><div className="cell-title">{v.make} {v.model} {v.year}</div><div className="cell-sub mono">{v.stock_number}</div></td>
                    <td className="right">{money(v.list_price)}</td>
                    <td className="right">{money(v.market_value)}</td>
                    <td className="right">{v.pct_vs_market != null ? <span className={`badge plain ${v.pct_vs_market > 8 ? 'warn' : ''}`}>{v.pct_vs_market > 0 ? '+' : ''}{v.pct_vs_market}%</span> : '—'}</td>
                    <td className="right">{v.days_in_stock > 90 ? <span className="badge plain bad">{v.days_in_stock}</span> : v.days_in_stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
