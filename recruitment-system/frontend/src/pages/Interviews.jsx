import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Calendar, Clock, MapPin, User, CheckCircle2, XCircle,
  AlertCircle, ChevronDown, Bell, Star, Filter
} from 'lucide-react'
import {
  getInterviews, updateInterview, deleteInterview, sendInterviewReminder
} from '../api'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'

const STATUS_COLORS = {
  scheduled: 'bg-blue-100 text-blue-800',
  confirmed: 'bg-green-100 text-green-800',
  completed: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-red-100 text-red-800',
  no_show: 'bg-orange-100 text-orange-800'
}

function formatDateTime(dt) {
  if (!dt) return '—'
  return new Date(dt).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

function RatingStars({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} onClick={() => onChange && onChange(n)} type="button">
          <Star
            size={16}
            className={n <= (value || 0) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
          />
        </button>
      ))}
    </div>
  )
}

function FeedbackModal({ interview, onClose, onSave }) {
  const [rating, setRating] = useState(interview.rating || 0)
  const [feedback, setFeedback] = useState(interview.feedback || '')
  const [status, setStatus] = useState(interview.status)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold mb-4">Complete Interview</h3>
        <p className="text-sm text-gray-600 mb-4">
          {interview.candidate_name} — {interview.job_title}
        </p>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Outcome</label>
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          >
            <option value="completed">Completed</option>
            <option value="no_show">No Show</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Rating</label>
          <RatingStars value={rating} onChange={setRating} />
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Feedback</label>
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            rows={4}
            placeholder="Interview notes, strengths, concerns..."
            className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ status, rating: rating || null, feedback })}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function Interviews() {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState({ status: '', date_from: '', date_to: '' })
  const [feedbackTarget, setFeedbackTarget] = useState(null)

  const { data: interviews = [], isLoading } = useQuery({
    queryKey: ['interviews', filters],
    queryFn: () => getInterviews(filters)
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateInterview(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interviews'] })
  })

  const cancelMutation = useMutation({
    mutationFn: (id) => deleteInterview(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interviews'] })
  })

  const reminderMutation = useMutation({
    mutationFn: (id) => sendInterviewReminder(id, {}),
    onSuccess: () => alert('Reminder sent successfully')
  })

  const handleFeedbackSave = (id, data) => {
    updateMutation.mutate({ id, data })
    setFeedbackTarget(null)
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Interview Management</h1>
          <p className="text-gray-600 mt-1">Schedule, track, and complete candidate interviews</p>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-6 flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
          <select
            value={filters.status}
            onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="confirmed">Confirmed</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="no_show">No Show</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
          <input
            type="date"
            value={filters.date_from}
            onChange={e => setFilters(f => ({ ...f, date_from: e.target.value }))}
            className="border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
          <input
            type="date"
            value={filters.date_to}
            onChange={e => setFilters(f => ({ ...f, date_to: e.target.value }))}
            className="border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <Button variant="secondary" size="sm" onClick={() => setFilters({ status: '', date_from: '', date_to: '' })}>
          Clear
        </Button>
      </div>

      {/* Interview list */}
      {isLoading ? (
        <div className="card p-8 text-center text-gray-500">Loading interviews...</div>
      ) : interviews.length === 0 ? (
        <div className="card p-12 text-center">
          <Calendar className="mx-auto h-12 w-12 text-gray-300 mb-4" />
          <p className="text-gray-500">No interviews found</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Candidate</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Job</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Date & Time</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Location</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Rating</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {interviews.map(iv => (
                <tr key={iv.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{iv.candidate_name}</div>
                    <div className="text-xs text-gray-500">{iv.candidate_phone}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/jobs/${iv.job_id}`} className="text-primary-600 hover:underline">
                      {iv.job_title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      <Clock size={14} className="text-gray-400" />
                      {formatDateTime(iv.scheduled_datetime)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {iv.location ? (
                      <div className="flex items-center gap-1">
                        <MapPin size={14} className="text-gray-400" />
                        {iv.location}
                      </div>
                    ) : <span className="text-gray-400">TBD</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[iv.status] || 'bg-gray-100 text-gray-700'}`}>
                      {iv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {iv.rating ? <RatingStars value={iv.rating} /> : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {['scheduled', 'confirmed'].includes(iv.status) && (
                        <>
                          <button
                            title="Send reminder"
                            onClick={() => reminderMutation.mutate(iv.id)}
                            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
                          >
                            <Bell size={14} />
                          </button>
                          <button
                            title="Complete / Feedback"
                            onClick={() => setFeedbackTarget(iv)}
                            className="p-1.5 rounded hover:bg-green-50 text-green-600"
                          >
                            <CheckCircle2 size={14} />
                          </button>
                          <button
                            title="Cancel"
                            onClick={() => { if (confirm('Cancel this interview?')) cancelMutation.mutate(iv.id) }}
                            className="p-1.5 rounded hover:bg-red-50 text-red-500"
                          >
                            <XCircle size={14} />
                          </button>
                        </>
                      )}
                      {iv.status === 'completed' && !iv.rating && (
                        <button
                          title="Add rating/feedback"
                          onClick={() => setFeedbackTarget(iv)}
                          className="p-1.5 rounded hover:bg-yellow-50 text-yellow-600"
                        >
                          <Star size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {feedbackTarget && (
        <FeedbackModal
          interview={feedbackTarget}
          onClose={() => setFeedbackTarget(null)}
          onSave={(data) => handleFeedbackSave(feedbackTarget.id, data)}
        />
      )}
    </div>
  )
}
