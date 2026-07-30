import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import ChannelsPage from './pages/Channels';
import TestChatPage from './pages/TestChat';
import MessagesPage from './pages/Messages';
import RoutingPage from './pages/Routing';
import DeliveriesPage from './pages/Deliveries';
import AlertsPage from './pages/Alerts';
import ApiTokensPage from './pages/ApiTokens';
import LogsPage from './pages/Logs';
import Layout from './components/Layout';
import { useAuth } from './hooks/useAuth';

function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8">Завантаження...</div>;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
      <Route element={user ? <Layout /> : <Navigate to="/login" />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/chat" element={<TestChatPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/routing" element={<RoutingPage />} />
        <Route path="/deliveries" element={<DeliveriesPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/api" element={<ApiTokensPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Route>
    </Routes>
  );
}

export default App;
