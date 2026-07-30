import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import { useAuth } from './hooks/useAuth';

function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8">Завантаження...</div>;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
      <Route path="/*" element={user ? <DashboardPage /> : <Navigate to="/login" />} />
    </Routes>
  );
}

export default App;
