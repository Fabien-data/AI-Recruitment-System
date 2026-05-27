import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Component } from 'react'
import { useAuthStore } from './stores/authStore'
import { ErrorBoundary as LocalErrorBoundary } from './components/ui/ErrorBoundary'
import Layout from './components/Layout'
import RoleGuard from './components/RoleGuard'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
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
import CVManager from './pages/CVManager'
import Communications from './pages/Communications'
import Interviews from './pages/Interviews'
import Analytics from './pages/Analytics'
import KnowledgeBase from './pages/KnowledgeBase'
import MarketingHub from './pages/MarketingHub'
import LeadIntake from './pages/LeadIntake'
import LeadDetail from './pages/LeadDetail'
import MarketingAnalytics from './pages/MarketingAnalytics'
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
  return isAuthenticated ? children : <Navigate to="/login" replace />
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
        <Route index element={<Dashboard />} />
        <Route path="candidates" element={<RouteBoundary name="Candidates"><Candidates /></RouteBoundary>} />
        <Route path="candidates/:id" element={<RouteBoundary name="CandidateDetail"><CandidateDetail /></RouteBoundary>} />
        <Route path="jobs" element={<RouteBoundary name="Jobs"><Jobs /></RouteBoundary>} />
        <Route path="jobs/:id" element={<RouteBoundary name="JobDetail"><JobDetail /></RouteBoundary>} />
        <Route path="jobs/:jobId/candidates" element={<RouteBoundary name="JobCandidates"><JobCandidates /></RouteBoundary>} />
        <Route path="projects" element={<RouteBoundary name="Projects"><Projects /></RouteBoundary>} />
        <Route path="projects/:id" element={<RouteBoundary name="ProjectDetail"><ProjectDetail /></RouteBoundary>} />
        <Route path="general-pool" element={<RouteBoundary name="GeneralPool"><GeneralPool /></RouteBoundary>} />
        <Route path="applications" element={<RouteBoundary name="Applications"><Applications /></RouteBoundary>} />
        <Route path="cv-manager" element={<RouteBoundary name="CVManager"><CVManager /></RouteBoundary>} />
        <Route path="communications" element={<RouteBoundary name="Communications"><Communications /></RouteBoundary>} />
        <Route path="interviews" element={<RouteBoundary name="Interviews"><Interviews /></RouteBoundary>} />
        <Route path="analytics" element={<RouteBoundary name="Analytics"><Analytics /></RouteBoundary>} />
        <Route path="knowledge-base" element={<RouteBoundary name="KnowledgeBase"><KnowledgeBase /></RouteBoundary>} />
        <Route path="marketing-hub" element={
          <RoleGuard allowedRoles={['admin', 'sourcing_department', 'marketing_agent']} fallback={<Navigate to="/" replace />}>
            <MarketingHub />
          </RoleGuard>
        } />
        <Route path="marketing-hub/new" element={
          <RoleGuard allowedRoles={['admin', 'sourcing_department', 'marketing_agent']} fallback={<Navigate to="/" replace />}>
            <LeadIntake />
          </RoleGuard>
        } />
        <Route path="marketing-hub/analytics" element={
          <RoleGuard allowedRoles={['admin', 'sourcing_department']} fallback={<Navigate to="/marketing-hub" replace />}>
            <MarketingAnalytics />
          </RoleGuard>
        } />
        <Route path="marketing-hub/:id" element={
          <RoleGuard allowedRoles={['admin', 'sourcing_department', 'marketing_agent']} fallback={<Navigate to="/" replace />}>
            <LeadDetail />
          </RoleGuard>
        } />
        <Route path="admin" element={
          <RoleGuard allowedRoles={['admin']} fallback={<Navigate to="/" replace />}>
            <AdminDashboard />
          </RoleGuard>
        } />
        <Route path="admin/activity" element={
          <RoleGuard allowedRoles={['admin']} fallback={<Navigate to="/" replace />}>
            <ActivityMonitor />
          </RoleGuard>
        } />
        <Route path="admin/users/:id" element={
          <RoleGuard allowedRoles={['admin']} fallback={<Navigate to="/" replace />}>
            <UserDetail />
          </RoleGuard>
        } />
        <Route path="admin/users/:id/report" element={
          <RoleGuard allowedRoles={['admin']} fallback={<Navigate to="/" replace />}>
            <UserKpiReport />
          </RoleGuard>
        } />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ErrorBoundary>
  )
}

export default App

