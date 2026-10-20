import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLookups } from '../App.jsx';
import { api, qs } from '../api.js';
import VehicleForm from '../components/VehicleForm.jsx';
import { Empty, ErrorBox, Select, StatusBadge, useAsync } from '../components/ui.jsx';
import { VEHICLE_STATUS, km, money, num } from '../format.js';

const PAGE = 25;

export default function Inventory() {
  const { lots, makes, partners } = useLookups();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [showForm, setShowForm] = useState(params.get('nuevo') === '1');
  const [search, setSearch] = useState(params.get('q') ?? '');

  const filters = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    in_stock: params.get('status') ? '' : (params.get('todos') === '1' ? '' : 'true'),
    lot_id: params.get('lot_id') ?? '',
    make_id: params.get('make_id') ?? '',
    owner: params.get('owner') ?? '',
    sort: params.get('sort') ?? 'created_at',
    dir: params.get('dir') ?? 'desc',
    offset: params.get('offset') ?? '0',
    limit: PAGE,
  };
  const key = qs(filters);
  const { data, loading, error, reload } = useAsync(() => api.get(`/vehicles${key}`), [key]);

  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('offset' in patch)) next.delete('offset');
    next.delete('nuevo');
    setParams(next);
  };

  // búsqueda con pequeño retardo
  useEffect(() => {
    const t = setTimeout(() => { if (search !== filters.q) update({ q: search }); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const sortBy = (col) => update({ sort: col, dir: filters.sort === col && filters.dir === 'desc' ? 'asc' : 'desc' });
  const arrow = (col) => (filters.sort === col ? (filters.dir === 'desc' ? ' ↓' : ' ↑') : '');
  const offset = Number(filters.offset);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inventario</h1>
          <p>{data ? `${num(data.total)} vehículos` : ' '}</p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>+ Nuevo vehículo</button>
      </div>

      <div className="filters">
        <input type="search" placeholder="Buscar marca, modelo, VIN, stock…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select value={filters.status} onChange={(v) => update({ status: v })} options={VEHICLE_STATUS} placeholder="En inventario (todos los estados en stock)" />
        <select value={filters.lot_id} onChange={(e) => update({ lot_id: e.target.value })}>
          <option value="">Todos los lotes</option>
          {lots.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
        </select>
        <select value={filters.make_id} onChange={(e) => update({ make_id: e.target.value })}>
          <option value="">Todas las marcas</option>
          {makes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={filters.owner} onChange={(e) => update({ owner: e.target.value })}>
          <option value="">Propio y de socios</option>
          <option value="own">Sólo inventario propio</option>
          <option value="partners">Sólo de socios</option>
          {partners.map((p) => <option key={p.id} value={p.id}>Socio: {p.name}</option>)}
        </select>
        {!filters.status && (
          <label className="check">
            <input type="checkbox" checked={params.get('todos') === '1'} onChange={(e) => update({ todos: e.target.checked ? '1' : '' })} />
            Incluir vendidos y bajas
          </label>
        )}
      </div>

      <ErrorBox error={error} />
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => sortBy('make')}>Vehículo{arrow('make')}</th>
                <th>Estado</th>
                <th>Origen</th>
                <th className="sortable right" onClick={() => sortBy('odometer')}>Km{arrow('odometer')}</th>
                <th className="sortable right" onClick={() => sortBy('list_price')}>Precio{arrow('list_price')}</th>
                <th className="right">Mercado</th>
                <th className="sortable right" onClick={() => sortBy('expected_margin')}>Margen{arrow('expected_margin')}</th>
                <th className="sortable right" onClick={() => sortBy('days_in_stock')}>Días{arrow('days_in_stock')}</th>
              </tr>
            </thead>
            <tbody style={{ opacity: loading ? 0.5 : 1 }}>
              {data?.items.map((v) => {
                const vsMarket = v.market_value && v.list_price ? (v.list_price / v.market_value - 1) * 100 : null;
                return (
                  <tr key={v.id} className="click" onClick={() => navigate(`/inventario/${v.id}`)}>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <div className="thumb">{v.primary_image_url ? <img src={v.primary_image_url} alt="" /> : v.body_type ?? 'auto'}</div>
                        <div>
                          <div className="cell-title">{v.make} {v.model} {v.year}</div>
                          <div className="cell-sub"><span className="mono">{v.stock_number}</span>{v.trim ? ` · ${v.trim}` : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge status={v.status} /></td>
                    <td>
                      {v.is_own
                        ? <>{v.lot_code ?? <span className="muted">Sin lote</span>}{!v.syndicate && <div className="cell-sub">no compartido</div>}</>
                        : <span className="badge plain info" title={v.owner_partner_name}>Socio · {v.owner_partner_name}</span>}
                    </td>
                    <td className="right">{km(v.odometer, v.odometer_unit)}</td>
                    <td className="right"><b>{money(v.list_price, v.currency)}</b></td>
                    <td className="right">
                      {v.market_value ? (
                        <span className="tip" data-tip={`${vsMarket > 0 ? '+' : ''}${vsMarket?.toFixed(1)}% vs. mercado`}>
                          {money(v.market_value, v.currency)}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td className="right">{v.list_price && v.total_cost > 0 ? money(v.expected_margin, v.currency) : '—'}</td>
                    <td className="right">{v.days_in_stock > 90 ? <span className="badge plain bad">{v.days_in_stock}</span> : v.days_in_stock}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && data.items.length === 0 && (
          <Empty>
            {filters.q || filters.status || filters.lot_id || filters.make_id || filters.owner
              ? 'No hay vehículos con esos filtros.'
              : 'El inventario está vacío. Da de alta un vehículo, impórtalo desde otro sistema o conecta un socio.'}
          </Empty>
        )}
        </div>
        {data && data.total > PAGE && (
          <div className="row" style={{ justifyContent: 'space-between', padding: '12px 16px', borderTop: '1px solid var(--line-2)' }}>
            <span className="muted small">{offset + 1}–{Math.min(offset + PAGE, data.total)} de {data.total}</span>
            <div className="row">
              <button className="btn-sm" disabled={offset === 0} onClick={() => update({ offset: String(offset - PAGE) })}>← Anterior</button>
              <button className="btn-sm" disabled={offset + PAGE >= data.total} onClick={() => update({ offset: String(offset + PAGE) })}>Siguiente →</button>
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <VehicleForm
          onClose={() => setShowForm(false)}
          onSaved={(v) => { setShowForm(false); reload(); navigate(`/inventario/${v.id}`); }}
        />
      )}
    </>
  );
}
