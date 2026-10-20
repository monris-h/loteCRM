import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Empty, ErrorBox, Field, Modal, useAction, useAsync, useForm } from '../components/ui.jsx';
import { MX_STATES, date, num } from '../format.js';

export default function Contacts() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const { data, error, reload } = useAsync(() => api.get(`/contacts${qs({ q: debounced, limit: 200 })}`), [debounced]);

  return (
    <>
      <div className="page-head">
        <div><h1>Contactos</h1><p>{data ? `${num(data.total)} contactos` : ' '}</p></div>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ Nuevo contacto</button>
      </div>
      <div className="filters">
        <input type="search" placeholder="Buscar por nombre, correo, teléfono o RFC…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} />
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nombre</th><th>Teléfono</th><th>Correo</th><th>Ciudad</th><th>Origen</th><th className="right">Prospectos abiertos</th><th className="right">Compras</th><th>Alta</th></tr></thead>
            <tbody>
              {data?.items.map((c) => (
                <tr key={c.id} className="click" onClick={() => navigate(`/contactos/${c.id}`)}>
                  <td><div className="cell-title">{c.display_name}</div>{c.contact_type === 'company' && <div className="cell-sub">Empresa · {c.tax_id}</div>}</td>
                  <td>{c.phone ?? c.mobile ?? '—'}</td>
                  <td>{c.email ?? '—'}</td>
                  <td>{c.city ?? '—'}</td>
                  <td className="muted">{c.source ?? '—'}</td>
                  <td className="right">{c.open_leads}</td>
                  <td className="right">{c.purchases}</td>
                  <td className="muted">{date(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.items.length === 0 && <Empty>Sin contactos.</Empty>}
        </div>
      </div>
      {creating && <ContactModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
    </>
  );
}

export function ContactModal({ contact, onClose, onDone }) {
  const [f, set] = useForm({
    contact_type: contact?.contact_type ?? 'person', first_name: contact?.first_name ?? '', last_name: contact?.last_name ?? '',
    company_name: contact?.company_name ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', mobile: contact?.mobile ?? '',
    tax_id: contact?.tax_id ?? '', city: contact?.city ?? '', state: contact?.state ?? '', source: contact?.source ?? '',
    preferred_contact: contact?.preferred_contact ?? '', notes: contact?.notes ?? '',
  });
  const [run, busy] = useAction();
  const save = () => run(() => (contact ? api.patch(`/contacts/${contact.id}`, f) : api.post('/contacts', f)), 'Contacto guardado')
    .then((ok) => ok && onDone());
  return (
    <Modal title={contact ? 'Editar contacto' : 'Nuevo contacto'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy} onClick={save}>Guardar</button></>}>
      <div className="form-grid">
        <Field label="Tipo">
          <select value={f.contact_type} onChange={set('contact_type')}><option value="person">Persona</option><option value="company">Empresa</option></select>
        </Field>
        {f.contact_type === 'company' && <Field label="Razón social *"><input value={f.company_name} onChange={set('company_name')} /></Field>}
        <Field label={f.contact_type === 'company' ? 'Nombre del contacto' : 'Nombre *'}><input value={f.first_name} onChange={set('first_name')} /></Field>
        <Field label="Apellidos"><input value={f.last_name} onChange={set('last_name')} /></Field>
        <Field label="Teléfono"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Celular / WhatsApp"><input value={f.mobile} onChange={set('mobile')} /></Field>
        <Field label="Correo"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="RFC"><input value={f.tax_id} onChange={set('tax_id')} /></Field>
        <Field label="Ciudad"><input value={f.city} onChange={set('city')} /></Field>
        <Field label="Estado">
          <select value={f.state} onChange={set('state')}>
            <option value="">—</option>
            {MX_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Origen"><input value={f.source} onChange={set('source')} placeholder="website, referido…" /></Field>
        <Field label="Contacto preferido">
          <select value={f.preferred_contact} onChange={set('preferred_contact')}>
            <option value="">—</option><option value="phone">Teléfono</option><option value="whatsapp">WhatsApp</option><option value="email">Correo</option><option value="sms">SMS</option>
          </select>
        </Field>
        <Field label="Notas" wide><textarea value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}
