import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Builder from './pages/Builder';
import Runs from './pages/Runs';
import Docs from './pages/Docs';
import Integrations from './pages/Integrations';
import Connections from './pages/Connections';
import Mocks from './pages/Mocks';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/integrations/:id" element={<Builder />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/mocks" element={<Mocks />} />
        <Route path="/docs" element={<Docs />} />
        {/* Legacy redirect: old /history bookmarks resolve to /runs. */}
        <Route path="/history" element={<Navigate to="/runs" replace />} />
        {/* Catch-all: anything unknown lands on the dashboard. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
