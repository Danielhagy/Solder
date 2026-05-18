import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Builder from './pages/Builder';
import Runs from './pages/Runs';
import Docs from './pages/Docs';
import Integrations from './pages/Integrations';
import Connections from './pages/Connections';
import Sandboxes from './pages/Sandboxes';
import ProcessList from './pages/ProcessList';
import ProcessEditor from './pages/ProcessEditor';
import TopbarReview from './pages/internal/TopbarReview';
import NodeLibraryReview from './pages/internal/NodeLibraryReview';

export default function App() {
  return (
    <Routes>
      {/*
       * Internal design playground — not in the main nav. Mounted outside
       * <Layout> so the variants render against a clean page surface
       * without the production header competing with each preview tile.
       */}
      <Route path="/__design/topbar" element={<TopbarReview />} />
      <Route path="/__design/node-library" element={<NodeLibraryReview />} />

      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/integrations/:id" element={<Builder />} />
        <Route path="/processes" element={<ProcessList />} />
        <Route path="/processes/new" element={<ProcessEditor />} />
        <Route path="/processes/:id" element={<ProcessEditor />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/sandboxes" element={<Sandboxes />} />
        <Route path="/docs" element={<Docs />} />
        {/* Legacy redirect: old /history bookmarks resolve to /runs. */}
        <Route path="/history" element={<Navigate to="/runs" replace />} />
        {/* Legacy redirect: /mocks bookmarks resolve to /sandboxes (renamed
            in Sandboxes v1). Preserve any ?id=… or ?tab=… on the way through. */}
        <Route path="/mocks" element={<Navigate to="/sandboxes" replace />} />
        {/* Catch-all: anything unknown lands on the dashboard. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
