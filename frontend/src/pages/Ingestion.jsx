import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLookups } from '../App.jsx';
import { api, qs } from '../api.js';
import { Empty, ErrorBox, Field, Modal, StatusBadge, useAction, useAsync, useToast } from '../components/ui.jsx';
import { FUEL, TRANSMISSION, km, money, num, relative } from '../format.js';

const KIND = { api: 'API', scraper: 'Scraping', file: 'Archivo', manual: 'Manual' };

// Plantillas para nuevas fuentes
const TEMPLATES = {
  jsonld: {
    label: 'Sitio de agencia (automático, schema.org)', provider: 'generic_html', kind: 'scraper',
    config: { mode: 'jsonld', start_urls: ['https://www.tu-agencia.mx/seminuevos?page={page}'], max_pages: 2, delay_ms: 3000, currency: 'MXN' },
  },
  css: {
    label: 'Sitio de agencia (selectores CSS)', provider: 'generic_html', kind: 'scraper',
    config: {
      mode: 'css', start_urls: ['https://www.tu-agencia.mx/seminuevos?page={page}'], max_pages: 2, item_selector: '.auto',
      fields: {
        external_id: { selector: 'a', attr: 'href' }, url: { selector: 'a', attr: 'href' },
        make: { selector: '.marca' }, model: { selector: '.modelo' }, year: { selector: '.anio' }, trim: { selector: '.version' },
        exterior_color: { selector: '.color' }, odometer: { selector: '.km' }, transmission: { selector: '.transmision' },
        price: { selector: '.precio' }, location: { selector: '.ciudad' },
      },
      delay_ms: 3000, currency: 'MXN',
    },
  },
  nhtsa: { label: 'NHTSA · catálogo (API gratuita)', provider: 'nhtsa_vpic', kind: 'api', config: { years: [2025], makes: ['NISSAN'] } },
};

export default function Ingestion() {
  const { lots } = useLookups();
  const notify = useToast();
  const sources = useAsync(() => api.get('/ingestion/sources'), []);
  const runs = useAsync(() => api.get('/ingestion/runs'), []);
  const [q, setQ] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  const listings = useAsync(() => api.get(`/ingestion/listings${qs({ q, limit: 300, in_inventory: onlyNew ? 'false' : '' })}`), [q, onlyNew]);
  const [selected, setSelected] = useState(new Set());
  const [lotId, setLotId] = useState('');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [run, busy] = useAction();

  // mientras haya corridas en curso, refrescar cada 3 s
  const anyRunning = runs.data?.some((r) => r.status === 'running');
  const { reload: reloadRuns } = runs;
  const { reload: reloadSources } = sources;
  const { reload: reloadListings } = listings;
  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(() => { reloadRuns(); reloadSources(); reloadListings(); }, 3000);
    return () => clearInterval(t);
  }, [anyRunning, reloadRuns, reloadSources, reloadListings]);

  const items = listings.data?.items ?? [];
  const selectable = items.filter((l) => !l.vehicle_id && l.make && l.model && l.year);
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = selectable.length > 0 && selectable.every((l) => selected.has(l.id));

  async function addToInventory() {
    const r = await run(() => api.post('/ingestion/listings/to-inventory', { ids: [...selected], lot_id: lotId || null }));
    if (!r) return;
    notify(`${r.created.length} vehículo(s) agregados al inventario${r.skipped.length ? ` · ${r.skipped.length} omitidos` : ''}`);
    setSelected(new Set());
    listings.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Autos de agencias</h1>
          <p>Vehículos encontrados en sitios de agencias y concesionarias. Selecciona los que quieras y agrégalos al inventario.</p>
        </div>
        <button onClick={() => setCreating(true)}>+ Nueva fuente</button>
      </div>
      <ErrorBox error={sources.error} />

      <div className="grid g3" style={{ marginBottom: 16 }}>
        {sources.data?.sources.map((s) => (
          <div className="card" key={s.id} style={{ opacity: s.is_enabled ? 1 : 0.65 }}>
            <div className="card-head" style={{ marginBottom: 8 }}>
              <h2 style={{ fontSize: 14 }}>{s.name}</h2>
              <span className="badge plain">{KIND[s.kind]}</span>
            </div>
            <div className="small muted" style={{ marginBottom: 10 }}>
              {s.last_run
                ? <>Última: <StatusBadge status={s.last_run.status} /> {relative(s.last_run.started_at)} · {num(s.last_run.items_found)} encontrados</>
                : 'Nunca se ha ejecutado'}
              {s.last_run?.error_message && <div className="alert" style={{ marginTop: 6 }}>{s.last_run.error_message}</div>}
            </div>
            <div className="row">
              <button className="btn-sm btn-primary" disabled={!s.is_enabled || anyRunning}
                onClick={() => run(() => api.post(`/ingestion/sources/${s.id}/run`), 'Ingesta iniciada').then(reloadRuns)}>Ejecutar</button>
              <button className="btn-sm" onClick={() => setEditing(s)}>Configurar</button>
              <label className="check small"><input type="checkbox" checked={s.is_enabled}
                onChange={() => run(() => api.patch(`/ingestion/sources/${s.id}`, { is_enabled: !s.is_enabled })).then(reloadSources)} /> Activa</label>
            </div>
          </div>
        ))}
      </div>
      {anyRunning && <div className="alert info" style={{ marginBottom: 16 }}>Ingesta en curso… la tabla se actualiza sola. El scraper hace pausas entre páginas para no saturar los sitios.</div>}

      <div className="card flush">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <h2>Vehículos encontrados <span className="muted" style={{ fontWeight: 400 }}>({num(listings.data?.total ?? 0)})</span></h2>
          <div className="row">
            <input type="search" placeholder="Buscar marca, modelo…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="check small"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Sólo los que no están en inventario</label>
          </div>
        </div>

        {selected.size > 0 && (
          <div className="row" style={{ padding: '12px 18px 0', gap: 10 }}>
            <b>{selected.size} seleccionados</b>
            <select value={lotId} onChange={(e) => setLotId(e.target.value)}>
              <option value="">Sin lote asignado</option>
              {lots.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
            </select>
            <button className="btn-primary btn-sm" disabled={busy} onClick={addToInventory}>Agregar al inventario</button>
            <button className="btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Limpiar</button>
          </div>
        )}

        <div className="table-wrap" style={{ marginTop: 10, maxHeight: 620 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input type="checkbox" aria-label="Seleccionar todos" checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((l) => l.id)))} />
                </th>
                <th>Vehículo</th><th>Color</th><th className="right">Km</th><th>Transmisión</th>
                <th className="right">Precio</th><th>Agencia / ciudad</th><th />
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id}>
                  <td>{!l.vehicle_id && <input type="checkbox" aria-label="Seleccionar" disabled={!l.make || !l.model || !l.year}
                    checked={selected.has(l.id)} onChange={() => toggle(l.id)} />}</td>
                  <td>
                    <div className="cell-title">{l.make ?? '?'} {l.model ?? ''} {l.year ?? ''}</div>
                    <div className="cell-sub">{l.trim ?? l.title}</div>
                  </td>
                  <td>{l.exterior_color ?? <span className="muted">—</span>}</td>
                  <td className="right">{km(l.odometer, l.odometer_unit)}</td>
                  <td>{TRANSMISSION[l.transmission] ?? '—'}{l.fuel_type && <div className="cell-sub">{FUEL[l.fuel_type]}</div>}</td>
                  <td className="right"><b>{money(l.price, l.currency)}</b></td>
                  <td>{l.seller_name ?? <span className="muted">Concesionaria</span>}<div className="cell-sub">{l.location_city}</div></td>
                  <td className="right nowrap">
                    {l.vehicle_id
                      ? <Link className="badge ok" to={`/inventario/${l.vehicle_id}`}>En inventario</Link>
                      : l.url && <a className="small" href={l.url} target="_blank" rel="noreferrer">Ver anuncio</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <Empty>Sin vehículos. Ejecuta una fuente para traer autos de agencias.</Empty>}
        </div>
      </div>

      {editing && <SourceConfigModal source={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reloadSources(); }} />}
      {creating && <NewSourceModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); reloadSources(); }} />}
    </>
  );
}

function JsonField({ text, setText, err }) {
  return (
    <>
      <Field label="Configuración (JSON)">
        <textarea className="mono" style={{ minHeight: 300 }} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <p className="small muted">
        <b>start_urls</b> admite <span className="mono">{'{page}'}</span> para paginar. En modo <b>jsonld</b> no hay que configurar
        selectores: se leen los datos estructurados que publican muchos sitios de agencias. Revisa los términos de uso del sitio;
        el scraper respeta robots.txt y hace pausas entre páginas.
      </p>
    </>
  );
}

function SourceConfigModal({ source, onClose, onDone }) {
  const [text, setText] = useState(JSON.stringify(source.config, null, 2));
  const [err, setErr] = useState(null);
  const [run, busy] = useAction();
  const save = () => {
    let config;
    try { config = JSON.parse(text); } catch (e) { setErr(`JSON inválido: ${e.message}`); return; }
    run(() => api.patch(`/ingestion/sources/${source.id}`, { config }), 'Configuración guardada').then((ok) => ok && onDone());
  };
  return (
    <Modal title={`Configurar · ${source.name}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy} onClick={save}>Guardar</button></>}>
      <JsonField text={text} setText={(t) => { setText(t); setErr(null); }} err={err} />
    </Modal>
  );
}

function NewSourceModal({ onClose, onDone }) {
  const [tpl, setTpl] = useState('jsonld');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState(JSON.stringify(TEMPLATES.jsonld.config, null, 2));
  const [err, setErr] = useState(null);
  const [run, busy] = useAction();
  const save = () => {
    let config;
    try { config = JSON.parse(text); } catch (e) { setErr(`JSON inválido: ${e.message}`); return; }
    const t = TEMPLATES[tpl];
    run(() => api.post('/ingestion/sources', { code, name, provider: t.provider, kind: t.kind, config, is_enabled: true }), 'Fuente creada')
      .then((ok) => ok && onDone());
  };
  return (
    <Modal title="Nueva fuente" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy || !code || !name} onClick={save}>Crear</button></>}>
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label="Tipo">
          <select value={tpl} onChange={(e) => { setTpl(e.target.value); setText(JSON.stringify(TEMPLATES[e.target.value].config, null, 2)); }}>
            {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Código" hint="minúsculas y _"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="agencia_toyota_gdl" /></Field>
        <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Toyota Guadalajara" /></Field>
      </div>
      <JsonField text={text} setText={(t) => { setText(t); setErr(null); }} err={err} />
    </Modal>
  );
}
