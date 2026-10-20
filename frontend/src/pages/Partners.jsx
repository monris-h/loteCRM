import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, ErrorBox, Field, Loading, Modal, useAction, useAsync, useForm } from '../components/ui.jsx';
import { num, relative } from '../format.js';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:4000/partner/v1`;

export default function Partners() {
  const { data, loading, error, reload } = useAsync(() => api.get('/partners'), []);
  const [editing, setEditing] = useState(null); // {} = nuevo
  const [key, setKey] = useState(null);
  const [run] = useAction();

  if (loading && !data) return <Loading />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Socios</h1>
          <p>Otros lotes o agencias que venden nuestros autos y publican aquí los suyos, por medio de una API con llave.</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing({})}>+ Agregar socio</button>
      </div>
      <ErrorBox error={error} />

      <div className="card flush" style={{ marginBottom: 16 }}>
        {data?.length === 0 ? <Empty>Aún no hay socios.</Empty> : (
          <table>
            <thead><tr><th>Socio</th><th>Permisos</th><th className="right">Comisión</th><th className="right">Sus autos</th><th className="right">Sus ventas</th><th>Última llamada</th><th /></tr></thead>
            <tbody>
              {data?.map((p) => (
                <tr key={p.id} style={{ opacity: p.is_active ? 1 : 0.5 }}>
                  <td><div className="cell-title">{p.name}</div><div className="cell-sub mono">{p.code}{p.contact_email ? ` · ${p.contact_email}` : ''}</div></td>
                  <td className="small">
                    {p.can_sell_inventory && <span className="badge plain info" style={{ marginRight: 4 }}>Vende lo nuestro</span>}
                    {p.can_publish_inventory && <span className="badge plain info">Publica lo suyo</span>}
                  </td>
                  <td className="right">{num(p.commission_pct)}%</td>
                  <td className="right">{p.vehicles_in_stock > 0 ? <Link to={`/inventario?owner=${p.id}`}>{p.vehicles_in_stock}</Link> : 0}</td>
                  <td className="right">{p.sales_by_partner}</td>
                  <td className="muted small">{p.last_api_call_at ? relative(p.last_api_call_at) : 'nunca'}</td>
                  <td className="right nowrap">
                    <button className="btn-sm" onClick={() => setEditing(p)}>Editar</button>
                    <button className="btn-sm" onClick={() => {
                      if (window.confirm('¿Generar una llave nueva? La anterior dejará de funcionar.')) {
                        run(() => api.post(`/partners/${p.id}/key`)).then((r) => r && setKey({ name: p.name, api_key: r.api_key }));
                      }
                    }}>Nueva llave</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>Cómo se conecta un socio</h2><span className="small muted">Guía: docs/API_SOCIOS.md</span></div>
        <p className="small" style={{ marginTop: 0 }}>Base <span className="mono">{API_BASE}</span> · header <span className="mono">Authorization: Bearer &lt;llave&gt;</span></p>
        <p className="small" style={{ marginTop: 0 }}>
          ¿El socio tiene su propia API? Consúltala y mapea sus campos en <Link to="/conectar">Conectar sistema externo</Link>.
        </p>
        <table>
          <tbody>
            {[
              ['GET', '/inventory', 'Ver nuestros autos compartidos (sin costos ni precio mínimo)'],
              ['POST', '/sales', 'Registrar una venta: de un auto nuestro (vehicle_id) o de uno suyo (vehicle_external_id)'],
              ['PUT', '/vehicles/{su_id}', 'Publicar o actualizar un auto suyo (precio, km, color, disponibilidad)'],
              ['DELETE', '/vehicles/{su_id}', 'Retirar un auto suyo'],
              ['GET', '/sales', 'Consultar sus ventas y las nuestras de sus autos'],
            ].map(([m, path, d]) => (
              <tr key={m + path}><td className="mono small" style={{ width: 70 }}><b>{m}</b></td><td className="mono small">{path}</td><td className="small muted">{d}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <PartnerModal partner={editing} onClose={() => setEditing(null)}
        onDone={(r) => { setEditing(null); reload(); if (r?.api_key) setKey({ name: r.name, api_key: r.api_key }); }} />}
      {key && <KeyModal data={key} onClose={() => setKey(null)} />}
    </>
  );
}

function PartnerModal({ partner, onClose, onDone }) {
  const isNew = !partner.id;
  const [f, set] = useForm({
    code: partner.code ?? '', name: partner.name ?? '', contact_name: partner.contact_name ?? '',
    contact_email: partner.contact_email ?? '', contact_phone: partner.contact_phone ?? '',
    commission_pct: String(partner.commission_pct ?? 3),
    can_sell_inventory: partner.can_sell_inventory ?? true, can_publish_inventory: partner.can_publish_inventory ?? true,
    is_active: partner.is_active ?? true,
  });
  const [run, busy] = useAction();
  const body = { ...f, commission_pct: Number(f.commission_pct || 0) };
  const save = () => run(() => (isNew ? api.post('/partners', body) : api.patch(`/partners/${partner.id}`, body)), 'Socio guardado')
    .then((r) => r && onDone(r));
  return (
    <Modal title={isNew ? 'Agregar socio' : `Editar ${partner.name}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy || !f.name || !f.code} onClick={save}>{isNew ? 'Crear y generar llave' : 'Guardar'}</button></>}>
      <div className="form-grid">
        {isNew && <Field label="Código" hint="minúsculas, sin espacios"><input value={f.code} onChange={set('code')} placeholder="autos_del_norte" /></Field>}
        <Field label="Nombre"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Contacto"><input value={f.contact_name} onChange={set('contact_name')} /></Field>
        <Field label="Correo"><input type="email" value={f.contact_email} onChange={set('contact_email')} /></Field>
        <Field label="Teléfono"><input value={f.contact_phone} onChange={set('contact_phone')} /></Field>
        <Field label="Comisión %" hint="la paga el dueño del auto a quien lo vende"><input inputMode="decimal" value={f.commission_pct} onChange={set('commission_pct')} /></Field>
        <div className="wide grid" style={{ gap: 8 }}>
          <label className="check"><input type="checkbox" checked={f.can_sell_inventory} onChange={set('can_sell_inventory')} /> Puede ver y vender nuestros autos compartidos</label>
          <label className="check"><input type="checkbox" checked={f.can_publish_inventory} onChange={set('can_publish_inventory')} /> Puede publicar aquí sus autos y sus ventas</label>
          {!isNew && <label className="check"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Activo</label>}
        </div>
      </div>
    </Modal>
  );
}

function KeyModal({ data, onClose }) {
  return (
    <Modal size="sm" title={`Llave de API · ${data.name}`} onClose={onClose}
      footer={<button className="btn-primary" onClick={onClose}>Ya la guardé</button>}>
      <div className="alert warn" style={{ marginBottom: 12 }}>Cópiala y entrégala al socio. No se vuelve a mostrar.</div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="mono" readOnly value={data.api_key} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
        <button className="btn-sm" onClick={() => navigator.clipboard?.writeText(data.api_key).catch(() => {})}>Copiar</button>
      </div>
    </Modal>
  );
}
