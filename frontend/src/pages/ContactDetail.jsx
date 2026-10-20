import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, ErrorBox, Loading, StatusBadge, useAsync } from '../components/ui.jsx';
import { ACTIVITY_TYPE, LEAD_STATUS, SALE_STATUS, date, dateTime, money } from '../format.js';
import { ContactModal } from './Contacts.jsx';

export default function ContactDetail() {
  const { id } = useParams();
  const { data: c, loading, error, reload } = useAsync(() => api.get(`/contacts/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  if (loading && !c) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const extra = Object.entries(c.attributes ?? {});
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted"><Link to="/contactos">Contactos</Link></div>
          <h1 style={{ marginTop: 6 }}>{c.display_name}</h1>
          <p>{[c.phone, c.mobile, c.email, c.city].filter(Boolean).join(' · ')}</p>
        </div>
        <button onClick={() => setEditing(true)}>Editar</button>
      </div>
      <div className="grid g3">
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Datos</h3>
          <div className="specs">
            {[['Tipo', c.contact_type === 'company' ? 'Empresa' : 'Persona'], ['RFC', c.tax_id], ['Origen', c.source],
              ['Contacto preferido', c.preferred_contact], ['Alta', date(c.created_at)]].map(([k, v]) => (
              <div className="spec" key={k}><div className="k">{k}</div><div className="v">{v ?? '—'}</div></div>
            ))}
            {extra.map(([k, v]) => <div className="spec" key={k}><div className="k">{k}</div><div className="v">{String(v)}</div></div>)}
          </div>
          {c.notes && <p>{c.notes}</p>}
        </div>
        <div className="card flush">
          <div className="card-head"><h2>Prospectos</h2></div>
          {c.leads.length === 0 ? <Empty>Sin prospectos.</Empty> : (
            <table><tbody>{c.leads.map((l) => (
              <tr key={l.id}>
                <td>{l.vehicle_id ? <Link to={`/inventario/${l.vehicle_id}`}>{l.vehicle_label}</Link> : <span className="muted">Sin vehículo</span>}<div className="cell-sub">{date(l.created_at)}</div></td>
                <td className="right"><StatusBadge status={l.status} label={LEAD_STATUS[l.status]} /></td>
              </tr>
            ))}</tbody></table>
          )}
          <div className="card-head" style={{ marginTop: 10 }}><h2>Compras</h2></div>
          {c.sales.length === 0 ? <Empty>Sin compras.</Empty> : (
            <table><tbody>{c.sales.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/inventario/${s.vehicle_id}`}>{s.vehicle_label}</Link><div className="cell-sub mono">{s.sale_number} · {date(s.sale_date)}</div></td>
                <td className="right">{money(s.total_amount)}<div><StatusBadge status={s.status} label={SALE_STATUS[s.status]} /></div></td>
              </tr>
            ))}</tbody></table>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Actividades</h3>
          <ul className="timeline">
            {c.activities.map((a) => (
              <li key={a.id}><b>{ACTIVITY_TYPE[a.activity_type]} · {a.subject}</b><div className="small muted">{dateTime(a.due_at ?? a.created_at)}{a.user_name ? ` · ${a.user_name}` : ''}</div></li>
            ))}
            {c.activities.length === 0 && <li className="muted">Sin actividades.</li>}
          </ul>
        </div>
      </div>
      {editing && <ContactModal contact={c} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
    </>
  );
}
