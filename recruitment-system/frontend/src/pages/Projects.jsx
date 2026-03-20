import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getProjects, createProject, deleteProject } from '../api'
import { FolderKanban, Plus, Trash2, Users, Briefcase } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Input } from '../components/ui/Input'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import { clsx } from 'clsx'

const COUNTRIES = ['UAE', 'Qatar', 'Oman', 'Bahrain', 'Saudi Arabia', 'Kuwait']
const INDUSTRIES = ['Hypermarket', 'Restaurant', 'Construction', 'Healthcare', 'Hospitality', 'Manufacturing', 'Retail', 'Logistics']

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

  // Form state for new project
  const [formData, setFormData] = useState({
    title: '',
    client_name: '',
    industry_type: '',
    description: '',
    countries: [],
    priority: 'normal',
    total_positions: 0,
    start_date: '',
    interview_date: '',
    end_date: '',
    benefits: {
      accommodation: false,
      transport: false,
      meals: false,
      visa: false,
      ticket: false
    },
    salary_info: {
      min: '',
      max: '',
      currency: 'AED'
    },
    contact_info: {
      whatsapp: '',
      email: '',
      address: ''
    }
  })

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
    if (!formData.title || !formData.client_name || !formData.industry_type || formData.countries.length === 0) {
      toast.error('Please fill in all required fields')
      return
    }
    createMutation.mutate(formData)
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
      industry_type: '',
      description: '',
      countries: [],
      priority: 'normal',
      total_positions: 0,
      start_date: '',
      interview_date: '',
      end_date: '',
      benefits: {
        accommodation: false,
        transport: false,
        meals: false,
        visa: false,
        ticket: false
      },
      salary_info: {
        min: '',
        max: '',
        currency: 'AED'
      },
      contact_info: {
        whatsapp: '',
        email: '',
        address: ''
      }
    })
  }

  const handleCountryToggle = (country) => {
    setFormData(prev => ({
      ...prev,
      countries: prev.countries.includes(country)
        ? prev.countries.filter(c => c !== country)
        : [...prev.countries, country]
    }))
  }

  const projectsList = data?.data || []
  const canCreateProject = user?.role === 'admin' || user?.role === 'supervisor'
  const canDeleteProject = user?.role === 'admin'

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-600 mt-1">Manage multi-country recruitment projects</p>
        </div>
        {canCreateProject && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={20} className="mr-2" />
            New Project
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Countries</option>
              {COUNTRIES.map(country => (
                <option key={country} value={country}>{country}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Industry</label>
            <select
              value={industryFilter}
              onChange={(e) => setIndustryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Industries</option>
              {INDUSTRIES.map(industry => (
                <option key={industry} value={industry}>{industry}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
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
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={8} />
        ) : projectsList.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <FolderKanban className="mx-auto h-12 w-12 text-gray-300 mb-2" />
            <p className="font-medium">No projects found</p>
            <p className="text-sm mt-1">Create your first project to get started.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Project</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Client</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Countries</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Industry</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Priority</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Positions</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Interview Date</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Team</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {projectsList.map((project) => {
                  const countries = typeof project.countries === 'string' 
                    ? JSON.parse(project.countries) 
                    : project.countries
                  
                  return (
                    <tr key={project.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-4">
                        <Link to={`/projects/${project.id}`} className="font-medium text-gray-900 hover:text-primary-600">
                          {project.title}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-gray-600">{project.client_name}</td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1">
                          {countries?.slice(0, 2).map((country) => (
                            <span key={country} className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-md">
                              {country}
                            </span>
                          ))}
                          {countries?.length > 2 && (
                            <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-md">
                              +{countries.length - 2}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-gray-600 text-sm">{project.industry_type}</td>
                      <td className="py-3 px-4">
                        <Badge status={project.status} />
                      </td>
                      <td className="py-3 px-4">
                        <Badge status={project.priority} />
                      </td>
                      <td className="py-3 px-4 text-gray-600">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{project.filled_positions || 0}</span>
                          <span className="text-gray-400">/</span>
                          <span>{project.total_positions || 0}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-gray-600 text-sm">
                        {project.interview_date ? format(new Date(project.interview_date), 'MMM dd, yyyy') : '-'}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          <Users size={16} className="text-gray-400" />
                          <span className="text-sm text-gray-600">{project.team_count || 0}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-2 items-center">
                          <Link
                            to={`/projects/${project.id}`}
                            className="text-primary-600 hover:text-primary-700 font-medium text-sm"
                          >
                            View
                          </Link>
                          {project.job_count > 0 && (
                            <>
                              <span className="text-gray-300">|</span>
                              <div className="flex items-center gap-1 text-gray-500 text-sm">
                                <Briefcase size={14} />
                                <span>{project.job_count}</span>
                              </div>
                            </>
                          )}
                          {canDeleteProject && (
                            <>
                              <span className="text-gray-300">|</span>
                              <button
                                onClick={() => handleDelete(project.id)}
                                className="text-red-600 hover:text-red-700"
                                title="Delete project"
                              >
                                <Trash2 size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {data?.pagination && data.pagination.totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <p className="text-sm text-gray-600">
            Page {data.pagination.page} of {data.pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPage(p => p + 1)}
              disabled={page >= data.pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

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
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">1</div>
              <h3 className="text-lg font-semibold text-gray-900">Basic Information</h3>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Industry Type <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={formData.industry_type}
                  onChange={(e) => setFormData({ ...formData, industry_type: e.target.value })}
                  className="input w-full"
                >
                  <option value="">Select industry</option>
                  {INDUSTRIES.map(industry => (
                    <option key={industry} value={industry}>{industry}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
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
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
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
          <div className="pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">2</div>
              <label className="text-lg font-semibold text-gray-900">
                Target Countries <span className="text-red-500">*</span>
              </label>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {COUNTRIES.map(country => (
                <label key={country} className={clsx(
                  "flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all",
                  formData.countries.includes(country)
                    ? "border-primary-500 bg-primary-50 shadow-sm"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                )}>
                  <input
                    type="checkbox"
                    checked={formData.countries.includes(country)}
                    onChange={() => handleCountryToggle(country)}
                    className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                  />
                  <span className="text-sm font-medium text-gray-700">{country}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">3</div>
              <h3 className="text-lg font-semibold text-gray-900">Timeline</h3>
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
                label="Interview End Date"
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
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">4</div>
              <h3 className="text-lg font-semibold text-gray-900">Positions & Benefits</h3>
            </div>
            <Input
              type="number"
              label="Total Positions"
              min="0"
              value={formData.total_positions}
              onChange={(e) => setFormData({ ...formData, total_positions: parseInt(e.target.value) || 0 })}
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">Benefits Included</label>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {['accommodation', 'transport', 'meals', 'visa', 'ticket'].map(benefit => (
                  <label key={benefit} className={clsx(
                    "flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all",
                    formData.benefits[benefit]
                      ? "border-primary-500 bg-primary-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  )}>
                    <input
                      type="checkbox"
                      checked={formData.benefits[benefit]}
                      onChange={(e) => setFormData({
                        ...formData,
                        benefits: { ...formData.benefits, [benefit]: e.target.checked }
                      })}
                      className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                    />
                    <span className="text-sm font-medium text-gray-700 capitalize">{benefit}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Salary Range */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">5</div>
              <h3 className="text-lg font-semibold text-gray-900">Salary Information</h3>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                <select
                  value={formData.salary_info.currency}
                  onChange={(e) => setFormData({
                    ...formData,
                    salary_info: { ...formData.salary_info, currency: e.target.value }
                  })}
                  className="input w-full"
                >
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
              <h3 className="text-lg font-semibold text-gray-900">Contact Information</h3>
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
          <div className="flex justify-end gap-3 pt-6 border-t-2 border-gray-200 bg-gray-50 -mx-6 -mb-6 px-6 py-4 rounded-b-xl sticky bottom-0">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setModalOpen(false)
                resetForm()
              }}
            >
              Cancel
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
