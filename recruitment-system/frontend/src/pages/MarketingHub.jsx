import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search, Phone, Flame, BarChart2, ChevronLeft, ChevronRight, Megaphone } from 'lucide-react'
import { getLeads, getLeadSources } from '../api'
import { useRole } from '../stores/authStore'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { TableSkeleton } from '../components/ui/Skeleton'
import { PageHeader } from '../components/ui/PageHeader'

const STAGE_OPTIONS = [
  { value: '', label: 'All stages' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'converted', label: 'Converted' },
  { value: 'lost', label: 'Lost' },
]

const STAGE_BADGE_STATUS = {
  new: 'new',
  contacted: 'screening',
  qualified: 'interview',
  converted: 'hired',
  lost: 'rejected',
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function MarketingHub() {
  const navigate = useNavigate()
  const { hasFullAnalytics } = useRole()
  const [stage, setStage] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const limit = 20

  // Debounce search input.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const params = {
    page,
    limit,
    stage: stage || undefined,
    source_id: sourceId || undefined,
    search: debouncedSearch || undefined,
  }

  const { data, isLoading } = useQuery({
    queryKey: ['marketing-hub', 'leads', params],
    queryFn: () => getLeads(params),
    keepPreviousData: true,
  })

  const { data: sources = [] } = useQuery({
    queryKey: ['marketing-hub', 'sources'],
    queryFn: getLeadSources,
    staleTime: 5 * 60 * 1000,
  })

  const leads = data?.data || []
  const pagination = data?.pagination

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={Megaphone}
        tone="red"
        title="Marketing Hub"
        subtitle="Lead capture and qualification for the call-handling team."
        actions={
          <>
            {hasFullAnalytics && (
              <Button variant="secondary" onClick={() => navigate('/marketing-hub/analytics')}>
                <BarChart2 size={16} /> Analytics
              </Button>
            )}
            <Button variant="accent" onClick={() => navigate('/marketing-hub/new')}>
              <Plus size={16} /> New Lead
            </Button>
          </>
        }
      />

      {/* Filters */}
      <Card className="p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative md:col-span-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, NIC…"
              className="w-full pl-9 pr-3 py-2 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 text-sm"
            />
          </div>
          <select
            value={stage}
            onChange={(e) => { setStage(e.target.value); setPage(1) }}
            className="px-3 py-2 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 text-sm"
          >
            {STAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            value={sourceId}
            onChange={(e) => { setSourceId(e.target.value); setPage(1) }}
            className="px-3 py-2 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 text-sm"
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="p-4"><TableSkeleton rows={8} cols={6} /></div>
        ) : leads.length === 0 ? (
          <div className="p-12 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-zinc-100 mb-3">
              <Phone size={20} className="text-zinc-400 dark:text-zinc-500" />
            </div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">No leads yet</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 dark:text-zinc-500 mt-1">Press <strong>New Lead</strong> to register a caller.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900/60/70 text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
                <tr>
                  <th className="text-left font-semibold px-4 py-3">Name</th>
                  <th className="text-left font-semibold px-4 py-3">Phone</th>
                  <th className="text-left font-semibold px-4 py-3">Source</th>
                  <th className="text-left font-semibold px-4 py-3">Preferred Job</th>
                  <th className="text-left font-semibold px-4 py-3">Stage</th>
                  <th className="text-left font-semibold px-4 py-3">Assigned</th>
                  <th className="text-left font-semibold px-4 py-3">Last Contact</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => navigate(`/marketing-hub/${lead.id}`)}
                    className="border-t border-zinc-100 hover:bg-zinc-50 dark:bg-zinc-900/60 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-semibold text-zinc-900 dark:text-zinc-50">{lead.full_name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">{lead.phone}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400 dark:text-zinc-500">{lead.source_label || '—'}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400 dark:text-zinc-500">
                      <div className="flex items-center gap-2">
                        <span className="truncate max-w-[200px]">
                          {lead.preferred_job_title || lead.preferred_job_text || '—'}
                        </span>
                        {lead.preferred_job_is_urgent && (
                          <Flame size={12} className="text-red-500" />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge status={STAGE_BADGE_STATUS[lead.stage] || 'new'}>
                        {lead.stage}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400 dark:text-zinc-500">{lead.assigned_agent_name || '—'}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">{formatDate(lead.last_contacted_at || lead.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-100 bg-zinc-50 dark:bg-zinc-900/60/50">
            <span className="text-xs text-zinc-500 dark:text-zinc-400 dark:text-zinc-500">
              Page {pagination.page} of {pagination.totalPages} — {pagination.total} leads
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 dark:text-zinc-500 hover:bg-zinc-50 dark:bg-zinc-900/60 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 dark:text-zinc-500 hover:bg-zinc-50 dark:bg-zinc-900/60 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
