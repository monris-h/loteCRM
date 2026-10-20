import { useEffect, useState } from 'react';
import { api, qs } from '../api.js';

/** Buscador de contactos con alta rápida. value = contact id. */
export default function ContactPicker({ value, onChange, initialLabel }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [label, setLabel] = useState(initialLabel ?? '');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ first_name: '', last_name: '', phone: '', email: '' });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (value && !q) return;
    const t = setTimeout(() => {
      api.get(`/contacts${qs({ q, limit: 8 })}`).then((r) => setItems(r.items)).catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, value]);

  if (value && !creating) {
    return (
      <div className="row" style={{ justifyContent: 'space-between', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px' }}>
        <b>{label || 'Contacto seleccionado'}</b>
        <button type="button" className="btn-sm btn-ghost" onClick={() => { onChange(''); setLabel(''); }}>Cambiar</button>
      </div>
    );
  }

  if (creating) {
    const save = async () => {
      setError(null);
      try {
        const c = await api.post('/contacts', draft);
        setLabel(`${c.first_name} ${c.last_name ?? ''}`.trim());
        setCreating(false);
        onChange(c.id);
      } catch (err) {
        setError(err.message);
      }
    };
    return (
      <div className="card" style={{ padding: 12, boxShadow: 'none' }}>
        <div className="form-grid">
          {[['first_name', 'Nombre *'], ['last_name', 'Apellidos'], ['phone', 'Teléfono'], ['email', 'Correo']].map(([k, l]) => (
            <label className="field" key={k}><span>{l}</span>
              <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            </label>
          ))}
        </div>
        {error && <div className="alert" style={{ marginTop: 10 }}>{error}</div>}
        <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-sm" onClick={() => setCreating(false)}>Cancelar</button>
          <button type="button" className="btn-sm btn-primary" onClick={save}>Crear contacto</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input style={{ flex: 1 }} placeholder="Buscar por nombre, teléfono o correo…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn-sm" onClick={() => setCreating(true)}>+ Nuevo</button>
      </div>
      <div style={{ border: '1px solid var(--line-2)', borderRadius: 8, marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
        {items.map((c) => (
          <button type="button" key={c.id} className="btn-ghost" style={{ width: '100%', justifyContent: 'space-between', borderRadius: 0 }}
            onClick={() => { setLabel(c.display_name); setQ(''); onChange(c.id); }}>
            <span>{c.display_name}</span><span className="muted small">{c.phone ?? c.email ?? ''}</span>
          </button>
        ))}
        {items.length === 0 && <div className="muted small" style={{ padding: 10 }}>Sin resultados</div>}
      </div>
    </div>
  );
}
