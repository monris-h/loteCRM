const BASE = import.meta.env.VITE_API_URL ?? '/api';

export function getUserId() {
  try {
    return localStorage.getItem('lotescrm.userId') ?? '';
  } catch {
    return '';
  }
}

export function setUserId(id) {
  try {
    localStorage.setItem('lotescrm.userId', id);
  } catch {
    /* almacenamiento no disponible */
  }
}

async function request(method, path, body, { form = false } = {}) {
  const headers = {};
  const userId = getUserId();
  if (userId) headers['X-User-Id'] = userId;
  let payload;
  if (form) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error ?? `Error ${res.status}`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  upload: (path, formData) => request('POST', path, formData, { form: true }),
};

/** { a: 1, b: '' } -> "?a=1" (omite vacíos) */
export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null && v !== false) p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
