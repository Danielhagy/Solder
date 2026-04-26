import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Builder from './pages/Builder';
import History from './pages/History';
import Docs from './pages/Docs';
import Integrations from './pages/Integrations';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Builder />} />
        <Route path="/history" element={<History />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/integrations" element={<Integrations />} />
      </Route>
    </Routes>
  );
}
