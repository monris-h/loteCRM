import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { LEAD_STATUS, SALE_STATUS, VEHICLE_STATUS } from '../format.js';

/** Carga datos asíncronos y expone { data, loading, error, reload }. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await run(), loading: false, error: null });
    } catch (error) {
      setState({ data: null, loading: false, error });
    }
  }, [run]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

// ---------------- Toasts ----------------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const notify = useCallback((message, type = 'ok') => {
    const id = Math.random();
    setItems((xs) => [...xs, { id, message, type }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={notify}>
      {children}
      <div className="toasts" role="status">
        {items.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Ejecuta una acción mostrando toast de éxito/error. Devuelve el resultado o undefined. */
export function useAction() {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, successMsg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (successMsg) notify(successMsg);
      return r ?? true;
    } catch (err) {
      notify(err.message, 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [notify]);
  return [run, busy];
}

// ---------------- Componentes ----------------
export function Modal({ title, onClose, children, footer, size }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, wide }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span>{label} {hint && <span className="hint">· {hint}</span>}</span>
      {children}
    </label>
  );
}

export function Select({ value, onChange, options, placeholder, ...rest }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </select>
  );
}

const ALL_LABELS = { ...VEHICLE_STATUS, ...LEAD_STATUS, ...SALE_STATUS,
  success: 'Éxito', partial: 'Parcial', failed: 'Falló', running: 'En curso',
  active: 'Activo', converted: 'Convertido', expired: 'Vencido' };

export function StatusBadge({ status, label }) {
  return <span className={`badge st-${status}`}>{label ?? ALL_LABELS[status] ?? status}</span>;
}

export function Loading() {
  return <div className="empty">Cargando…</div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="alert">{error.message}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/** Formulario simple: estado de objeto + setter por campo. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const set = useCallback((key) => (eOrValue) => {
    const v = eOrValue?.target ? (eOrValue.target.type === 'checkbox' ? eOrValue.target.checked : eOrValue.target.value) : eOrValue;
    setValues((s) => ({ ...s, [key]: v }));
  }, []);
  return [values, set, setValues];
}
