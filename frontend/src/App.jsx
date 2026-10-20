import { createContext, useContext, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getUserId, setUserId } from './api.js';
import { useAsync } from './components/ui.jsx';
import Connect from './pages/Connect.jsx';
import Contacts from './pages/Contacts.jsx';
import ContactDetail from './pages/ContactDetail.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Import from './pages/Import.jsx';
import Ingestion from './pages/Ingestion.jsx';
import Inventory from './pages/Inventory.jsx';
import Leads from './pages/Leads.jsx';
import Partners from './pages/Partners.jsx';
import Sales from './pages/Sales.jsx';
import Settings from './pages/Settings.jsx';
import VehicleDetail from './pages/VehicleDetail.jsx';

// Catálogos compartidos (lotes, usuarios, marcas)
const LookupsCtx = createContext({ lots: [], users: [], makes: [], partners: [], reload: () => {} });
export const useLookups = () => useContext(LookupsCtx);

const NAV = [
  ['Operación', [['/', 'Tablero', '◧'], ['/inventario', 'Inventario', '▤'], ['/ventas', 'Ventas y apartados', '◈']]],
  ['CRM', [['/leads', 'Prospectos', '◎'], ['/contactos', 'Contactos', '◉']]],
  ['Datos', [['/mercado', 'Autos de agencias', '⇣'], ['/socios', 'Socios', '⇄'], ['/conectar', 'Conectar sistema externo', '⇌'], ['/importar', 'Migrar / importar', '⇪'], ['/config', 'Lotes y usuarios', '⚙']]],
];

export default function App() {
  const lookups = useAsync(async () => {
    const [lots, users, makes, partners] = await Promise.all([
      api.get('/catalog/lots'), api.get('/catalog/users'), api.get('/catalog/makes'), api.get('/partners'),
    ]);
    return { lots, users, makes, partners };
  }, []);
  const [userId, setUser] = useState(getUserId());

  const value = { ...(lookups.data ?? { lots: [], users: [], makes: [], partners: [] }), reload: lookups.reload, userId };

  return (
    <LookupsCtx.Provider value={value}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand"><span className="brand-mark">LC</span> LotesCRM</div>
          {NAV.map(([section, links]) => (
            <nav className="nav" key={section}>
              <div className="nav-section">{section}</div>
              {links.map(([to, label, icon]) => (
                <NavLink key={to} to={to} end={to === '/'}>
                  <span aria-hidden>{icon}</span> {label}
                </NavLink>
              ))}
            </nav>
          ))}
          <div className="sidebar-foot">
            <label className="field">
              <span style={{ color: '#8a929b' }}>Actuando como</span>
              <select value={userId} onChange={(e) => { setUserId(e.target.value); setUser(e.target.value); }}>
                <option value="">— Sin usuario —</option>
                {value.users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
          </div>
        </aside>
        <main className="main">
          {lookups.error && <div className="alert" style={{ marginBottom: 16 }}>
            No se pudo conectar con la API ({lookups.error.message}). ¿Está corriendo el backend en el puerto 4000?
          </div>}
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/inventario" element={<Inventory />} />
            <Route path="/inventario/:id" element={<VehicleDetail />} />
            <Route path="/ventas" element={<Sales />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/contactos" element={<Contacts />} />
            <Route path="/contactos/:id" element={<ContactDetail />} />
            <Route path="/socios" element={<Partners />} />
            <Route path="/conectar" element={<Connect />} />
            <Route path="/mercado" element={<Ingestion />} />
            <Route path="/importar" element={<Import />} />
            <Route path="/config" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </LookupsCtx.Provider>
  );
}
