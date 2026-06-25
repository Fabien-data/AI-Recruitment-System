import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Component, lazy, Suspense } from 'react'
import { useAuthStore } from './stores/authStore'
import { ErrorBoundary as LocalErrorBoundary } from './components/ui/ErrorBoundary'
import Layout from './components/Layout'
import RoleGuard from './components/RoleGuard'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Home from './pages/Home'
import AdminDashboard from './pages/AdminDashboard'
import ActivityMonitor from './pages/admin/ActivityMonitor'
import UserDetail from './pages/admin/UserDetail'
import UserKpiReport from './pages/admin/UserKpiReport'
import Candidates from './pages/Candidates'
import CandidateDetail from './pages/CandidateDetail'
import Jobs from './pages/Jobs'
import JobDetail from './pages/JobDetail'
import JobCandidates from './pages/JobCandidates'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import GeneralPool from './pages/GeneralPool'
import Applications from './pages/Applications'
// Lazy — pulls in SheetJS (xlsx) + fflate, ~700KB, only when the importer opens.
const BulkImport = lazy(() => import('./pages/BulkImport'))
import CVManager from './pages/CVManager'
import Communications from './pages/Communications'
import Interviews from './pages/Interviews'
import Engagement from './pages/Engagement'
import Analytics from './pages/Analytics'
import SourcingControlTower from './pages/SourcingControlTower'
import KnowledgeBase from './pages/KnowledgeBase'
import './App.css'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    console.error('App ErrorBoundary caught:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
          <h2 style={{ color: '#dc2626' }}>Something went wrong</h2>
          <pre style={{ background: '#fee2e2', padding: '1rem', borderRadius: '0.5rem', overflow: 'auto', fontSize: '0.875rem' }}>
            {this.state.error?.toString()}
            {'\n\nStack:\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
            style={{ marginTop: '1rem', padding: '0.5rem 1rem', background: '#2563eb', color: '#fff', borderRadius: '0.375rem', border: 'none', cursor: 'pointer' }}
          >
            Reload page
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function PrivateRoute({ children }) {
  const { isAuthenticated } = useAuthStore()
  const location = useLocation()
  // Preserve the intended URL (incl. query string) so deep-links survive the login
  // redirect — e.g. a 3CX screen-pop to /communications?phoneNumber=… opened in a
  // tab with an expired session lands back on the right chat after sign-in.
  return isAuthenticated ? children : <Navigate to="/login" replace state={{ from: location }} />
}

// Wrap each route in a per-pathname boundary so a crash on one page can be
// recovered by navigating away (or hitting "Try again") instead of locking
// the whole app behind the top-level fallback.
function RouteBoundary({ children, name }) {
  const location = useLocation()
  return (
    <LocalErrorBoundary resetKey={location.pathname} name={name || location.pathname}>
      {children}
    </LocalErrorBoundary>
  )
}

function App() {
  return (
    <ErrorBoundary>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      <Route path="/" element={
        <PrivateRoute>
          <Layout />
        </PrivateRoute>
      }>
        {/* Every route is guarded by its section + action (UPGRADES.md #2).
            Unauthorized direct-URL access redirects to the dashboard with a
            "no access" toast (RoleGuard default deny). Dashboard is universal. */}
        <Route index element={
          <RoleGuard requireSection="dashboard" action="view">
            <RouteBoundary name="Home"><Home /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="candidates" element={
          <RoleGuard requireSection="candidates" action="view">
            <RouteBoundary name="Candidates"><Candidates /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="candidates/:id" element={
          <RoleGuard requireSection="candidates" action="view">
            <RouteBoundary name="CandidateDetail"><CandidateDetail /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="jobs" element={
          <RoleGuard requireSection="jobs" action="view">
            <RouteBoundary name="Jobs"><Jobs /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="jobs/:id" element={
          <RoleGuard requireSection="jobs" action="view">
            <RouteBoundary name="JobDetail"><JobDetail /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="jobs/:jobId/candidates" element={
          <RoleGuard requireSection="candidates" action="view">
            <RouteBoundary name="JobCandidates"><JobCandidates /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="projects" element={
          <RoleGuard requireSection="projects" action="view">
            <RouteBoundary name="Projects"><Projects /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="projects/:id" element={
          <RoleGuard requireSection="projects" action="view">
            <RouteBoundary name="ProjectDetail"><ProjectDetail /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="general-pool" element={
          <RoleGuard requireSection="general_pool" action="view">
            <RouteBoundary name="GeneralPool"><GeneralPool /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="applications" element={
          <RoleGuard requireSection="applications" action="view">
            <RouteBoundary name="Applications"><Applications /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="applications/import" element={
          <RoleGuard requireSection="applications" action="create">
            <RouteBoundary name="BulkImport">
              <Suspense fallback={<div className="p-8 text-sm text-zinc-500">Loading importer…</div>}>
                <BulkImport />
              </Suspense>
            </RouteBoundary>
          </RoleGuard>
        } />
        <Route path="cv-manager" element={
          <RoleGuard requireSection="cv_manager" action="view">
            <RouteBoundary name="CVManager"><CVManager /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="communications" element={
          <RoleGuard requireSection="communications" action="view">
            <RouteBoundary name="Communications"><Communications /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="interviews" element={
          <RoleGuard requireSection="interviews" action="view">
            <RouteBoundary name="Interviews"><Interviews /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="engagement" element={
          <RoleGuard requireSection="engagement" action="view">
            <RouteBoundary name="Engagement"><Engagement /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="analytics" element={
          <RoleGuard requireSection="analytics" action="view">
            <RouteBoundary name="Analytics"><Analytics /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="control-tower" element={
          <RoleGuard requireSection="control_tower" action="view">
            <RouteBoundary name="ControlTower"><SourcingControlTower /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="knowledge-base" element={
          <RoleGuard requireSection="knowledge_base" action="view">
            <RouteBoundary name="KnowledgeBase"><KnowledgeBase /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="admin" element={
          <RoleGuard allowedRoles={['admin']}>
            <RouteBoundary name="AdminDashboard"><AdminDashboard /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="admin/activity" element={
          <RoleGuard allowedRoles={['admin']}>
            <RouteBoundary name="ActivityMonitor"><ActivityMonitor /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="admin/users/:id" element={
          <RoleGuard allowedRoles={['admin']}>
            <RouteBoundary name="UserDetail"><UserDetail /></RouteBoundary>
          </RoleGuard>
        } />
        <Route path="admin/users/:id/report" element={
          <RoleGuard allowedRoles={['admin']}>
            <RouteBoundary name="UserKpiReport"><UserKpiReport /></RouteBoundary>
          </RoleGuard>
        } />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ErrorBoundary>
  )
}

export default App

