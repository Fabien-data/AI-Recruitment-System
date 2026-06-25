import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getAdminStats, getAdminUsers,
  deleteAdminUser, getAuditLogs, updateAdminUser,
} from '../api'
import {
  Users, Briefcase, FolderKanban, UserCheck, Bell, ShieldCheck,
  Plus, Trash2, Edit2, Check, X, Clock, AlertCircle, Activity, BarChart3, KeyRound, UserPlus,
} from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import UserFormModal from '../components/admin/UserFormModal'

const ROLE_LABELS = {
  admin: 'Administrator',
  sourcing_department: 'Sourcing Dept.',
  project_handler: 'Project Handler',
  marketing_agent: 'Marketing Agent',
}

const ROLE_COLORS = {
  admin: 'bg-red-100 text-red-700',
  sourcing_department: 'bg-indigo-100 text-indigo-700',
  project_handler: 'bg-emerald-100 text-emerald-700',
  marketing_agent: 'bg-amber-100 text-amber-700',
}

const ACTION_TONE = {
  view:   { dot: 'bg-blue-400',    label: 'viewed' },
  create: { dot: 'bg-emerald-400', label: 'created' },
  update: { dot: 'bg-amber-400',   label: 'updated' },
  delete: { dot: 'bg-red-400',     label: 'deleted' },
  login:  { dot: 'bg-zinc-400',    label: 'logged in' },
  logout: { dot: 'bg-zinc-400',    label: 'logged out' },
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

const APPROVE_ROLES = [
  { value: 'marketing_agent', label: 'Marketing Agent' },
  { value: 'project_handler', label: 'Project Handler' },
  { value: 'sourcing_department', label: 'Sourcing Dept.' },
  { value: 'admin', label: 'Administrator' },
]

// One pending registration with an inline role picker + approve/reject.
function PendingRow({ user, onApprove, onReject, busy }) {
  const [role, setRole] = useState('marketing_agent')
  return (
    <tr className="hover:bg-amber-50/40 dark:hover:bg-amber-950/10 transition-colors">
      <td className="px-6 py-3 whitespace-nowrap font-semibold text-zinc-900 dark:text-zinc-100">{user.full_name}</td>
      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{user.email}</td>
      <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{user.phone || '—'}</td>
      <td className="px-4 py-3">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="px-2 py-1 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg"
        >
          {APPROVE_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onApprove(user.id, role)}>
            <Check size={14} /> Approve
          </Button>
          <button
            onClick={() => { if (window.confirm(`Reject ${user.full_name}'s registration?`)) onReject(user.id) }}
            className="p-1.5 text-zinc-400 hover:text-red-600 dark:hover:text-red-300 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            title="Reject registration"
          >
            <X size={15} />
          </button>
        </div>
      </td>
    </tr>
  )
}

function RoleBadge({ role }) {
  const dark = {
    admin: 'dark:bg-accent-950/40 dark:text-accent-300',
    sourcing_department: 'dark:bg-primary-950/40 dark:text-primary-300',
    project_handler: 'dark:bg-emerald-950/40 dark:text-emerald-300',
    marketing_agent: 'dark:bg-amber-950/40 dark:text-amber-300',
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
    refetchInterval: 30_000,
  })

  const users = usersData?.data ?? []
  const auditLogs = Array.isArray(auditData) ? auditData : auditData?.data ?? []

  // Modal state — single modal handles both create + edit.
  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState('create')
  const [editTarget, setEditTarget] = useState(null)

  const openCreate = () => { setEditTarget(null); setModalMode('create'); setModalOpen(true) }
  const openEdit   = (u) => { setEditTarget(u); setModalMode('edit'); setModalOpen(true) }

  const deleteMutation = useMutation({
    mutationFn: deleteAdminUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  const approveMutation = useMutation({
    mutationFn: ({ id, role }) => updateAdminUser(id, { approved: true, is_active: true, role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  // Self-registrations awaiting an admin decision (approved === false).
  const pendingUsers = users.filter((u) => u.approved === false)
  const activeUsers = users.filter((u) => u.approved !== false)

  return (
    <div className="space-y-8 py-6">
      <PageHeader
        icon={ShieldCheck}
        tone="mixed"
        title="Admin Dashboard"
        subtitle="System management & monitoring"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/admin/activity">
              <Button variant="secondary" size="sm">
                <Activity size={15} />
                Live Activity Monitor
              </Button>
            </Link>
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus size={15} />
              Add User
            </Button>
          </div>
        }
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

      {/* Pending registrations — awaiting admin approval */}
      {pendingUsers.length > 0 && (
        <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-amber-300/70 dark:border-amber-800/60 shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-6 py-5 border-b border-amber-100 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/10">
            <UserPlus size={18} className="text-amber-600 dark:text-amber-400" />
            <div>
              <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-50">Pending Approvals ({pendingUsers.length})</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                New sign-ups can't log in until you approve them and assign a role.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-6 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Assign role</th>
                  <th className="px-4 py-3 text-right">Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800/70">
                {pendingUsers.map((u) => (
                  <PendingRow
                    key={u.id}
                    user={u}
                    busy={approveMutation.isPending}
                    onApprove={(id, role) => approveMutation.mutate({ id, role })}
                    onReject={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* User Management */}
      <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-50">User Management</h2>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              Click a user to open their activity timeline and KPI report.
            </p>
          </div>
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 text-white text-sm font-semibold rounded-xl hover:bg-zinc-700 dark:hover:bg-white transition-colors"
          >
            <Plus size={15} />
            Add User
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider border-b border-zinc-100 dark:border-zinc-800">
                <th className="px-6 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Joined</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800/70">
              {activeUsers.map(u => (
                <tr key={u.id} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors">
                  <td className="px-6 py-3 whitespace-nowrap">
                    <Link
                      to={`/admin/users/${u.id}`}
                      className="font-semibold text-zinc-900 dark:text-zinc-100 hover:text-primary-600 dark:hover:text-primary-300 transition-colors"
                    >
                      {u.full_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{u.email}</td>
                  <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${u.is_active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-400 dark:text-zinc-500 text-xs whitespace-nowrap">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        to={`/admin/users/${u.id}`}
                        className="p-1.5 text-zinc-400 hover:text-primary-600 dark:hover:text-primary-300 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-950/30 transition-colors"
                        title="View activity & KPI"
                      >
                        <BarChart3 size={14} />
                      </Link>
                      <button
                        onClick={() => openEdit(u)}
                        className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        title="Edit user & permissions"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Deactivate ${u.full_name}?`)) {
                            deleteMutation.mutate(u.id)
                          }
                        }}
                        className="p-1.5 text-zinc-400 hover:text-red-600 dark:hover:text-red-300 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                        title="Deactivate user"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {activeUsers.length === 0 && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-zinc-400 dark:text-zinc-500 text-sm">No users found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Audit Log preview — full feed lives at /admin/activity */}
      <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-50">Recent Activity</h2>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">Last 30 system events — auto-refreshes every 30s.</p>
          </div>
          <Link
            to="/admin/activity"
            className="text-xs font-semibold text-primary-600 dark:text-primary-300 hover:underline flex items-center gap-1"
          >
            Open monitor
            <Activity size={12} />
          </Link>
        </div>
        <ul className="divide-y divide-zinc-50 dark:divide-zinc-800/70 max-h-96 overflow-y-auto custom-scrollbar">
          {auditLogs.map((log, i) => {
            const tone = ACTION_TONE[log.action] || { dot: 'bg-zinc-300', label: log.action }
            return (
              <li key={log.id || i} className="px-6 py-3 flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0 mt-0.5 relative">
                  <Clock size={13} className="text-zinc-400 dark:text-zinc-500" />
                  <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${tone.dot} ring-2 ring-white dark:ring-zinc-900`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    {log.user_id ? (
                      <Link
                        to={`/admin/users/${log.user_id}`}
                        className="font-semibold text-zinc-900 dark:text-zinc-100 hover:text-primary-600 dark:hover:text-primary-300"
                      >
                        {log.user_name || log.actor_name || 'Unknown user'}
                      </Link>
                    ) : (
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">System</span>
                    )}
                    {' '}
                    <span className="text-zinc-400 dark:text-zinc-500">{tone.label}</span>
                    {log.entity_type && (
                      <> <span className="font-medium text-zinc-700 dark:text-zinc-300">{log.entity_type}</span></>
                    )}
                    {log.section_key && (
                      <> in <span className="font-medium text-primary-600 dark:text-primary-300">{log.section_key.replace(/_/g, ' ')}</span></>
                    )}
                  </p>
                </div>
                <time className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap flex-shrink-0">
                  {log.created_at ? new Date(log.created_at).toLocaleString() : ''}
                </time>
              </li>
            )
          })}
          {auditLogs.length === 0 && (
            <li className="px-6 py-8 text-center text-zinc-400 dark:text-zinc-500 text-sm">No audit events found.</li>
          )}
        </ul>
      </section>

      <UserFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        mode={modalMode}
        user={editTarget}
      />
    </div>
  )
}
