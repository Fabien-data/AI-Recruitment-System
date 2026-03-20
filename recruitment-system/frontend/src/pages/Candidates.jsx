import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getCandidates, createCandidate, getDuplicateCandidates, mergeCandidates } from '../api'
import { Search, Plus, Users, GitMerge, AlertTriangle } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { CandidateReviewModal } from '../components/CandidateReviewModal'
import toast from 'react-hot-toast'

const DEBOUNCE_MS = 300

export default function Candidates() {
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [language, setLanguage] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [reviewCandidateId, setReviewCandidateId] = useState(null)
  const [form, setForm] = useState({ name: '', phone: '', email: '', source: 'web', preferred_language: 'en', notes: '' })
  const [showDuplicates, setShowDuplicates] = useState(false)

  const queryClient = useQueryClient()

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const { data, isLoading } = useQuery({
    queryKey: ['candidates', { page, search, status, language }],
    queryFn: () => getCandidates({ page, search, status, language: language || undefined })
  })

  const { data: duplicatesData = [], isLoading: duplicatesLoading, refetch: refetchDuplicates } = useQuery({
    queryKey: ['candidate-duplicates'],
    queryFn: getDuplicateCandidates,
    enabled: showDuplicates
  })

  const mergeMutation = useMutation({
    mutationFn: ({ keep_id, merge_id }) => mergeCandidates({ keep_id, merge_id }),
    onSuccess: () => {
      toast.success('Candidates merged')
      refetchDuplicates()
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Merge failed')
  })

  const createMutation = useMutation({
    mutationFn: createCandidate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setModalOpen(false)
      setForm({ name: '', phone: '', email: '', source: 'web', preferred_language: 'en', notes: '' })
      toast.success('Candidate added')
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || 'Failed to add candidate')
    },
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.name?.trim() || !form.phone?.trim()) {
      toast.error('Name and phone are required')
      return
    }
    createMutation.mutate(form)
  }

  const candidatesList = data?.data || []
  const pagination = data?.pagination

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Candidates</h1>
          <p className="text-gray-600 mt-1">Manage and track all candidates</p>
        </div>
        <Button variant="primary" className="flex items-center gap-2" onClick={() => setModalOpen(true)}>
          <Plus size={20} aria-hidden />
          Add Candidate
        </Button>
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={20} aria-hidden />
            <input
              type="text"
              placeholder="Search candidates..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="input pl-10"
              aria-label="Search candidates"
            />
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="input w-full sm:w-40"
            aria-label="Filter by status"
          >
            <option value="">All Status</option>
            <option value="new">New</option>
            <option value="screening">Screening</option>
            <option value="interview">Interview</option>
            <option value="hired">Hired</option>
            <option value="rejected">Rejected</option>
          </select>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="input w-full sm:w-40"
            aria-label="Filter by language"
          >
            <option value="">All Languages</option>
            <option value="en">English</option>
            <option value="si">Sinhala</option>
            <option value="ta">Tamil</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : candidatesList.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <Users className="mx-auto h-12 w-12 text-gray-300 mb-2" aria-hidden />
            <p className="font-medium">No candidates found</p>
            <p className="text-sm mt-1">Add a candidate or adjust your filters.</p>
            <Button variant="primary" className="mt-4" onClick={() => setModalOpen(true)}>
              Add Candidate
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Name</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Phone</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Email</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Source</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {candidatesList.map((candidate) => (
                    <tr
                      key={candidate.id}
                      className="border-b border-gray-100 hover:bg-indigo-50 transition-colors cursor-pointer"
                      onClick={() => setReviewCandidateId(candidate.id)}
                    >
                      <td className="py-3 px-4 font-medium text-gray-900">{candidate.name || 'Unknown'}</td>
                      <td className="py-3 px-4 text-gray-600">{candidate.phone}</td>
                      <td className="py-3 px-4 text-gray-600">{candidate.email || '-'}</td>
                      <td className="py-3 px-4">
                        <span className="badge bg-gray-100 text-gray-700">{candidate.source}</span>
                      </td>
                      <td className="py-3 px-4">
                        <Badge status={candidate.status} />
                      </td>
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <Link
                          to={`/candidates/${candidate.id}`}
                          className="text-primary-600 hover:text-primary-700 font-medium"
                        >
                          View Details
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pagination && (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mt-6 pt-4 border-t border-gray-200">
                <p className="text-sm text-gray-600">
                  Showing {candidatesList.length} of {pagination.total} candidates
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= pagination.totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Duplicate Detection Section */}
      <div className="card mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitMerge size={18} />
            Duplicate Detection
          </h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setShowDuplicates(true); refetchDuplicates() }}
          >
            Scan for Duplicates
          </Button>
        </div>
        {showDuplicates && (
          duplicatesLoading ? (
            <p className="text-sm text-gray-400">Scanning...</p>
          ) : duplicatesData.length === 0 ? (
            <div className="py-6 text-center text-gray-500">
              <Users className="mx-auto h-10 w-10 text-gray-300 mb-2" />
              <p className="text-sm">No duplicate candidates found</p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">{duplicatesData.length} potential duplicate pair{duplicatesData.length !== 1 ? 's' : ''} found</p>
              {duplicatesData.map((pair, i) => (
                <div key={i} className="border border-orange-200 bg-orange-50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3 text-sm font-medium text-orange-700">
                    <AlertTriangle size={14} />
                    {pair.confidence}% confidence match
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-white rounded-lg p-3 border border-gray-200">
                      <p className="font-semibold text-gray-900">{pair.candidate1?.name}</p>
                      <p className="text-gray-500">{pair.candidate1?.phone}</p>
                      <p className="text-gray-500">{pair.candidate1?.email || '—'}</p>
                    </div>
                    <div className="bg-white rounded-lg p-3 border border-gray-200">
                      <p className="font-semibold text-gray-900">{pair.candidate2?.name}</p>
                      <p className="text-gray-500">{pair.candidate2?.phone}</p>
                      <p className="text-gray-500">{pair.candidate2?.email || '—'}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3 justify-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => mergeMutation.mutate({ keep_id: pair.candidate1.id, merge_id: pair.candidate2.id })}
                      disabled={mergeMutation.isPending}
                    >
                      Keep Left, Merge Right
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => mergeMutation.mutate({ keep_id: pair.candidate2.id, merge_id: pair.candidate1.id })}
                      disabled={mergeMutation.isPending}
                    >
                      Keep Right, Merge Left
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Candidate" size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Name"
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Full name"
          />
          <Input
            label="Phone"
            required
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            placeholder="Phone number"
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="email@example.com"
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
            <select
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
              className="input"
            >
              <option value="web">Web</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="messenger">Messenger</option>
              <option value="walkin">Walk-in</option>
              <option value="phone">Phone</option>
            </select>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={createMutation.isPending}>
              Add Candidate
            </Button>
          </div>
        </form>
      </Modal>

      {/* Candidate Review Modal — opens on row click */}
      <CandidateReviewModal
        candidateId={reviewCandidateId}
        open={!!reviewCandidateId}
        onClose={() => setReviewCandidateId(null)}
      />
    </div>
  )
}
