import { useState } from 'react';
import { api } from '../api.js';
import { ErrorBox, Field, StatusBadge, useAsync } from '../components/ui.jsx';
import { dateTime } from '../format.js';

const ENTITY_LABEL = { vehicles: 'Vehículos (inventario)', contacts: 'Contactos / clientes', market_listings: 'Anuncios de mercado (precios)' };

export default function Import() {
  const entities = useAsync(() => api.get('/ingestion/import/entities'), []);
  const batches = useAsync(() => api.get('/ingestion/import/batches'), []);
  const [entity, setEntity] = useState('vehicles');
  const [system, setSystem] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const fields = entities.data?.[entity] ?? [];

  async function loadPreview(f = file, ent = entity) {
    if (!f) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const p = await api.upload(`/ingestion/import/${ent}/preview`, fd);
      setPreview(p);
      setMapping(p.suggested_mapping);
    } catch (err) {
      setError(err); setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function runImport(dryRun) {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mapping', JSON.stringify(mapping));
      fd.append('system', system);
      fd.append('dry_run', String(dryRun));
      setResult(await api.upload(`/ingestion/import/${entity}`, fd));
      if (!dryRun) batches.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));
  const unmapped = preview?.headers.filter((h) => !mappedHeaders.has(h)) ?? [];
  const missingRequired = fields.filter((f) => f.required && !mapping[f.key]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Migrar / importar</h1>
          <p>Carga un CSV o JSON exportado de otro sistema. Las columnas se mapean al modelo genérico de LotesCRM.</p>
        </div>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>1 · Origen</h3>
          <div className="grid">
            <Field label="¿Qué vas a importar?">
              <select value={entity} onChange={(e) => { setEntity(e.target.value); loadPreview(file, e.target.value); }}>
                {Object.entries(ENTITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Nombre del sistema origen" hint="p.ej. sistema_anterior">
              <input value={system} onChange={(e) => setSystem(e.target.value)} placeholder="excel_2025" />
            </Field>
            <Field label="Archivo (.csv o .json)">
              <input type="file" accept=".csv,.json,.txt" onChange={(e) => { const f = e.target.files[0]; setFile(f); loadPreview(f); }} />
            </Field>
            <p className="small muted" style={{ margin: 0 }}>
              Re-importar con el mismo nombre de sistema <b>actualiza</b> los registros (vía ID origen, VIN o correo) en lugar de duplicarlos.
              Las columnas sin mapear se conservan en <span className="mono">attributes</span>.
            </p>
          </div>
        </div>

        <div className="card span2">
          <h3 style={{ marginBottom: 12 }}>2 · Mapeo de columnas</h3>
          {!preview ? <p className="muted">Selecciona un archivo para ver sus columnas.</p> : (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>{preview.total_rows} filas · {preview.headers.length} columnas detectadas. Revisa el mapeo sugerido.</p>
              <div className="form-grid">
                {fields.map((f) => (
                  <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
                    <select value={mapping[f.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })}
                      style={f.required && !mapping[f.key] ? { borderColor: 'var(--bad)' } : undefined}>
                      <option value="">— no importar —</option>
                      {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              {unmapped.length > 0 && (
                <p className="small" style={{ marginBottom: 0 }}>Se guardarán como atributos extra: {unmapped.map((h) => <span key={h} className="badge plain" style={{ marginRight: 4 }}>{h}</span>)}</p>
              )}
            </>
          )}
        </div>
      </div>

      {preview && (
        <div className="card flush" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h3>3 · Vista previa y ejecución</h3>
            <div className="row">
              <button disabled={busy || !system || missingRequired.length > 0} onClick={() => runImport(true)}>Simular (sin guardar)</button>
              <button className="btn-primary" disabled={busy || !system || missingRequired.length > 0} onClick={() => runImport(false)}>Importar</button>
            </div>
          </div>
          {!system && <div className="alert warn" style={{ margin: '12px 18px 0' }}>Indica el nombre del sistema origen.</div>}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr>{preview.headers.map((h) => <th key={h}>{h}{mappedHeaders.has(h) && <span style={{ color: 'var(--good)' }}> ✓</span>}</th>)}</tr></thead>
              <tbody>{preview.sample.map((row, i) => <tr key={i}>{preview.headers.map((h) => <td key={h} className="small">{String(row[h] ?? '')}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}

      <ErrorBox error={error} />
      {result && (
        <div className={`alert ${result.failed ? 'warn' : 'info'}`} style={{ marginBottom: 16 }}>
          <b>{result.dry_run ? 'Simulación' : 'Importación'}:</b> {result.inserted} nuevos · {result.updated} actualizados · {result.failed} con error (de {result.total_rows})
          {result.errors.length > 0 && (
            <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {result.errors.slice(0, 15).map((e) => <li key={e.row}>Fila {e.row}: {e.error}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="card flush">
        <div className="card-head"><h2>Historial de importaciones</h2></div>
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Fecha</th><th>Entidad</th><th>Sistema</th><th>Archivo</th><th className="right">Nuevos</th><th className="right">Actualizados</th><th className="right">Errores</th><th>Estado</th></tr></thead>
          <tbody>
            {batches.data?.map((b) => (
              <tr key={b.id}>
                <td>{dateTime(b.created_at)}</td><td>{ENTITY_LABEL[b.entity_type] ?? b.entity_type}</td><td className="mono">{b.system}</td>
                <td className="muted">{b.file_name ?? '—'}</td><td className="right">{b.inserted}</td><td className="right">{b.updated}</td>
                <td className="right">{b.failed}</td><td><StatusBadge status={b.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
