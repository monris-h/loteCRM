import { useEffect, useState } from 'react';
import { useLookups } from '../App.jsx';
import { api } from '../api.js';
import {
  BODY_TYPE, CONDITION, DRIVETRAIN, FUEL, TRANSMISSION,
} from '../format.js';
import { Field, Modal, Select, useAction, useForm } from './ui.jsx';

const EMPTY = {
  vin: '', make: '', model: '', year: new Date().getFullYear(), trim: '', body_type: '', exterior_color: '',
  interior_color: '', odometer: '', odometer_unit: 'km', fuel_type: '', transmission: '', drivetrain: '',
  engine: '', doors: '', seats: '', condition: 'used', plate_number: '', lot_id: '',
  acquisition_cost: '', acquisition_source: 'purchase', acquired_at: new Date().toISOString().slice(0, 10),
  list_price: '', min_price: '', status: 'incoming', description: '', features: '',
};

/** Alta / edición de vehículo. `vehicle` presente = edición. */
export default function VehicleForm({ vehicle, onClose, onSaved }) {
  const { lots, makes } = useLookups();
  const editing = Boolean(vehicle);
  const [values, set, setValues] = useForm(() => {
    if (!vehicle) return EMPTY;
    const v = { ...EMPTY };
    for (const k of Object.keys(EMPTY)) v[k] = vehicle[k] ?? '';
    v.features = (vehicle.features ?? []).join(', ');
    return v;
  });
  const [models, setModels] = useState([]);
  const [run, busy] = useAction();
  const [decoding, setDecoding] = useState(false);
  const [vinMsg, setVinMsg] = useState(null);

  // sugerencias de modelos según la marca escrita
  useEffect(() => {
    const mk = makes.find((m) => m.name.toLowerCase() === values.make.trim().toLowerCase());
    if (!mk) { setModels([]); return; }
    api.get(`/catalog/makes/${mk.id}/models`).then(setModels).catch(() => setModels([]));
  }, [values.make, makes]);

  async function decodeVin() {
    setDecoding(true);
    setVinMsg(null);
    try {
      const d = await api.get(`/catalog/vin/${encodeURIComponent(values.vin)}`);
      setValues((s) => {
        const next = { ...s };
        for (const [k, v] of Object.entries(d)) {
          if (k in next && v != null && v !== '') next[k] = String(v);
        }
        return next;
      });
      setVinMsg({ type: 'info', text: `NHTSA: ${d.make} ${d.model} ${d.year}${d.trim ? ` ${d.trim}` : ''}` });
    } catch (err) {
      setVinMsg({ type: 'warn', text: err.message });
    } finally {
      setDecoding(false);
    }
  }

  async function save() {
    const body = { ...values, features: values.features.split(',').map((s) => s.trim()).filter(Boolean) };
    if (editing) delete body.status;
    const saved = await run(
      () => (editing ? api.patch(`/vehicles/${vehicle.id}`, body) : api.post('/vehicles', body)),
      editing ? 'Vehículo actualizado' : 'Vehículo dado de alta');
    if (saved) onSaved?.(saved);
  }

  return (
    <Modal
      title={editing ? `Editar ${vehicle.stock_number}` : 'Nuevo vehículo'}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancelar</button>
        <button className="btn-primary" onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
      </>}
    >
      <div className="form-grid">
        <Field label="VIN" hint="17 caracteres" wide>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="mono" style={{ flex: 1 }} value={values.vin} onChange={set('vin')} maxLength={17} placeholder="3N1AB8CV7NY100504" />
            <button type="button" onClick={decodeVin} disabled={values.vin.length !== 17 || decoding}>
              {decoding ? 'Consultando…' : 'Decodificar (NHTSA)'}
            </button>
          </div>
        </Field>
        {vinMsg && <div className={`alert ${vinMsg.type} wide`}>{vinMsg.text}</div>}

        <Field label="Marca *">
          <input list="makes-list" value={values.make} onChange={set('make')} disabled={editing} />
          <datalist id="makes-list">{makes.map((m) => <option key={m.id} value={m.name} />)}</datalist>
        </Field>
        <Field label="Modelo *">
          <input list="models-list" value={values.model} onChange={set('model')} disabled={editing} />
          <datalist id="models-list">{models.map((m) => <option key={m.id} value={m.name} />)}</datalist>
        </Field>
        <Field label="Año *"><input type="number" value={values.year} onChange={set('year')} /></Field>
        <Field label="Versión"><input value={values.trim} onChange={set('trim')} /></Field>
        <Field label="Carrocería"><Select value={values.body_type} onChange={set('body_type')} options={BODY_TYPE} placeholder="—" /></Field>
        <Field label="Condición"><Select value={values.condition} onChange={set('condition')} options={CONDITION} /></Field>
        <Field label="Kilometraje">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input style={{ flex: 1 }} inputMode="numeric" value={values.odometer} onChange={set('odometer')} />
            <Select value={values.odometer_unit} onChange={set('odometer_unit')} options={{ km: 'km', mi: 'mi' }} />
          </div>
        </Field>
        <Field label="Transmisión"><Select value={values.transmission} onChange={set('transmission')} options={TRANSMISSION} placeholder="—" /></Field>
        <Field label="Combustible"><Select value={values.fuel_type} onChange={set('fuel_type')} options={FUEL} placeholder="—" /></Field>
        <Field label="Tracción"><Select value={values.drivetrain} onChange={set('drivetrain')} options={DRIVETRAIN} placeholder="—" /></Field>
        <Field label="Motor"><input value={values.engine} onChange={set('engine')} /></Field>
        <Field label="Color exterior"><input value={values.exterior_color} onChange={set('exterior_color')} /></Field>
        <Field label="Color interior"><input value={values.interior_color} onChange={set('interior_color')} /></Field>
        <Field label="Puertas"><input type="number" value={values.doors} onChange={set('doors')} /></Field>
        <Field label="Placas"><input value={values.plate_number} onChange={set('plate_number')} /></Field>
        <Field label="Lote">
          <select value={values.lot_id} onChange={set('lot_id')}>
            <option value="">— Sin asignar —</option>
            {lots.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
          </select>
        </Field>

        <Field label="Costo de adquisición"><input inputMode="decimal" value={values.acquisition_cost} onChange={set('acquisition_cost')} /></Field>
        <Field label="Origen">
          <Select value={values.acquisition_source} onChange={set('acquisition_source')}
            options={{ purchase: 'Compra', trade_in: 'A cuenta', auction: 'Subasta', consignment: 'Consignación', other: 'Otro' }} />
        </Field>
        <Field label="Fecha de compra"><input type="date" value={values.acquired_at} onChange={set('acquired_at')} /></Field>
        <Field label="Precio de lista"><input inputMode="decimal" value={values.list_price} onChange={set('list_price')} /></Field>
        <Field label="Precio mínimo" hint="piso de negociación"><input inputMode="decimal" value={values.min_price} onChange={set('min_price')} /></Field>
        {!editing && (
          <Field label="Estado inicial">
            <Select value={values.status} onChange={set('status')}
              options={{ incoming: 'En tránsito', reconditioning: 'En preparación', available: 'Disponible' }} />
          </Field>
        )}
        <Field label="Equipamiento" hint="separado por comas" wide>
          <input value={values.features} onChange={set('features')} placeholder="Cámara de reversa, Apple CarPlay" />
        </Field>
        <Field label="Descripción" wide><textarea value={values.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}
