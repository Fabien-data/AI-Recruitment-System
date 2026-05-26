import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getAdminStats, getAdminUsers, createAdminUser,
  updateAdminUser, deleteAdminUser, getAuditLogs,
} from '../api'
import {
  Users, Briefcase, FolderKanban, UserCheck, Bell, ShieldCheck,
  Plus, Trash2, Edit2, Check, X, Clock, AlertCircle,
} from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'

const ROLE_LABELS = {
  admin: 'Administrator',
  sourcing_department: 'Sourcing Dept.',
  project_handler: 'Project Handler',
}

const ROLE_COLORS = {
  admin: 'bg-red-100 text-red-700',
  sourcing_department: 'bg-indigo-100 text-indigo-700',
  project_handler: 'bg-emerald-100 text-emerald-700',
}

function StatCard({ icon: Icon, label, value, sub, color = 'bg-zinc-900 text-white' }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800/70 p-6 flex items-start gap-4 shadow-sm hover:shadow-md transition-shadow">
      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon size={20} />
      </div>
      <div>
        <p className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-0.5">{label}</p>
        <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50 tracking-tight">{value ?? '—'}</p>
        {sub && <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function RoleBadge({ role }) {
  const dark = {
    admin: 'dark:bg-accent-950/40 dark:text-accent-300',
    sourcing_department: 'dark:bg-primary-950/40 dark:text-primary-300',
    project_handler: 'dark:bg-emerald-950/40 dark:text-emerald-300',
  }[role] || 'dark:bg-zinc-800 dark:text-zinc-300'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${ROLE_COLORS[role] || 'bg-zinc-100 text-zinc-600'} ${dark}`}>
      {ROLE_LABELS[role] || role}
    </span>
  )
}

export default function AdminDashboard() {
  const qc = useQueryClient()

  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: getAdminStats })
  const { data: usersData } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => getAdminUsers({ limit: 100 }),
  })
  const { data: auditData } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () => getAuditLogs({ limit: 30 }),
  })

  const users = usersData?.data ?? []
  const auditLogs = auditData?.data ?? []

  // ── Add user form ───────────────────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false)
  const [newUser, setNewUser] = useState({ full_name: '', email: '', password: '', role: 'project_handler' })
  const [formError, setFormError] = useState(null)

  const createMutation = useMutation({
    mutationFn: createAdminUser,
    onSuccess: () => {
      qc.invalidateQueries(['admin-users'])
      setShowAddForm(false)
      setNewUser({ full_name: '', email: '', password: '', role: 'project_handler' })
      setFormError(null)
    },
    onError: (err) => setFormError(err.response?.data?.error || 'Failed to create user'),
  })

  // ── Inline role edit ────────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState(null)
  const [editRole, setEditRole] = useState('')

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateAdminUser(id, data),
    onSuccess: () => {
      qc.invalidateQueries(['admin-users'])
      setEditingId(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteAdminUser,
    onSuccess: () => qc.invalidateQueries(['admin-users']),
  })

  const handleSubmitNewUser = (e) => {
    e.preventDefault()
    if (!newUser.full_name || !newUser.email || !newUser.password) {
      setFormError('Name, email and password are required')
      return
    }
    createMutation.mutate(newUser)
  }

  return (
    <div className="space-y-8 py-6">
      <PageHeader
        icon={ShieldCheck}
        tone="mixed"
        title="Admin Dashboard"
        subtitle="System management & monitoring"
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard icon={Users} label="Candidates" value={stats?.candidates_total} color="bg-brand-gradient text-white shadow-glow-blue" />
        <StatCard icon={Briefcase} label="Active Jobs" value={stats?.jobs_active} color="bg-gradient-to-br from-amber-400 to-amber-600 text-white" />
        <StatCard icon={FolderKanban} label="Projects" value={stats?.projects_active} color="bg-gradient-to-br from-violet-500 to-purple-700 text-white" />
        <StatCard icon={UserCheck} label="Hired (30d)" value={stats?.hired_last_30_days} color="bg-gradient-to-br from-emerald-400 to-emerald-600 text-white" />
        <StatCard icon={AlertCircle} label="Interventions" value={stats?.open_interventions} color="bg-accent-gradient text-white shadow-glow-red" />
        <StatCard icon={Users} label="Active Users" value={stats?.users_active} sub={`of ${stats?.users_total} total`} color="bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900" />
      </div>

      {/* Notification Stats */}
      {stats?.notifications && (
        <div className="grid grid-cols-3 gap-4">
          <StatCard icon={Bell} label="Pending Notifications" value={stats.notifications.pending} color="bg-zinc-100 text-zinc-500" />
          <StatCard icon={Check} label="Sent Notifications" value={stats.notifications.sent} color="bg-emerald-100 text-emerald-600" />
          <StatCard icon={X} label="Failed Notifications" value={stats.notifications.failed} color="bg-red-100 text-red-600" />
        </div>
      )}

      {/* User Management */}
      <section className="bg-white rounded-3xl border border-zinc-200/60 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-100">
          <h2 className="text-base font-bold text-zinc-900">User Management</h2>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 text-white text-sm font-semibold rounded-xl hover:bg-zinc-700 transition-colors"
          >
            <Plus size={15} />
            Add User
          </button>
        </div>

        {/* Add user form */}
        {showAddForm && (
          <form onSubmit={handleSubmitNewUser} className="px-6 py-4 bg-zinc-50 border-b border-zinc-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <input
              type="text"
              placeholder="Full name"
              value={newUser.full_name}
              onChange={e => setNewUser(p => ({ ...p, full_name: e.target.value }))}
              className="px-3 py-2 text-sm border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
            <input
              type="email"
              placeholder="Email"
              value={newUser.email}
              onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))}
              className="px-3 py-2 text-sm border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
            <input
              type="password"
              placeholder="Password"
              value={newUser.password}
              onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
              className="px-3 py-2 text-sm border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
            <select
              value={newUser.role}
              onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
              className="px-3 py-2 text-sm border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900"
            >
              <option value="project_handler">Project Handler</option>
              <option value="sourcing_department">Sourcing Dept.</option>
              <option value="admin">Administrator</option>
            </select>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="flex-1 px-3 py-2 bg-zinc-900 text-white text-sm font-semibold rounded-xl hover:bg-zinc-700 disabled:opacity-50 transition-colors"
              >
                {createMutation.isPending ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddForm(false); setFormError(null) }}
                className="px-3 py-2 text-sm text-zinc-500 border border-zinc-200 rounded-xl hover:bg-zinc-100 transition-colors"
              >
                <X size={15} />
              </button>
            </div>
            {formError && <p className="col-span-full text-sm text-red-600">{formError}</p>}
          </form>
        )}

        {/* Users table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-b border-zinc-100">
                <th className="px-6 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Joined</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {users.map(u => (
                <tr key={u.id} className="hover:bg-zinc-50/50 transition-colors">
                  <td className="px-6 py-3 font-semibold text-zinc-900 whitespace-nowrap">{u.full_name}</td>
                  <td className="px-4 py-3 text-zinc-500 whitespace-nowrap">{u.email}</td>
                  <td className="px-4 py-3">
                    {editingId === u.id ? (
                      <div className="flex items-center gap-1">
                        <select
                          value={editRole}
                          onChange={e => setEditRole(e.target.value)}
                          className="text-xs border border-zinc-300 rounded-lg px-1.5 py-1 focus:outline-none"
                        >
                          <option value="project_handler">Project Handler</option>
                          <option value="sourcing_department">Sourcing Dept.</option>
                          <option value="admin">Administrator</option>
                        </select>
                        <button
                          onClick={() => updateMutation.mutate({ id: u.id, data: { role: editRole } })}
                          className="p-1 text-emerald-600 hover:text-emerald-800"
                        ><Check size={14} /></button>
                        <button onClick={() => setEditingId(null)} className="p-1 text-zinc-400 hover:text-zinc-600">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <RoleBadge role={u.role} />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-400 text-xs whitespace-nowrap">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => { setEditingId(u.id); setEditRole(u.role) }}
                        className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100 transition-colors"
                        title="Edit role"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Deactivate ${u.full_name}?`)) {
                            deleteMutation.mutate(u.id)
                          }
                        }}
                        className="p-1.5 text-zinc-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
                        title="Deactivate user"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-zinc-400 text-sm">No users found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Audit Log */}
      <section className="bg-white rounded-3xl border border-zinc-200/60 shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-zinc-100">
          <h2 className="text-base font-bold text-zinc-900">Recent Activity</h2>
          <p className="text-xs text-zinc-400 mt-0.5">Last 30 system events</p>
        </div>
        <ul className="divide-y divide-zinc-50 max-h-96 overflow-y-auto">
          {auditLogs.map((log, i) => (
            <li key={log.id || i} className="px-6 py-3 flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-zinc-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Clock size={13} className="text-zinc-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-700">
                  <span className="font-semibold text-zinc-900">{log.user_name || 'System'}</span>
                  {' '}
                  <span className="text-zinc-400">{log.action}</span>
                  {log.entity_type && (
                    <> on <span className="font-medium text-zinc-700">{log.entity_type}</span></>
                  )}
                </p>
                {log.details && <p className="text-xs text-zinc-400 mt-0.5 truncate">{typeof log.details === 'string' ? log.details : JSON.stringify(log.details)}</p>}
              </div>
              <time className="text-xs text-zinc-400 whitespace-nowrap flex-shrink-0">
                {log.created_at ? new Date(log.created_at).toLocaleString() : ''}
              </time>
            </li>
          ))}
          {auditLogs.length === 0 && (
            <li className="px-6 py-8 text-center text-zinc-400 text-sm">No audit events found.</li>
          )}
        </ul>
      </section>
    </div>
  )
}
