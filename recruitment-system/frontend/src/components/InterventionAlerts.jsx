import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { getCandidates, resolveCandidateIntervention } from '../api'

export default function InterventionAlerts() {
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchAlerts = async () => {
    try {
      const data = await getCandidates({ intervention_needed: true, page: 1, limit: 8 })
      setAlerts(data?.data || [])
    } catch (e) {
      console.error('Failed to fetch intervention alerts:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAlerts()
    const id = setInterval(fetchAlerts, 30000)
    return () => clearInterval(id)
  }, [])

  const resolveAlert = async (candidateId) => {
    try {
      await resolveCandidateIntervention(candidateId)
      setAlerts((prev) => prev.filter((c) => c.id !== candidateId))
    } catch (e) {
      console.error('Failed to resolve intervention:', e)
    }
  }

  if (loading) {
    return <div className="h-12 w-full animate-pulse rounded-xl bg-zinc-100" />
  }

  if (alerts.length === 0) {
    return null
  }

  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-red-600" />
        <h3 className="text-sm font-bold text-red-800">AI Intervention Alerts</h3>
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
          {alerts.length}
        </span>
      </div>

      <div className="space-y-2">
        {alerts.map((candidate) => (
          <div key={candidate.id} className="flex items-center justify-between rounded-xl border border-red-100 bg-white p-3">
            <div>
              <p className="text-sm font-semibold text-zinc-900">{candidate.name || candidate.phone}</p>
              <p className="text-xs text-zinc-500">{candidate.intervention_reason || 'AI requested human support.'}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                onClick={() => { window.location.href = `/communications?candidate=${candidate.id}` }}
              >
                Take Over
              </button>
              <button
                type="button"
                className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200"
                onClick={() => resolveAlert(candidate.id)}
              >
                Resolve
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
