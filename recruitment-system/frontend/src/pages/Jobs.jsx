import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getJobs } from '../api'
import { Briefcase, FolderKanban } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { TableSkeleton } from '../components/ui/Skeleton'

export default function Jobs() {
  const [statusFilter, setStatusFilter] = useState('active')
  const [categoryFilter, setCategoryFilter] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['jobs', { status: statusFilter, category: categoryFilter || undefined }],
    queryFn: () => getJobs({ status: statusFilter, category: categoryFilter || undefined })
  })

  const jobsList = data?.data || []

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Jobs</h1>
        <p className="text-gray-600 mt-1">View and manage job listings</p>
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input w-full sm:w-40"
              aria-label="Filter by status"
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="closed">Closed</option>
              <option value="filled">Filled</option>
              <option value="">All</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <input
              type="text"
              placeholder="e.g. security, hospitality"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="input"
              aria-label="Filter by category"
            />
          </div>
        </div>
      </div>

      {/* Jobs List */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : jobsList.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <Briefcase className="mx-auto h-12 w-12 text-gray-300 mb-2" aria-hidden />
            <p className="font-medium">No jobs found</p>
            <p className="text-sm mt-1">Adjust your filters or create a new job.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Title</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Category</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Project</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Positions</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobsList.map((job) => (
                  <tr key={job.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-3 px-4 font-medium text-gray-900">{job.title}</td>
                    <td className="py-3 px-4 text-gray-600">{job.category}</td>
                    <td className="py-3 px-4">
                      {job.project_title ? (
                        <Link 
                          to={`/projects/${job.project_id}`}
                          className="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700"
                        >
                          <FolderKanban size={14} />
                          <span>{job.project_title}</span>
                        </Link>
                      ) : (
                        <span className="text-gray-400 text-sm">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <Badge status={job.status} />
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {job.positions_filled ?? 0} / {job.positions_available ?? 1}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex gap-2">
                        <Link
                          to={`/jobs/${job.id}/candidates`}
                          className="text-primary-600 hover:text-primary-700 font-medium text-sm"
                        >
                          View Candidates
                        </Link>
                        <span className="text-gray-300">|</span>
                        <Link
                          to={`/jobs/${job.id}`}
                          className="text-gray-500 hover:text-gray-700 font-medium text-sm"
                        >
                          Details
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
