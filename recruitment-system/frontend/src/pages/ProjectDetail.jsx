import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, getProjectJobs, getProjectCandidates, getProjectStats } from '../api'
import { 
  ArrowLeft, FolderKanban, MapPin, Calendar, Users, Briefcase, 
  DollarSign, Home, Bus, Utensils, FileText, Plane, Phone, Mail, MapPinned, Plus
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { Button } from '../components/ui/Button'
import { CreateJobModal } from '../components/CreateJobModal'
import { format } from 'date-fns'
import { useAuthStore } from '../stores/authStore'

export default function ProjectDetail() {
  const { id } = useParams()
  const { user } = useAuthStore()
  const [candidatesJobFilter, setCandidatesJobFilter] = useState('')
  const [isJobModalOpen, setIsJobModalOpen] = useState(false)

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', id],
    queryFn: () => getProject(id),
    enabled: !!id,
  })

  const { data: statsData } = useQuery({
    queryKey: ['project-stats', id],
    queryFn: () => getProjectStats(id),
    enabled: !!id,
  })

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-4 w-full mb-2" />
        <Skeleton className="h-4 w-2/3 mb-8" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card><Skeleton className="h-32" /></Card>
            <Card><Skeleton className="h-48" /></Card>
          </div>
          <div className="space-y-6">
            <Card><Skeleton className="h-24" /></Card>
            <Card><Skeleton className="h-32" /></Card>
          </div>
        </div>
      </div>
    )
  }

  if (error || !project) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Link to="/projects" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6">
          <ArrowLeft size={20} /> Back to Projects
        </Link>
        <div className="card text-center py-12">
          <p className="text-gray-600 font-medium">Project not found</p>
        </div>
      </div>
    )
  }

  const countries = typeof project.countries === 'string' ? JSON.parse(project.countries) : project.countries
  const benefits = typeof project.benefits === 'string' ? JSON.parse(project.benefits) : project.benefits
  const salaryInfo = typeof project.salary_info === 'string' ? JSON.parse(project.salary_info) : project.salary_info
  const contactInfo = typeof project.contact_info === 'string' ? JSON.parse(project.contact_info) : project.contact_info
  
  const benefitIcons = {
    accommodation: Home,
    transport: Bus,
    meals: Utensils,
    visa: FileText,
    ticket: Plane
  }

  const activeBenefits = Object.entries(benefits).filter(([_, value]) => value)
  const stats = statsData || {}
  const completionRate = stats.total_positions > 0 
    ? Math.round((stats.filled_positions / stats.total_positions) * 100) 
    : 0

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      {/* Back Navigation */}
      <Link to="/projects" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6 font-medium">
        <ArrowLeft size={20} /> Back to Projects
      </Link>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold text-gray-900">{project.title}</h1>
            <Badge status={project.status} />
            <Badge status={project.priority} />
          </div>
          <p className="text-xl text-gray-600 mb-3">{project.client_name}</p>
          <div className="flex flex-wrap items-center gap-4 text-gray-600">
            <span className="inline-flex items-center gap-1">
              <FolderKanban size={18} /> {project.industry_type}
            </span>
            {project.interview_date && (
              <span className="inline-flex items-center gap-1">
                <Calendar size={18} /> Interview: {format(new Date(project.interview_date), 'MMM d, yyyy')}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Users size={18} /> {project.team?.length || 0} Team Members
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Overview Card */}
          <Card>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Project Overview</h2>
            
            {/* Countries */}
            <div className="mb-4">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Target Countries</h3>
              <div className="flex flex-wrap gap-2">
                {countries?.map((country) => (
                  <span key={country} className="inline-flex items-center gap-1 px-3 py-1 bg-blue-50 text-blue-700 rounded-lg border border-blue-100">
                    <MapPin size={16} />
                    {country}
                  </span>
                ))}
              </div>
            </div>

            {/* Description */}
            {project.description && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Description</h3>
                <p className="text-gray-600 whitespace-pre-wrap">{project.description}</p>
              </div>
            )}

            {/* Timeline */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4 p-4 bg-gray-50 rounded-lg">
              {project.start_date && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Start Date</p>
                  <p className="font-medium text-gray-900">{format(new Date(project.start_date), 'MMM d, yyyy')}</p>
                </div>
              )}
              {project.interview_date && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Interview Date</p>
                  <p className="font-medium text-gray-900">{format(new Date(project.interview_date), 'MMM d, yyyy')}</p>
                </div>
              )}
              {project.end_date && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">End Date</p>
                  <p className="font-medium text-gray-900">{format(new Date(project.end_date), 'MMM d, yyyy')}</p>
                </div>
              )}
            </div>

            {/* Benefits */}
            {activeBenefits.length > 0 && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Benefits Included</h3>
                <div className="flex flex-wrap gap-2">
                  {activeBenefits.map(([benefit]) => {
                    const Icon = benefitIcons[benefit]
                    return (
                      <span key={benefit} className="inline-flex items-center gap-1 px-3 py-1 bg-green-50 text-green-700 rounded-lg border border-green-100">
                        {Icon && <Icon size={16} />}
                        <span className="capitalize">{benefit}</span>
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Salary */}
            {(salaryInfo?.min || salaryInfo?.max) && (
              <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
                <DollarSign size={20} className="text-blue-600" />
                <span className="font-medium text-gray-900">
                  {salaryInfo.currency} {salaryInfo.min || 0} - {salaryInfo.max || 0}
                </span>
                <span className="text-sm text-gray-600">per month</span>
              </div>
            )}

            {/* Contact Information */}
            {(contactInfo?.whatsapp || contactInfo?.email || contactInfo?.address) && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Contact Information</h3>
                <div className="space-y-2">
                  {contactInfo.whatsapp && (
                    <div className="flex items-center gap-2 text-gray-600">
                      <Phone size={16} className="text-gray-400" />
                      <span>{contactInfo.whatsapp}</span>
                    </div>
                  )}
                  {contactInfo.email && (
                    <div className="flex items-center gap-2 text-gray-600">
                      <Mail size={16} className="text-gray-400" />
                      <span>{contactInfo.email}</span>
                    </div>
                  )}
                  {contactInfo.address && (
                    <div className="flex items-center gap-2 text-gray-600">
                      <MapPinned size={16} className="text-gray-400" />
                      <span>{contactInfo.address}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* Jobs Card */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Jobs in Project</h2>
              <div className="flex gap-2">
                {(user?.role === 'admin' || user?.role === 'supervisor') && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setIsJobModalOpen(true)}
                    className="inline-flex items-center gap-1"
                  >
                    <Plus size={16} />
                    Add Job
                  </Button>
                )}
                <Link to="/jobs" className="text-primary-600 hover:text-primary-700 text-sm font-medium">
                  View All Jobs
                </Link>
              </div>
            </div>
            {project.jobs && project.jobs.length > 0 ? (
              <div className="space-y-3">
                {project.jobs.map((job) => (
                  <Link
                    key={job.id}
                    to={`/jobs/${job.id}`}
                    className="block p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-medium text-gray-900">{job.title}</h3>
                      <Badge status={job.status} />
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-600">
                      <span className="inline-flex items-center gap-1">
                        <Briefcase size={14} /> {job.category}
                      </span>
                      <span>
                        {job.candidate_count || 0} candidates
                      </span>
                      <span>
                        {job.positions_filled || 0} / {job.positions_available || 1} filled
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-500 mb-3">No jobs linked to this project yet</p>
                {(user?.role === 'admin' || user?.role === 'supervisor') && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setIsJobModalOpen(true)}
                    className="inline-flex items-center gap-1"
                  >
                    <Plus size={16} />
                    Create First Job
                  </Button>
                )}
              </div>
            )}
          </Card>

          {/* Candidates Card */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Candidates</h2>
              {project.jobs && project.jobs.length > 1 && (
                <select
                  value={candidatesJobFilter}
                  onChange={(e) => setCandidatesJobFilter(e.target.value)}
                  className="text-sm border-gray-300 rounded-lg"
                >
                  <option value="">All Jobs</option>
                  {project.jobs.map((job) => (
                    <option key={job.id} value={job.id}>{job.title}</option>
                  ))}
                </select>
              )}
            </div>
            
            {stats.unique_candidates > 0 ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-xs text-blue-600 mb-1">Total</p>
                    <p className="text-xl font-bold text-blue-900">{stats.total_applications || 0}</p>
                  </div>
                  <div className="p-3 bg-yellow-50 rounded-lg">
                    <p className="text-xs text-yellow-600 mb-1">Screening</p>
                    <p className="text-xl font-bold text-yellow-900">{stats.screening_count || 0}</p>
                  </div>
                  <div className="p-3 bg-purple-50 rounded-lg">
                    <p className="text-xs text-purple-600 mb-1">Interview</p>
                    <p className="text-xl font-bold text-purple-900">{stats.interview_count || 0}</p>
                  </div>
                  <div className="p-3 bg-green-50 rounded-lg">
                    <p className="text-xs text-green-600 mb-1">Selected</p>
                    <p className="text-xl font-bold text-green-900">{stats.selected_count || 0}</p>
                  </div>
                </div>
                <Link
                  to={`/applications?project_id=${id}`}
                  className="block text-center text-primary-600 hover:text-primary-700 font-medium text-sm py-2"
                >
                  View All Candidates →
                </Link>
              </div>
            ) : (
              <p className="text-center text-gray-500 py-8">No candidates assigned yet</p>
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Stats Card */}
          <Card>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Progress</h2>
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="text-gray-600">Positions Filled</span>
                  <span className="font-medium text-gray-900">{completionRate}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-primary-600 h-2 rounded-full transition-all"
                    style={{ width: `${completionRate}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {stats.filled_positions || 0} of {stats.total_positions || 0} positions filled
                </p>
              </div>

              <div className="pt-4 border-t border-gray-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-600">Total Jobs</span>
                  <span className="text-lg font-bold text-gray-900">{stats.total_jobs || 0}</span>
                </div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-600">Total Candidates</span>
                  <span className="text-lg font-bold text-gray-900">{stats.unique_candidates || 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">Applications</span>
                  <span className="text-lg font-bold text-gray-900">{stats.total_applications || 0}</span>
                </div>
              </div>
            </div>
          </Card>

          {/* Team Card */}
          <Card>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Project Team</h2>
            {project.team && project.team.length > 0 ? (
              <div className="space-y-3">
                {project.team.map((member) => (
                  <div key={member.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                    <div className="w-10 h-10 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center font-medium">
                      {member.full_name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{member.full_name}</p>
                      <p className="text-xs text-gray-500 truncate">{member.email}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge status={member.user_role} className="text-xs" />
                        <span className="text-xs text-gray-500 capitalize">• {member.role}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-gray-500 py-4 text-sm">No team members assigned</p>
            )}
          </Card>

          {/* Quick Actions Card */}
          <Card>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Quick Actions</h2>
            <div className="space-y-2">
              <Link
                to={`/jobs?project_id=${id}`}
                className="block w-full text-center px-4 py-2 bg-primary-50 text-primary-700 hover:bg-primary-100 rounded-lg font-medium text-sm transition-colors"
              >
                View Project Jobs
              </Link>
              <Link
                to={`/applications?project_id=${id}`}
                className="block w-full text-center px-4 py-2 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-lg font-medium text-sm transition-colors"
              >
                View Applications
              </Link>
            </div>
          </Card>
        </div>
      </div>

      {/* Create Job Modal */}
      <CreateJobModal
        projectId={id}
        isOpen={isJobModalOpen}
        onClose={() => setIsJobModalOpen(false)}
      />
    </div>
  )
}
