import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLookups } from '../App.jsx';
import { api } from '../api.js';
import { Empty, Field, StatusBadge, useAction, useAsync } from '../components/ui.jsx';
import { km, money, num, relative } from '../format.js';

const AVAILABILITY = { available: 'Disponible', reserved: 'Apartado', sold: 'Vendido', unavailable: 'No disponible' };

/** "Authorization: Bearer x\nX-Api-Key: y" -> { Authorization: 'Bearer x', 'X-Api-Key': 'y' } */
function parseHeaders(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(':');
    return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null;
  }).filter(Boolean));
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const short = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 40);

export default function Connect() {
  const { partners } = useLookups();
  const fieldsDef = useAsync(() => api.get('/connectors/fields'), []);
  const connectors = useAsync(async () => (await api.get('/ingestion/sources')).sources.filter((s) => s.provider === 'external_api'), []);

  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [destination, setDestination] = useState('partner');
  const [partnerCode, setPartnerCode] = useState('');
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [availabilityMap, setAvailabilityMap] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [archiveMissing, setArchiveMissing] = useState(false);
  const [result, setResult] = useState(null);
  const [run, busy] = useAction();
  const firstLoad = useRef(true);

  const config = () => ({
    url, headers: parseHeaders(headersText), destination,
    partner_code: destination === 'partner' ? partnerCode : undefined,
  });

  async function test(extra = {}) {
    setLoading(true);
    setError(null);
    try {
      const p = await api.post('/connectors/preview', { ...config(), ...extra });
      setPreview(p);
      setMapping(p.mapping);
      setAvailabilityMap(p.availability_map);
      if (!name) setName(partners.find((x) => x.code === partnerCode)?.name ?? new URL(url).hostname);
      return p;
    } catch (err) {
      setError(err.message);
      setPreview(null);
      return null;
    } finally {
      setLoading(false);
    }
  }

  // al cambiar el mapeo a mano, recalcular la vista previa
  useEffect(() => {
    if (!preview || !mapping) return undefined;
    if (firstLoad.current) { firstLoad.current = false; return undefined; }
    const t = setTimeout(() => {
      api.post('/connectors/preview', {
        ...config(), items_path: preview.items_path, mapping, availability_map: availabilityMap ?? undefined,
      })
        .then((p) => {
          setPreview((cur) => ({ ...cur, preview: p.preview, usable_items: p.usable_items }));
          if (!availabilityMap) setAvailabilityMap(p.availability_map); // se cambió el campo de estado: nuevas equivalencias
        })
        .catch((err) => setError(err.message));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping, availabilityMap, destination]);

  const startTest = () => { firstLoad.current = true; setResult(null); test(); };

  async function save() {
    const r = await run(() => api.post('/connectors', {
      ...config(), name, code: slug(`api_${name}`), items_path: preview.items_path, mapping,
      availability_map: availabilityMap, archive_missing: archiveMissing,
      max_pages: url.includes('{page}') ? 20 : undefined,
    }), 'Conexión guardada e importada');
    if (r) { setResult(r.run); connectors.reload(); }
  }

  const fieldOptions = useMemo(() => preview?.fields ?? [], [preview]);
  const requiredOk = mapping && ['external_id', 'make', 'model', 'year'].every((k) => mapping[k])
    && (destination !== 'listings' || mapping.price);
  const availabilityValues = Object.keys(availabilityMap ?? {});

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Conectar sistema externo</h1>
          <p>Consulta el endpoint de otro sistema (un socio, una agencia), mapea sus campos con los nuestros y empata sus autos en la base de datos.</p>
        </div>
      </div>

      {connectors.data?.length > 0 && (
        <div className="card flush" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Conexiones guardadas</h2></div>
          <table style={{ marginTop: 10 }}>
            <tbody>{connectors.data.map((s) => (
              <tr key={s.id}>
                <td><div className="cell-title">{s.name}</div><div className="cell-sub mono">{s.config.url}</div></td>
                <td className="small">{s.config.destination === 'listings' ? 'Autos encontrados' : `Socio: ${s.config.partner_code}`}</td>
                <td className="small">{s.last_run ? <><StatusBadge status={s.last_run.status} /> {relative(s.last_run.started_at)} · {num(s.last_run.items_found)} leídos</> : '—'}</td>
                <td className="right"><button className="btn-sm" onClick={() => run(() => api.post(`/ingestion/sources/${s.id}/run`), 'Sincronización iniciada').then(() => setTimeout(connectors.reload, 2500))}>Sincronizar</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {/* Paso 1 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 12 }}>1 · Endpoint</h3>
        <div className="form-grid">
          <Field label="URL del endpoint (JSON)" hint="usa {page} si pagina" wide>
            <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.socio.mx/v1/autos?page={page}" />
          </Field>
          <Field label="Encabezados" hint="uno por línea, p.ej. su llave" wide>
            <textarea className="mono" style={{ minHeight: 56 }} value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder="Authorization: Bearer su-llave" />
          </Field>
          <Field label="¿A dónde van sus autos?">
            <select value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option value="partner">Inventario de un socio</option>
              <option value="listings">Autos encontrados (para agregarlos después)</option>
            </select>
          </Field>
          {destination === 'partner' && (
            <Field label="Socio dueño de los autos">
              <select value={partnerCode} onChange={(e) => setPartnerCode(e.target.value)}>
                <option value="">Selecciona…</option>
                {partners.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        {destination === 'partner' && partners.length === 0 && (
          <p className="small muted">Primero da de alta al socio en <Link to="/socios">Socios</Link>.</p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn-primary" disabled={!url || loading} onClick={startTest}>{loading ? 'Consultando…' : 'Probar conexión'}</button>
        </div>
        {error && <div className="alert" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {preview && mapping && (
        <>
          {/* Paso 2 */}
          <div className="card flush" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <h3>2 · Mapeo de campos</h3>
              <span className="small">
                {num(preview.total_items)} elementos en <span className="mono">{preview.items_path || '(raíz)'}</span> ·
                {' '}<b>{num(preview.usable_items)}</b> listos para importar
              </span>
            </div>
            <p className="small muted" style={{ padding: '6px 18px 0', margin: 0 }}>
              El mapeo se sugirió automáticamente por nombre del campo y por el tipo de valor. Corrige lo que haga falta; la vista previa se actualiza sola.
            </p>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Nuestro campo</th><th>Su campo</th><th>Ejemplo de su dato</th><th>Detección</th></tr></thead>
                <tbody>
                  {fieldsDef.data?.map((f) => {
                    const path = mapping[f.key] ?? '';
                    const sample = fieldOptions.find((x) => x.path === path)?.samples?.[0];
                    const conf = preview.confidence?.[f.key];
                    const required = ['external_id', 'make', 'model', 'year'].includes(f.key) || (f.key === 'price' && destination === 'listings');
                    return (
                      <tr key={f.key}>
                        <td><b>{f.label}</b>{required && <span style={{ color: 'var(--bad)' }}> *</span>}</td>
                        <td>
                          <select value={path} onChange={(e) => {
                            setMapping({ ...mapping, [f.key]: e.target.value || null });
                            if (f.key === 'availability') setAvailabilityMap(null);
                          }}
                            style={required && !path ? { borderColor: 'var(--bad)' } : undefined}>
                            <option value="">— no usar —</option>
                            {fieldOptions.map((x) => <option key={x.path} value={x.path}>{x.path}</option>)}
                          </select>
                        </td>
                        <td className="mono small">{short(sample)}</td>
                        <td>
                          {!path ? <span className="badge plain">Sin mapear</span>
                            : conf == null || preview.mapping[f.key] !== path ? <span className="badge plain info">Manual</span>
                              : conf >= 70 ? <span className="badge ok">Automático {conf}%</span>
                                : <span className="badge warn">Revisar {conf}%</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {availabilityValues.length > 0 && (
              <div style={{ padding: '14px 18px 4px' }}>
                <h3 style={{ marginBottom: 8 }}>Sus estados → los nuestros</h3>
                <div className="row" style={{ gap: 12 }}>
                  {availabilityValues.map((v) => (
                    <label key={v} className="field" style={{ minWidth: 170 }}>
                      <span className="mono">{v}</span>
                      <select value={availabilityMap[v]} onChange={(e) => setAvailabilityMap({ ...availabilityMap, [v]: e.target.value })}>
                        {Object.entries(AVAILABILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div style={{ padding: '14px 18px 0' }}><h3>Vista previa (así quedará en LotesCRM)</h3></div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Su ID</th><th>Vehículo</th><th>Color</th><th className="right">Km</th><th>Transmisión</th><th className="right">Precio</th><th>Estado</th><th /></tr></thead>
                <tbody>
                  {preview.preview.map((m, i) => (
                    <tr key={m.external_id ?? i}>
                      <td className="mono small">{m.external_id ?? '—'}</td>
                      <td><div className="cell-title">{[m.make, m.model, m.year].filter(Boolean).join(' ') || '—'}</div><div className="cell-sub">{m.version}</div></td>
                      <td>{m.color ?? '—'}</td>
                      <td className="right">{km(m.odometer)}</td>
                      <td>{m.transmission ?? '—'}</td>
                      <td className="right">{money(m.price)}</td>
                      <td>{AVAILABILITY[m.availability]}</td>
                      <td>{m.missing.length > 0 && <span className="badge bad">Falta {m.missing.join(', ')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.preview.length === 0 && <Empty>La lista está vacía.</Empty>}
            </div>
          </div>

          {/* Paso 3 */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginBottom: 12 }}>3 · Guardar e importar</h3>
            <div className="form-grid">
              <Field label="Nombre de la conexión"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            </div>
            {destination === 'partner' && (
              <label className="check small" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={archiveMissing} onChange={(e) => setArchiveMissing(e.target.checked)} />
                Retirar de nuestro inventario los autos que ya no aparezcan en su lista
              </label>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn-primary" disabled={busy || !requiredOk || !name || (destination === 'partner' && !partnerCode)} onClick={save}>
                {busy ? 'Importando…' : 'Guardar e importar'}
              </button>
              {!requiredOk && <span className="small" style={{ color: 'var(--bad)' }}>Mapea los campos marcados con *</span>}
              {destination === 'partner' && !partnerCode && <span className="small" style={{ color: 'var(--bad)' }}>Elige el socio</span>}
            </div>
            {result && (
              <div className={`alert ${result.items_failed ? 'warn' : 'info'}`} style={{ marginTop: 12 }}>
                <b>{result.status === 'failed' ? 'Falló' : 'Listo'}:</b> {num(result.items_found)} leídos · {num(result.items_inserted)} nuevos ·
                {' '}{num(result.items_updated)} actualizados · {num(result.items_failed)} con error
                {result.error_message && <> · {result.error_message}</>}
                {' '}· {destination === 'partner'
                  ? <Link to={`/inventario?owner=${partners.find((p) => p.code === partnerCode)?.id ?? 'partners'}`}>Ver en inventario</Link>
                  : <Link to="/mercado">Ver autos encontrados</Link>}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
