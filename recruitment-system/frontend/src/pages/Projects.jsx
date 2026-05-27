import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getProjects, createProject, deleteProject } from '../api'
import {
  FolderKanban, Plus, Trash2, Users, Briefcase, Building2, Globe2, Tag,
  Calendar, BarChart3, Activity, PauseCircle, CheckCircle2, Eye, X,
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Input } from '../components/ui/Input'
import { PageHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Table } from '../components/ui/Table'
import { EmptyState } from '../components/ui/EmptyState'
import { Pagination } from '../components/ui/Pagination'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import { clsx } from 'clsx'
import { COUNTRY_OPTIONS, currencyForCountry } from '../constants/countries'
import { INDUSTRY_OPTIONS, BENEFIT_OPTIONS, DEFAULT_BENEFITS_STATE } from '../constants/lifecycle'

export default function Projects() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [countryFilter, setCountryFilter] = useState('')
  const [industryFilter, setIndustryFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [countrySearch, setCountrySearch] = useState('')

  // Form state for new project
  const [formData, setFormData] = useState({
    title: '',
    client_name: '',
    industry_types: [],
    description: '',
    countries: [],
    priority: 'normal',
    total_positions: 0,
    start_date: '',
    interview_date: '',
    end_date: '',
    benefits: { ...DEFAULT_BENEFITS_STATE },
    salary_info: {
      min: '',
      max: '',
      currency: 'AED'
    },
    contact_info: {
      whatsapp: '',
      mobile: '',
      email: '',
      address: '',
      special_details: ''
    }
  })

  // Free-text input for the "Other" industry — appended to industry_types on add
  const [otherIndustry, setOtherIndustry] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['projects', {
      page,
      status: statusFilter || undefined,
      country: countryFilter || undefined,
      industry_type: industryFilter || undefined,
      priority: priorityFilter || undefined,
      search: searchQuery || undefined
    }],
    queryFn: () => getProjects({
      page,
      status: statusFilter || undefined,
      country: countryFilter || undefined,
      industry_type: industryFilter || undefined,
      priority: priorityFilter || undefined,
      search: searchQuery || undefined
    })
  })

  // Lightweight unfiltered fetch for the 4 stat cards. Uses a higher page size
  // so stats reflect the full dataset rather than the current page's slice.
  const { data: statsData } = useQuery({
    queryKey: ['projects', 'stats'],
    queryFn: () => getProjects({ page: 1, limit: 1000 }),
    staleTime: 60_000,
  })

  const allProjectsForStats = statsData?.data || []
  const stats = {
    total: statsData?.pagination?.total ?? allProjectsForStats.length,
    active: allProjectsForStats.filter((p) => p.status === 'active').length,
    onHold: allProjectsForStats.filter((p) => p.status === 'on_hold').length,
    completed: allProjectsForStats.filter((p) => p.status === 'completed').length,
  }

  const createMutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries(['projects'])
      setModalOpen(false)
      resetForm()
      toast.success('Project created successfully')
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create project')
    }
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries(['projects'])
      toast.success('Project deleted successfully')
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to delete project')
    }
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!formData.title || !formData.client_name || formData.industry_types.length === 0 || formData.countries.length === 0) {
      toast.error('Please fill in all required fields (incl. at least one industry)')
      return
    }
    // Maintain backwards-compat: also send industry_type = first of the array
    // so any old reader keeps working until they migrate.
    createMutation.mutate({
      ...formData,
      industry_type: formData.industry_types[0],
    })
  }

  const handleIndustryToggle = (industry) => {
    setFormData((prev) => ({
      ...prev,
      industry_types: prev.industry_types.includes(industry)
        ? prev.industry_types.filter((i) => i !== industry)
        : [...prev.industry_types, industry],
    }))
  }

  const handleAddOtherIndustry = () => {
    const trimmed = otherIndustry.trim()
    if (!trimmed) return
    if (formData.industry_types.includes(trimmed)) {
      toast.error(`"${trimmed}" already added`)
      return
    }
    setFormData((prev) => ({
      ...prev,
      industry_types: [...prev.industry_types, trimmed],
    }))
    setOtherIndustry('')
  }

  const handleBenefitToggle = (key) => {
    setFormData((prev) => {
      const next = { ...prev.benefits, [key]: !prev.benefits[key] }
      // Mutual exclusion: meals_included <-> meals_not_included
      const opt = BENEFIT_OPTIONS.find((o) => o.key === key)
      if (opt?.exclusiveWith && next[key]) {
        next[opt.exclusiveWith] = false
      }
      return { ...prev, benefits: next }
    })
  }

  const handleDelete = (id) => {
    if (window.confirm('Are you sure you want to delete this project? All related jobs will be unlinked.')) {
      deleteMutation.mutate(id)
    }
  }

  const resetForm = () => {
    setFormData({
      title: '',
      client_name: '',
      industry_types: [],
      description: '',
      countries: [],
      priority: 'normal',
      total_positions: 0,
      start_date: '',
      interview_date: '',
      end_date: '',
      benefits: { ...DEFAULT_BENEFITS_STATE },
      salary_info: {
        min: '',
        max: '',
        currency: 'AED'
      },
      contact_info: {
        whatsapp: '',
        mobile: '',
        email: '',
        address: '',
        special_details: ''
      }
    })
    setOtherIndustry('')
  }

  const handleCountryToggle = (country) => {
    setFormData(prev => ({
      ...prev,
      salary_info: {
        ...prev.salary_info,
        currency: prev.countries.length === 0 ? currencyForCountry(country) : prev.salary_info.currency
      },
      countries: prev.countries.includes(country)
        ? prev.countries.filter(c => c !== country)
        : [...prev.countries, country]
    }))
  }

  const filteredCountryOptions = COUNTRY_OPTIONS.filter(country => {
    const q = countrySearch.trim().toLowerCase()
    return !q || country.toLowerCase().includes(q)
  })

  const projectsList = data?.data || []
  const canCreateProject = user?.role === 'admin' || user?.role === 'supervisor'
  const canDeleteProject = user?.role === 'admin'

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={FolderKanban}
        tone="mixed"
        title="Projects"
        subtitle="Manage multi-country recruitment projects"
        actions={canCreateProject && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={18} />
            New Project
          </Button>
        )}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard tone="blue" icon={BarChart3} label="Total Projects" value={stats.total} />
        <StatCard tone="emerald" icon={Activity} label="Active" value={stats.active} />
        <StatCard tone="amber" icon={PauseCircle} label="On Hold" value={stats.onHold} />
        <StatCard tone="purple" icon={CheckCircle2} label="Completed" value={stats.completed} />
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Status</option>
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="on_hold">On Hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Country</label>
            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Countries</option>
              {COUNTRY_OPTIONS.map(country => (
                <option key={country} value={country}>{country}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Industry</label>
            <select
              value={industryFilter}
              onChange={(e) => setIndustryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Industries</option>
              {INDUSTRY_OPTIONS.map(industry => (
                <option key={industry} value={industry}>{industry}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Priority</label>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Priority</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
      </div>

      {/* Projects Table */}
      <Card className="overflow-hidden p-0">
        {isLoading ? (
          <div className="p-5">
            <TableSkeleton rows={6} cols={8} />
          </div>
        ) : projectsList.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            tone="purple"
            title="No projects found"
            description="Create your first project to start grouping jobs by client and country."
            action={canCreateProject && (
              <Button onClick={() => setModalOpen(true)}>
                <Plus size={16} />
                New Project
              </Button>
            )}
          />
        ) : (
          <Table>
            <Table.Head>
              <Table.Tr hover={false}>
                <Table.Th icon={FolderKanban}>Project</Table.Th>
                <Table.Th icon={Building2}>Client</Table.Th>
                <Table.Th icon={Globe2}>Countries</Table.Th>
                <Table.Th icon={Tag}>Industry</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Priority</Table.Th>
                <Table.Th align="right">Positions</Table.Th>
                <Table.Th icon={Calendar}>Interview</Table.Th>
                <Table.Th icon={Users} align="right">Team</Table.Th>
                <Table.Th align="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Head>
            <Table.Body>
              {projectsList.map((project) => {
                const countries = typeof project.countries === 'string'
                  ? JSON.parse(project.countries)
                  : project.countries
                const filled = project.filled_positions || 0
                const total = project.total_positions || 0
                const pct = total > 0 ? Math.min(100, Math.round((filled / total) * 100)) : 0
                const barTone = pct >= 100 ? 'from-emerald-500 to-emerald-600' : pct >= 60 ? 'from-amber-400 to-amber-500' : 'from-primary-500 to-primary-600'
                const accent =
                  project.status === 'active' ? 'emerald'
                  : project.status === 'on_hold' ? 'amber'
                  : project.status === 'completed' ? 'purple'
                  : project.status === 'cancelled' ? 'rose'
                  : 'zinc'
                return (
                  <Table.Tr key={project.id} accent={accent}>
                    <Table.Td className="font-semibold text-zinc-900 dark:text-zinc-50 min-w-[220px]">
                      <Link to={`/projects/${project.id}`} className="group inline-flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-900 shadow-sm">
                          {project.title?.charAt(0)?.toUpperCase() || 'P'}
                        </div>
                        <span className="text-sm group-hover:text-primary-600 dark:group-hover:text-primary-400 truncate">{project.title}</span>
                      </Link>
                    </Table.Td>
                    <Table.Td>
                      <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                        <Building2 size={13} className="text-zinc-400" />
                        <span className="text-sm">{project.client_name}</span>
                      </div>
                    </Table.Td>
                    <Table.Td>
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {countries?.slice(0, 2).map((country) => (
                          <span
                            key={country}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 rounded-full ring-1 ring-inset ring-emerald-200 dark:ring-emerald-900/60"
                          >
                            <Globe2 size={10} />
                            {country}
                          </span>
                        ))}
                        {countries?.length > 2 && (
                          <span className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full ring-1 ring-inset ring-zinc-200 dark:ring-zinc-700">
                            +{countries.length - 2}
                          </span>
                        )}
                      </div>
                    </Table.Td>
                    <Table.Td>
                      {(() => {
                        const raw = project.industry_types
                        const arr = Array.isArray(raw)
                          ? raw
                          : typeof raw === 'string' && raw.length > 0
                            ? (() => { try { return JSON.parse(raw) } catch { return [] } })()
                            : []
                        const list = arr.length > 0 ? arr : (project.industry_type ? [project.industry_type] : [])
                        if (list.length === 0) return <span className="text-zinc-400 text-sm">—</span>
                        return (
                          <div className="flex flex-wrap gap-1 max-w-[220px]">
                            {list.slice(0, 3).map((ind) => (
                              <span
                                key={ind}
                                className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300 ring-1 ring-inset ring-blue-200 dark:ring-blue-900/60"
                              >
                                {ind}
                              </span>
                            ))}
                            {list.length > 3 && (
                              <span className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full ring-1 ring-inset ring-zinc-200 dark:ring-zinc-700">
                                +{list.length - 3}
                              </span>
                            )}
                          </div>
                        )
                      })()}
                    </Table.Td>
                    <Table.Td><Badge status={project.status} /></Table.Td>
                    <Table.Td><Badge status={project.priority} /></Table.Td>
                    <Table.Td align="right" className="min-w-[140px]">
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{filled} / {total || 0}</span>
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                          <div
                            className={`h-full rounded-full bg-gradient-to-r ${barTone} transition-all duration-500`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    </Table.Td>
                    <Table.Td className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                      {project.interview_date ? format(new Date(project.interview_date), 'MMM dd, yyyy') : '—'}
                    </Table.Td>
                    <Table.Td align="right">
                      <div className="inline-flex items-center gap-1 text-zinc-700 dark:text-zinc-300">
                        <Users size={14} className="text-zinc-400" />
                        <span className="text-sm font-medium">{project.team_count || 0}</span>
                      </div>
                    </Table.Td>
                    <Table.Td align="right">
                      <div className="inline-flex items-center gap-1.5">
                        <Link
                          to={`/projects/${project.id}`}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-primary-700 dark:text-primary-300 hover:bg-primary-50 dark:hover:bg-primary-950/40 transition-colors"
                          title="View project"
                        >
                          <Eye size={13} /> View
                        </Link>
                        {project.job_count > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                            <Briefcase size={11} /> {project.job_count}
                          </span>
                        )}
                        {canDeleteProject && (
                          <button
                            type="button"
                            onClick={() => handleDelete(project.id)}
                            className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                            title="Delete project"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Body>
          </Table>
        )}
        {data?.pagination && data.pagination.totalPages > 1 && (
          <Pagination
            page={data.pagination.page}
            totalPages={data.pagination.totalPages}
            total={data.pagination.total}
            pageSize={data.pagination.limit || 20}
            onChange={(next) => setPage(next)}
          />
        )}
      </Card>

      {/* Create Project Modal */}
      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false)
          resetForm()
        }}
        title="Create New Project"
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Basic Information */}
          <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">1</div>
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Basic Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Project Title"
                required
                placeholder="e.g., Middle East Hypermarket Expansion"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
              <Input
                label="Client Name"
                required
                placeholder="Company name"
                value={formData.client_name}
                onChange={(e) => setFormData({ ...formData, client_name: e.target.value })}
              />
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Priority</label>
                <select
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                  className="input w-full"
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
            </div>

            {/* Industry multi-select */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                Industry Type <span className="text-red-500">*</span>
                <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                  (select one or more; use Other for custom)
                </span>
              </label>

              {/* Selected chips */}
              {formData.industry_types.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {formData.industry_types.map((ind) => (
                    <span
                      key={ind}
                      className="inline-flex items-center gap-2 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 px-3 py-1 rounded-full text-sm border border-blue-200 dark:border-blue-900/60"
                    >
                      {ind}
                      <button
                        type="button"
                        onClick={() => handleIndustryToggle(ind)}
                        className="text-blue-700 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
                        aria-label={`Remove ${ind}`}
                      >
                        <X size={14} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Standard options */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
                {INDUSTRY_OPTIONS.map((industry) => {
                  const selected = formData.industry_types.includes(industry)
                  return (
                    <label
                      key={industry}
                      className={clsx(
                        'flex items-center gap-2 p-2 border-2 rounded-lg cursor-pointer transition-all',
                        selected
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                          : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => handleIndustryToggle(industry)}
                        className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                      />
                      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{industry}</span>
                    </label>
                  )
                })}
              </div>

              {/* Other free-text */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Other (e.g., Marine Services) and press Add"
                  value={otherIndustry}
                  onChange={(e) => setOtherIndustry(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddOtherIndustry()
                    }
                  }}
                  className="input flex-1"
                />
                <Button type="button" variant="secondary" onClick={handleAddOtherIndustry}>
                  Add
                </Button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description</label>
              <textarea
                rows={3}
                placeholder="Project description..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="input w-full resize-none"
              />
            </div>
          </div>

          {/* Countries */}
          <div className="pb-6 border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">2</div>
              <label className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Country of Recruitment <span className="text-red-500">*</span>
              </label>
            </div>

            <div className="mb-3">
              <input
                type="text"
                value={countrySearch}
                onChange={(e) => setCountrySearch(e.target.value)}
                className="input w-full"
                placeholder="Search countries..."
                aria-label="Search countries"
              />
            </div>

            <div className="mb-3 flex flex-wrap gap-2">
              {formData.countries.map(country => (
                <span key={country} className="inline-flex items-center gap-2 bg-primary-50 text-primary-700 px-3 py-1 rounded-full text-sm border border-primary-200">
                  {country}
                  <button
                    type="button"
                    onClick={() => handleCountryToggle(country)}
                    className="text-primary-700 hover:text-primary-900"
                    aria-label={`Remove ${country}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-56 overflow-y-auto pr-1">
              {filteredCountryOptions.map(country => (
                <label key={country} className={clsx(
                  "flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all",
                  formData.countries.includes(country)
                    ? "border-primary-500 bg-primary-50 shadow-sm"
                    : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                )}>
                  <input
                    type="checkbox"
                    checked={formData.countries.includes(country)}
                    onChange={() => handleCountryToggle(country)}
                    className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                  />
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{country}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">3</div>
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Timeline</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                type="date"
                label="Start Date"
                value={formData.start_date}
                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
              />
              <Input
                type="date"
                label="Interview Start Date"
                value={formData.interview_date}
                onChange={(e) => setFormData({ ...formData, interview_date: e.target.value })}
              />
              <Input
                type="date"
                label="End Date"
                value={formData.end_date}
                onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
              />
            </div>
          </div>

          {/* Positions & Benefits */}
          <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">4</div>
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Positions & Benefits</h3>
            </div>
            <Input
              type="number"
              label="Total Positions"
              min="0"
              value={formData.total_positions}
              onChange={(e) => setFormData({ ...formData, total_positions: parseInt(e.target.value) || 0 })}
            />
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">Benefits Included</label>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {BENEFIT_OPTIONS.map(({ key, label }) => (
                  <label key={key} className={clsx(
                    'flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all',
                    formData.benefits[key]
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/30'
                      : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                  )}>
                    <input
                      type="checkbox"
                      checked={!!formData.benefits[key]}
                      onChange={() => handleBenefitToggle(key)}
                      className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                    />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Note: "Meals included in salary" and "Meals NOT included in salary" are mutually exclusive.
              </p>
            </div>
          </div>

          {/* Salary Range */}
          <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">5</div>
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Salary Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                type="number"
                label="Minimum Salary"
                placeholder="1500"
                value={formData.salary_info.min}
                onChange={(e) => setFormData({
                  ...formData,
                  salary_info: { ...formData.salary_info, min: e.target.value }
                })}
              />
              <Input
                type="number"
                label="Maximum Salary"
                placeholder="2000"
                value={formData.salary_info.max}
                onChange={(e) => setFormData({
                  ...formData,
                  salary_info: { ...formData.salary_info, max: e.target.value }
                })}
              />
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Currency</label>
                <select
                  value={formData.salary_info.currency}
                  onChange={(e) => setFormData({
                    ...formData,
                    salary_info: { ...formData.salary_info, currency: e.target.value }
                  })}
                  className="input w-full"
                >
                  {formData.countries.length > 0 && (
                    <option value={currencyForCountry(formData.countries[0])}>{currencyForCountry(formData.countries[0])} (Auto)</option>
                  )}
                  <option value="AED">AED</option>
                  <option value="QAR">QAR</option>
                  <option value="OMR">OMR</option>
                  <option value="BHD">BHD</option>
                  <option value="SAR">SAR</option>
                  <option value="KWD">KWD</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
          </div>

          {/* Contact Information */}
          <div className="space-y-4 pb-6">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">6</div>
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Contact Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="WhatsApp Number"
                placeholder="077 402 2956"
                value={formData.contact_info.whatsapp}
                onChange={(e) => setFormData({
                  ...formData,
                  contact_info: { ...formData.contact_info, whatsapp: e.target.value }
                })}
              />
              <Input
                label="Client Mobile Number"
                placeholder="+971501234567"
                value={formData.contact_info.mobile}
                onChange={(e) => setFormData({
                  ...formData,
                  contact_info: { ...formData.contact_info, mobile: e.target.value }
                })}
              />
              <Input
                type="email"
                label="Email"
                placeholder="hypermarket.dewan@gmail.com"
                value={formData.contact_info.email}
                onChange={(e) => setFormData({
                  ...formData,
                  contact_info: { ...formData.contact_info, email: e.target.value }
                })}
              />
            </div>
            <Input
              label="Address"
              placeholder="83/2, Chatham Street, Colombo 01"
              value={formData.contact_info.address}
              onChange={(e) => setFormData({
                ...formData,
                contact_info: { ...formData.contact_info, address: e.target.value }
              })}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-6 border-t-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 -mx-6 -mb-6 px-6 py-4 rounded-b-xl sticky bottom-0">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setModalOpen(false)
                resetForm()
              }}
            >
              Cancel
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Special Details</label>
              <textarea
                rows={3}
                className="input w-full resize-none"
                placeholder="Any special client notes, constraints, or instructions..."
                value={formData.contact_info.special_details}
                onChange={(e) => setFormData({
                  ...formData,
                  contact_info: { ...formData.contact_info, special_details: e.target.value }
                })}
              />
            </div>
            </Button>
            <Button type="submit" loading={createMutation.isLoading}>
              Create Project
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

const STAT_TONES = {
  blue:    { icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200',           grad: 'section-grad-blue',    text: 'text-blue-700 dark:text-blue-200' },
  emerald: { icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200', grad: 'section-grad-emerald', text: 'text-emerald-700 dark:text-emerald-200' },
  amber:   { icon: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200',       grad: 'section-grad-amber',   text: 'text-amber-700 dark:text-amber-200' },
  purple:  { icon: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200',   grad: 'section-grad-purple',  text: 'text-purple-700 dark:text-purple-200' },
  rose:    { icon: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-200',           grad: 'section-grad-rose',    text: 'text-rose-700 dark:text-rose-200' },
  indigo:  { icon: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200',   grad: 'section-grad-indigo',  text: 'text-indigo-700 dark:text-indigo-200' },
}

function StatCard({ tone = 'blue', icon: Icon, label, value }) {
  const t = STAT_TONES[tone] || STAT_TONES.blue
  return (
    <div className={`card relative overflow-hidden ${t.grad}`}>
      <div className="relative flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">{label}</p>
          <p className={`mt-1 text-3xl font-bold tracking-tight ${t.text}`}>{value}</p>
        </div>
        {Icon && (
          <div className={`rounded-2xl p-3 shadow-sm ${t.icon}`}>
            <Icon size={22} aria-hidden />
          </div>
        )}
      </div>
    </div>
  )
}
