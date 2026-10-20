import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLookups } from '../App.jsx';
import { api, qs } from '../api.js';
import ContactPicker from '../components/ContactPicker.jsx';
import { ErrorBox, Field, Loading, Modal, Select, StatusBadge, useAction, useAsync, useForm } from '../components/ui.jsx';
import { ACTIVITY_TYPE, LEAD_SOURCE, LEAD_STATUS, dateTime, money, relative } from '../format.js';

export default function Leads() {
  const { users } = useLookups();
  const [owner, setOwner] = useState('');
  const { data, loading, error, reload } = useAsync(() => api.get(`/leads${qs({ assigned_user_id: owner })}`), [owner]);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [openLead, setOpenLead] = useState(null);
  const [creating, setCreating] = useState(false);
  const [run] = useAction();

  const move = async (lead, status) => {
    if (lead.status === status) return;
    let lost_reason;
    if (status === 'lost') {
      lost_reason = window.prompt('Motivo de pérdida (opcional):') ?? undefined;
    }
    await run(() => api.patch(`/leads/${lead.id}`, { status, lost_reason }), `Movido a ${LEAD_STATUS[status]}`);
    reload();
  };

  if (loading && !data) return <Loading />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Prospectos</h1>
          <p>Arrastra las tarjetas para avanzar en el embudo.</p>
        </div>
        <div className="row">
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Todos los vendedores</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <button className="btn-primary" onClick={() => setCreating(true)}>+ Nuevo prospecto</button>
        </div>
      </div>
      <ErrorBox error={error} />

      <div className="kanban">
        {Object.entries(LEAD_STATUS).map(([status, label]) => {
          const items = (data ?? []).filter((l) => l.status === status);
          return (
            <div key={status} className={`lane ${over === status ? 'drop' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(status); }}
              onDragLeave={() => setOver(null)}
              onDrop={() => { setOver(null); if (dragging) move(dragging, status); setDragging(null); }}>
              <div className="lane-head"><span>{label}</span><span className="badge plain">{items.length}</span></div>
              {items.map((l) => (
                <div key={l.id} className="lead-card" draggable onDragStart={() => setDragging(l)} onClick={() => setOpenLead(l.id)}>
                  <b>{l.contact_name}</b>
                  <span className="small">{l.vehicle_label ?? (l.desired_make ? `Busca ${l.desired_make} ${l.desired_model ?? ''}` : <span className="muted">Sin vehículo</span>)}</span>
                  <span className="small muted">
                    {LEAD_SOURCE[l.source]}{l.budget_max ? ` · hasta ${money(l.budget_max, 'MXN', { compact: true })}` : ''}
                  </span>
                  {l.next_activity_at && <span className={`badge plain ${new Date(l.next_activity_at) < new Date() ? 'bad' : 'info'}`} style={{ alignSelf: 'flex-start' }}>Seguimiento {relative(l.next_activity_at)}</span>}
                  <span className="small muted">{l.assigned_user_name ?? 'Sin asignar'}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {creating && <NewLeadModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {openLead && <LeadModal id={openLead} onClose={() => { setOpenLead(null); reload(); }} />}
    </>
  );
}

function NewLeadModal({ onClose, onDone }) {
  const { users, userId } = useLookups();
  const [f, set] = useForm({ contact_id: '', source: 'walk_in', assigned_user_id: userId ?? '', vehicle_id: '', budget_max: '', desired_make: '', desired_model: '', notes: '' });
  const vehicles = useAsync(() => api.get('/vehicles?status=available&limit=200&sort=make&dir=asc'), []);
  const [run, busy] = useAction();
  return (
    <Modal title="Nuevo prospecto" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!f.contact_id || busy}
        onClick={() => run(() => api.post('/leads', f), 'Prospecto creado').then((ok) => ok && onDone())}>Crear</button></>}>
      <div className="grid">
        <Field label="Contacto"><ContactPicker value={f.contact_id} onChange={set('contact_id')} /></Field>
        <div className="form-grid">
          <Field label="Origen"><Select value={f.source} onChange={set('source')} options={LEAD_SOURCE} /></Field>
          <Field label="Vendedor">
            <select value={f.assigned_user_id} onChange={set('assigned_user_id')}>
              <option value="">Sin asignar</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </Field>
          <Field label="Presupuesto máximo"><input inputMode="decimal" value={f.budget_max} onChange={set('budget_max')} /></Field>
          <Field label="Vehículo de interés" wide>
            <select value={f.vehicle_id} onChange={set('vehicle_id')}>
              <option value="">— Ninguno específico —</option>
              {vehicles.data?.items.map((v) => <option key={v.id} value={v.id}>{v.make} {v.model} {v.year} · {v.stock_number} · {money(v.list_price)}</option>)}
            </select>
          </Field>
          <Field label="Marca deseada"><input value={f.desired_make} onChange={set('desired_make')} /></Field>
          <Field label="Modelo deseado"><input value={f.desired_model} onChange={set('desired_model')} /></Field>
          <Field label="Notas" wide><textarea value={f.notes} onChange={set('notes')} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function LeadModal({ id, onClose }) {
  const { data: l, reload } = useAsync(() => api.get(`/leads/${id}`), [id]);
  const [f, set, setF] = useForm({ activity_type: 'call', subject: '', due_at: '', notes: '' });
  const [run, busy] = useAction();
  if (!l) return null;

  const addActivity = async () => {
    const ok = await run(() => api.post(`/leads/${id}/activities`, { ...f, due_at: f.due_at ? new Date(f.due_at).toISOString() : '' }), 'Actividad registrada');
    if (ok) { setF({ activity_type: 'call', subject: '', due_at: '', notes: '' }); reload(); }
  };

  return (
    <Modal title={l.contact_name} onClose={onClose}>
      <div className="row" style={{ marginBottom: 14 }}>
        <StatusBadge status={l.status} label={LEAD_STATUS[l.status]} />
        <span className="muted">{LEAD_SOURCE[l.source]} · {l.assigned_user_name ?? 'sin vendedor'}</span>
        <Link className="small" to={`/contactos/${l.contact_id}`}>Ver contacto</Link>
      </div>
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div><div className="small muted">Teléfono / correo</div><b>{l.contact_phone ?? '—'}</b> <span className="muted">{l.contact_email}</span></div>
        <div>
          <div className="small muted">Vehículo de interés</div>
          {l.vehicle_id ? <Link to={`/inventario/${l.vehicle_id}`}><b>{l.vehicle_label}</b></Link> : '—'}
          {l.vehicle_status && <span className="muted small"> · {l.vehicle_status}</span>}
        </div>
        {l.notes && <div className="span2"><div className="small muted">Notas</div>{l.notes}</div>}
        {l.lost_reason && <div className="span2 alert">Motivo de pérdida: {l.lost_reason}</div>}
      </div>

      <h3 style={{ marginBottom: 10 }}>Registrar actividad</h3>
      <div className="form-grid" style={{ marginBottom: 10 }}>
        <Field label="Tipo"><Select value={f.activity_type} onChange={set('activity_type')} options={ACTIVITY_TYPE} /></Field>
        <Field label="Asunto"><input value={f.subject} onChange={set('subject')} /></Field>
        <Field label="Fecha de seguimiento" hint="opcional"><input type="datetime-local" value={f.due_at} onChange={set('due_at')} /></Field>
        <Field label="Notas" wide><input value={f.notes} onChange={set('notes')} /></Field>
      </div>
      <button className="btn-primary btn-sm" disabled={!f.subject || busy} onClick={addActivity}>Guardar actividad</button>

      <h3 style={{ margin: '20px 0 8px' }}>Historial</h3>
      <ul className="timeline">
        {l.activities.map((a) => (
          <li key={a.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{ACTIVITY_TYPE[a.activity_type]} · {a.subject}</b>
              {a.completed_at ? <span className="badge ok">Hecha</span>
                : a.due_at ? <button className="btn-sm" onClick={() => run(() => api.post(`/activities/${a.id}/complete`), 'Completada').then(reload)}>Completar</button> : null}
            </div>
            <div className="small muted">{a.due_at ? `Para ${dateTime(a.due_at)}` : dateTime(a.created_at)}{a.user_name ? ` · ${a.user_name}` : ''}{a.notes ? ` · ${a.notes}` : ''}</div>
          </li>
        ))}
        {l.activities.length === 0 && <li className="muted">Sin actividades.</li>}
      </ul>
    </Modal>
  );
}
