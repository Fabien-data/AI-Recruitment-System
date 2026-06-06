import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, AlertCircle, Sparkles } from 'lucide-react'
import toast from 'react-hot-toast'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import {
  createAdminUser, updateAdminUser,
  getUserPermissions, updateUserPermissions,
} from '../../api'
import SectionPermissionMatrix from './SectionPermissionMatrix'
import { baselineRows, lockedActions, mergeBaseline, extrasOf } from '../../constants/roleAccess'

const ROLE_OPTIONS = [
  { value: 'project_handler',     label: 'Project Handler',     desc: 'Pipeline ops — projects, applications, candidates, CV Manager, interviews; jobs view-only' },
  { value: 'sourcing_department', label: 'Sourcing Department', desc: 'Full operational access except admin panel' },
  { value: 'marketing_agent',     label: 'Marketing Agent',     desc: 'Onboard from chat — Marketing Hub, CV Manager, Messages; candidates & jobs (view)' },
  { value: 'admin',               label: 'Administrator',       desc: 'Full system control + observability' },
]

/**
 * UserFormModal
 * -------------
 *
 * One modal handles both create and edit flows.
 *
 *   mode === 'create' → blank form, POST /api/admin/users (with section_permissions
 *                        in the same request).
 *   mode === 'edit'   → pre-fills from /api/admin/users/:id/permissions, posts
 *                        profile changes to PUT /users/:id and permissions to
 *                        PUT /users/:id/permissions sequentially (so each call
 *                        stays a clean single-purpose endpoint).
 *
 * The permission matrix is hidden when role === 'admin' because admin overrides
 * all section permissions — making it look configurable would be misleading.
 */
export default function UserFormModal({ open, onClose, mode = 'create', user = null }) {
  const qc = useQueryClient()
  const isEdit = mode === 'edit' && !!user

  const [form, setForm] = useState({
    full_name: '', email: '', password: '', phone: '',
    role: 'project_handler',
  })
  const [permissions, setPermissions] = useState([])
  const [formError, setFormError] = useState(null)

  // Fetch permissions when editing — refetch on open so stale data never persists.
  const { data: permData, isLoading: loadingPerms } = useQuery({
    queryKey: ['admin', 'user-permissions', user?.id],
    queryFn: () => getUserPermissions(user.id),
    enabled: open && isEdit,
  })

  useEffect(() => {
    if (!open) return
    if (isEdit && user) {
      setForm({
        full_name: user.full_name || '',
        email:     user.email || '',
        password:  '', // never pre-fill — leave blank to keep existing
        phone:     user.phone || '',
        role:      user.role || 'project_handler',
      })
      setFormError(null)
    } else {
      setForm({ full_name: '', email: '', password: '', phone: '', role: 'project_handler' })
      // Pre-check the mandatory baseline for the default role (UPGRADES.md #2).
      setPermissions(baselineRows('project_handler'))
      setFormError(null)
    }
  }, [open, isEdit, user])

  useEffect(() => {
    if (permData?.permissions) {
      // Genuine extra grants beyond the role baseline (the rest is the floor,
      // applied server-side). Merge baseline + extras so the matrix shows the
      // mandatory rows locked-on plus any extras.
      const extras = permData.permissions.filter(p =>
        p.source === 'custom' && (p.can_view || p.can_create || p.can_edit || p.can_delete)
      )
      setPermissions(mergeBaseline(user?.role || 'project_handler', extras))
    }
  }, [permData, user])

  const createMutation = useMutation({
    mutationFn: createAdminUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      qc.invalidateQueries({ queryKey: ['admin-stats'] })
      toast.success('User created successfully')
      onClose?.()
    },
    onError: (err) => setFormError(err.response?.data?.error || 'Failed to create user'),
  })

  const updateMutation = useMutation({
    mutationFn: async () => {
      // 1. Profile update (only fields the admin actually changed)
      const updates = {}
      if (form.full_name !== user.full_name)  updates.full_name = form.full_name
      if (form.phone !== (user.phone || ''))  updates.phone = form.phone
      if (form.role !== user.role)            updates.role = form.role
      if (Object.keys(updates).length > 0) {
        await updateAdminUser(user.id, updates)
      }
      // 2. Permissions — persist only the EXTRA grants beyond the role baseline
      // (the baseline is enforced server-side as a floor, so we never store it).
      if (form.role !== 'admin') {
        await updateUserPermissions(user.id, extrasOf(form.role, permissions))
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      qc.invalidateQueries({ queryKey: ['admin', 'user-permissions', user.id] })
      toast.success('User updated successfully')
      onClose?.()
    },
    onError: (err) => setFormError(err.response?.data?.error || 'Failed to update user'),
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    setFormError(null)
    if (isEdit) {
      updateMutation.mutate()
      return
    }
    if (!form.full_name || !form.email || !form.password) {
      setFormError('Name, email and password are required')
      return
    }
    const payload = {
      full_name: form.full_name,
      email:     form.email,
      password:  form.password,
      phone:     form.phone || null,
      role:      form.role,
    }
    const extras = extrasOf(form.role, permissions)
    if (form.role !== 'admin' && extras.length > 0) {
      payload.section_permissions = extras
    }
    createMutation.mutate(payload)
  }

  const isAdminRole = form.role === 'admin'
  const submitting = createMutation.isPending || updateMutation.isPending

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={isEdit ? `Edit user — ${user?.full_name || user?.email}` : 'Create user'}
      size="xl"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Profile section */}
        <section>
          <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-3">
            Profile
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Full name"
              name="full_name"
              value={form.full_name}
              onChange={(e) => setForm(p => ({ ...p, full_name: e.target.value }))}
              required
            />
            <Input
              label="Email"
              type="email"
              name="email"
              value={form.email}
              onChange={(e) => setForm(p => ({ ...p, email: e.target.value }))}
              disabled={isEdit}
              required
            />
            <Input
              label={isEdit ? 'Password (leave blank to keep current)' : 'Password'}
              type="password"
              name="password"
              value={form.password}
              onChange={(e) => setForm(p => ({ ...p, password: e.target.value }))}
              autoComplete="new-password"
              required={!isEdit}
              disabled={isEdit}
            />
            <Input
              label="Phone (optional)"
              type="tel"
              name="phone"
              value={form.phone}
              onChange={(e) => setForm(p => ({ ...p, phone: e.target.value }))}
            />
          </div>
        </section>

        {/* Role picker */}
        <section>
          <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-3">
            Role template
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ROLE_OPTIONS.map(r => {
              const active = form.role === r.value
              return (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => { setForm(p => ({ ...p, role: r.value })); setPermissions(baselineRows(r.value)) }}
                  className={`group text-left rounded-2xl border p-3 transition-all
                    ${active
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/40 dark:border-primary-400 shadow-glow-blue/50'
                      : 'border-zinc-200/60 dark:border-zinc-800 hover:border-primary-300 dark:hover:border-primary-700 bg-white dark:bg-zinc-900'}`}
                >
                  <p className={`text-sm font-bold ${active ? 'text-primary-700 dark:text-primary-200' : 'text-zinc-900 dark:text-zinc-100'}`}>
                    {r.label}
                  </p>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">
                    {r.desc}
                  </p>
                </button>
              )
            })}
          </div>
        </section>

        {/* Permission matrix */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              Section permissions
            </h3>
            {!isAdminRole && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                <Sparkles size={12} className="text-primary-500" />
                Tick what this user can do per section. Empty = role defaults.
              </p>
            )}
          </div>

          {isAdminRole ? (
            <div className="flex items-start gap-3 rounded-2xl border border-primary-200 dark:border-primary-800/50 bg-primary-50 dark:bg-primary-950/30 p-4">
              <ShieldCheck className="text-primary-600 dark:text-primary-300 flex-shrink-0 mt-0.5" size={20} />
              <div>
                <p className="text-sm font-bold text-primary-900 dark:text-primary-100">Administrators have full access</p>
                <p className="text-xs text-primary-700 dark:text-primary-300 mt-0.5">
                  Section permissions don't apply to admin users — they implicitly have every action on every section.
                </p>
              </div>
            </div>
          ) : loadingPerms && isEdit ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-24 rounded-2xl border border-zinc-200/60 bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
              ))}
            </div>
          ) : (
            <SectionPermissionMatrix value={permissions} onChange={setPermissions} lockedActions={lockedActions(form.role)} />
          )}
        </section>

        {formError && (
          <div className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/30">
            <AlertCircle size={16} className="text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-200">{formError}</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <Button variant="secondary" type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={submitting}>
            {isEdit ? 'Save changes' : 'Create user'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
