import { useState } from 'react';
import { useLookups } from '../App.jsx';
import { api } from '../api.js';
import { Field, Modal, useAction, useForm } from '../components/ui.jsx';
import { MX_STATES } from '../format.js';

const ROLES = { admin: 'Administrador', manager: 'Gerente', sales: 'Vendedor', staff: 'Operativo' };

export default function Settings() {
  const { lots, users, reload } = useLookups();
  const [lotModal, setLotModal] = useState(null);
  const [userModal, setUserModal] = useState(false);
  const [run] = useAction();

  return (
    <>
      <div className="page-head"><div><h1>Lotes y usuarios</h1></div></div>
      <div className="grid g2">
        <div className="card flush">
          <div className="card-head"><h2>Lotes</h2><button className="btn-sm" onClick={() => setLotModal({})}>+ Lote</button></div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Código</th><th>Nombre</th><th>Ciudad</th><th className="right">Ocupación</th><th /></tr></thead>
            <tbody>
              {lots.map((l) => (
                <tr key={l.id} style={{ opacity: l.is_active ? 1 : 0.5 }}>
                  <td className="mono">{l.code}</td><td>{l.name}</td><td>{l.city ?? '—'}</td>
                  <td className="right">{l.units_in_stock}{l.capacity ? ` / ${l.capacity}` : ''}</td>
                  <td className="right"><button className="btn-sm btn-ghost" onClick={() => setLotModal(l)}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card flush">
          <div className="card-head"><h2>Usuarios</h2><button className="btn-sm" onClick={() => setUserModal(true)}>+ Usuario</button></div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
                  <td>{u.full_name}</td><td>{u.email}</td><td>{ROLES[u.role]}</td>
                  <td className="right">
                    <button className="btn-sm btn-ghost" onClick={() => run(() => api.patch(`/catalog/users/${u.id}`, { is_active: !u.is_active })).then(reload)}>
                      {u.is_active ? 'Desactivar' : 'Activar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {lotModal && <LotModal lot={lotModal} onClose={() => setLotModal(null)} onDone={() => { setLotModal(null); reload(); }} />}
      {userModal && <UserModal onClose={() => setUserModal(false)} onDone={() => { setUserModal(false); reload(); }} />}
    </>
  );
}

function LotModal({ lot, onClose, onDone }) {
  const [f, set] = useForm({
    code: lot.code ?? '', name: lot.name ?? '', address_line: lot.address_line ?? '', city: lot.city ?? '',
    state: lot.state ?? '', phone: lot.phone ?? '', capacity: lot.capacity ?? '', is_active: lot.is_active ?? true,
  });
  const [run, busy] = useAction();
  const save = () => run(() => (lot.id ? api.patch(`/catalog/lots/${lot.id}`, f) : api.post('/catalog/lots', f)), 'Lote guardado').then((ok) => ok && onDone());
  return (
    <Modal size="sm" title={lot.id ? `Editar ${lot.code}` : 'Nuevo lote'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy} onClick={save}>Guardar</button></>}>
      <div className="grid g2">
        <Field label="Código"><input value={f.code} onChange={set('code')} /></Field>
        <Field label="Nombre"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Dirección"><input value={f.address_line} onChange={set('address_line')} /></Field>
        <Field label="Ciudad"><input value={f.city} onChange={set('city')} /></Field>
        <Field label="Estado">
          <select value={f.state} onChange={set('state')}>
            <option value="">—</option>
            {MX_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Capacidad" hint="unidades"><input type="number" value={f.capacity} onChange={set('capacity')} /></Field>
        <label className="check"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Activo</label>
      </div>
    </Modal>
  );
}

function UserModal({ onClose, onDone }) {
  const [f, set] = useForm({ full_name: '', email: '', phone: '', role: 'sales' });
  const [run, busy] = useAction();
  return (
    <Modal size="sm" title="Nuevo usuario" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy}
        onClick={() => run(() => api.post('/catalog/users', f), 'Usuario creado').then((ok) => ok && onDone())}>Crear</button></>}>
      <div className="grid">
        <Field label="Nombre completo"><input value={f.full_name} onChange={set('full_name')} /></Field>
        <Field label="Correo"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Rol">
          <select value={f.role} onChange={set('role')}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
      </div>
    </Modal>
  );
}
