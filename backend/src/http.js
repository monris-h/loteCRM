import { z } from 'zod';
import { parseNumber } from './services/normalize.js';

export class HttpError extends Error {
  /** `code` es un identificador estable para integraciones (p.ej. "not_available"). */
  constructor(status, message, details, code) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, `${what} no encontrado`, undefined, 'not_found');
export const conflict = (message, details, code = 'conflict') => new HttpError(409, message, details, code);

export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw new HttpError(400, 'Datos inválidos', result.error.flatten().fieldErrors, 'validation_error');
  }
  return result.data;
}

export function pageParams(q) {
  const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 500);
  const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
  return { limit, offset };
}

/** Usuario que realiza la acción (sin auth formal: header X-User-Id). */
export function currentUserId(req) {
  const id = req.get('x-user-id');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

// ---- Helpers de zod: los formularios mandan '' para "vacío" ----
const blank = (v) => (v === '' ? null : v);
// acepta "18,500", "$289,000.00", etc.; un texto no numérico queda como NaN y falla la validación
const toNumber = (v) => { v = blank(v); return v == null ? v : (parseNumber(v) ?? NaN); };
export const optStr = z.preprocess(blank, z.string().trim().nullable().optional());
export const optNum = z.preprocess(toNumber, z.number().finite().nullable().optional());
export const optInt = z.preprocess(toNumber, z.number().int().nullable().optional());
export const optUuid = z.preprocess(blank, z.string().uuid().nullable().optional());
export const optDate = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().optional());
export const optEnum = (values) => z.preprocess(blank, z.enum(values).nullable().optional());

const PG_ERRORS = {
  '23505': [409, 'Ya existe un registro con ese valor único'],
  '23503': [400, 'Referencia inválida (registro relacionado inexistente o en uso)'],
  '23514': [400, 'El valor no cumple una regla de validación'],
  '23502': [400, 'Falta un campo obligatorio'],
  '22P02': [400, 'Formato de dato inválido'],
  '22003': [400, 'Valor numérico fuera de rango'],
};

/** Convierte cualquier error en { status, body } con formato uniforme. */
export function toErrorResponse(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, code: err.code ?? `http_${err.status}`, details: err.details } };
  }
  if (err.code === 'P0001') {
    return { status: 409, body: { error: err.message, code: 'business_rule' } };
  }
  if (PG_ERRORS[err.code]) {
    const [status, message] = PG_ERRORS[err.code];
    const code = { 23505: 'duplicate', 23503: 'invalid_reference' }[err.code] ?? 'invalid_data';
    return { status, body: { error: message, code, details: err.detail ?? err.constraint } };
  }
  if (err.type === 'entity.parse.failed') {
    return { status: 400, body: { error: 'JSON inválido', code: 'invalid_json' } };
  }
  console.error(err);
  return { status: 500, body: { error: 'Error interno del servidor', code: 'internal_error' } };
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const { status, body } = toErrorResponse(err);
  res.status(status).json(body);
}
