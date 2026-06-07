import { CheckCircle2, Circle, ListChecks } from 'lucide-react'
import { format } from 'date-fns'
import { Card } from './ui/Card'
import { getDocumentCategory } from '../utils/documents'
import { normalizeStatus } from '../constants/lifecycle'

// Application statuses that count as "screened & certified or further".
const CERTIFIED_OR_FURTHER = new Set(['certified', 'interview_scheduled', 'hired'])

// Supporting document categories (anything beyond the primary CV / photo).
const SUPPORTING_CATEGORIES = new Set(['passport', 'certificate', 'id', 'additional'])

// Format an arbitrary date-ish value, swallowing invalid dates so a bad row
// never blanks the whole card.
function formatDate(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return format(d, 'MMM d, yyyy')
}

// Derive the 5 onboarding steps purely from the candidate object returned by
// getCandidate (cvs / applications / interviews are all already present). No
// local state, no mutations — this is a read-only view of real data.
function deriveSteps(candidate) {
  const cvs = Array.isArray(candidate?.cvs) ? candidate.cvs : []
  const applications = Array.isArray(candidate?.applications) ? candidate.applications : []
  const interviews = Array.isArray(candidate?.interviews) ? candidate.interviews : []

  const hasCv = candidate?.cv_uploaded === true || cvs.some((cv) => getDocumentCategory(cv) === 'cv')

  const firstApplication = applications[0] || null
  const hasJob = applications.length > 0

  const certifiedApp = applications.find((app) =>
    CERTIFIED_OR_FURTHER.has(normalizeStatus(String(app?.status || '').toLowerCase())),
  )
  const isCertified = Boolean(certifiedApp)

  const hasSupportingDocs = cvs.some((cv) => SUPPORTING_CATEGORIES.has(getDocumentCategory(cv)))

  const firstInterview = interviews[0] || null
  const hasInterview = interviews.length > 0

  return [
    {
      key: 'cv',
      title: 'CV on file',
      complete: hasCv,
      detail: hasCv ? 'CV received' : 'No CV uploaded yet',
    },
    {
      key: 'job',
      title: 'Job assigned',
      complete: hasJob,
      detail: hasJob ? firstApplication?.job_title || 'Assigned to a role' : 'Not assigned to a job yet',
    },
    {
      key: 'certified',
      title: 'Screened & certified',
      complete: isCertified,
      detail: isCertified
        ? formatDate(certifiedApp?.certified_at)
          ? `Certified ${formatDate(certifiedApp.certified_at)}`
          : 'Certified'
        : 'Not yet certified',
    },
    {
      key: 'documents',
      title: 'Supporting documents',
      complete: hasSupportingDocs,
      detail: hasSupportingDocs ? 'Passport / ID / certificates on file' : 'No supporting documents yet',
    },
    {
      key: 'interview',
      title: 'Interview scheduled',
      complete: hasInterview,
      detail: hasInterview
        ? formatDate(firstInterview?.scheduled_datetime)
          ? `Scheduled ${formatDate(firstInterview.scheduled_datetime)}`
          : 'Interview scheduled'
        : 'No interview scheduled yet',
    },
  ]
}

export function CandidateOnboardingChecklist({ candidate }) {
  if (!candidate) return null

  const steps = deriveSteps(candidate)
  const completed = steps.filter((step) => step.complete).length
  const total = steps.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          <ListChecks size={20} aria-hidden /> Onboarding Checklist
        </h2>
        <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {completed}/{total}
        </span>
      </div>

      {/* Progress bar — completed steps out of total. */}
      <div
        className="mb-5 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        role="progressbar"
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Onboarding progress"
      >
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="space-y-3">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-3">
            {step.complete ? (
              <CheckCircle2 size={20} className="mt-0.5 flex-shrink-0 text-emerald-500" aria-hidden />
            ) : (
              <Circle size={20} className="mt-0.5 flex-shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden />
            )}
            <div className="min-w-0">
              <p
                className={
                  step.complete
                    ? 'text-sm font-medium text-zinc-900 dark:text-zinc-50'
                    : 'text-sm font-medium text-zinc-500 dark:text-zinc-400'
                }
              >
                {step.title}
              </p>
              {step.detail && (
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 break-words">{step.detail}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default CandidateOnboardingChecklist
