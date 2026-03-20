import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getApplications } from '../api'
import { FileText } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { TableSkeleton } from '../components/ui/Skeleton'

export default function Applications() {
  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: getApplications,
  })

  const list = Array.isArray(applications) ? applications : []

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Applications</h1>
        <p className="text-gray-600 mt-1">Track candidate applications across jobs</p>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : list.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <FileText className="mx-auto h-12 w-12 text-gray-300 mb-2" aria-hidden />
            <p className="font-medium">No applications yet</p>
            <p className="text-sm mt-1">Applications will appear when candidates apply to jobs.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Candidate</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Job</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Applied</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((app) => (
                  <tr key={app.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-3 px-4 font-medium text-gray-900">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-primary-600 hover:text-primary-700">
                        {app.candidate_name || 'Candidate'}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      <Link to={`/jobs/${app.job_id}`} className="text-primary-600 hover:text-primary-700">
                        {app.job_title || 'Job'}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <Badge status={app.status} />
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '-'}
                    </td>
                    <td className="py-3 px-4">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-primary-600 hover:text-primary-700 text-sm font-medium">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
