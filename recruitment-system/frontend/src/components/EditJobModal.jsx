import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateJob } from '../api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { CountrySelect } from './jobs/CountrySelect'
import { URGENCY_OPTIONS } from './jobs/UrgencyPill'
import toast from 'react-hot-toast'

const JOB_CATEGORIES = [
  'Security', 'Hospitality', 'Manufacturing', 'Construction', 'Healthcare',
  'Retail', 'Logistics', 'F&B Service', 'Housekeeping', 'Administration', 'Other',
]

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'complete', label: 'Complete' },
  { value: 'future', label: 'Future' },
  { value: 'pending_review', label: 'Pending Review' },
]

function toFormState(job) {
  if (!job) return null
  const reqs = job.requirements && typeof job.requirements === 'object' ? job.requirements : {}
  return {
    title: job.title || '',
    category: job.category || '',
    description: job.description || '',
    positions_available: job.positions_available || 1,
    salary_range: job.salary_range || '',
    location: job.location || '',
    country: job.country || '',
    country_code: job.country_code || '',
    domain: job.domain || '',
    urgency_level: job.urgency_level || 'normal',
    status: job.status || 'active',
    deadline: job.deadline ? String(job.deadline).slice(0, 10) : '',
    requirements: {
      min_age: reqs.min_age ?? '',
      max_age: reqs.max_age ?? '',
      gender: reqs.gender ?? '',
      min_height: reqs.min_height ?? '',
      experience_years: reqs.experience_years ?? '',
      education: reqs.education ?? '',
      languages: Array.isArray(reqs.required_languages) ? reqs.required_languages.join(', ') : (reqs.languages ?? ''),
      skills: Array.isArray(reqs.required_skills) ? reqs.required_skills.join(', ') : (reqs.skills ?? ''),
    },
    wiggle_room: job.wiggle_room && typeof job.wiggle_room === 'object'
      ? { age_tolerance: job.wiggle_room.age_tolerance ?? 2, height_tolerance: job.wiggle_room.height_tolerance ?? 2 }
      : { age_tolerance: 2, height_tolerance: 2 },
  }
}

export function EditJobModal({ isOpen, job, onClose }) {
  const queryClient = useQueryClient()
  const [formData, setFormData] = useState(() => toFormState(job))

  useEffect(() => {
    if (isOpen && job) setFormData(toFormState(job))
  }, [isOpen, job])

  const updateMutation = useMutation({
    mutationFn: (data) => updateJob(job.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['job', job.id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Job updated')
      onClose()
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to update job'),
  })

  if (!formData) return null

  const handleCountryChange = (country) => {
    if (!country) {
      setFormData((p) => ({ ...p, country: '', country_code: '' }))
      return
    }
    setFormData((p) => ({
      ...p,
      country: country.name,
      country_code: country.code,
      domain: p.domain || country.domain_default || '',
    }))
  }

  const updateRequirement = (field, value) => {
    setFormData((p) => ({ ...p, requirements: { ...p.requirements, [field]: value } }))
  }
  const updateWiggleRoom = (field, value) => {
    setFormData((p) => ({ ...p, wiggle_room: { ...p.wiggle_room, [field]: value } }))
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!formData.title || !formData.category) return toast.error('Title and category are required')
    if (!formData.country) return toast.error('Country is required')
    if (!formData.domain) return toast.error('Domain is required')

    const cleanedRequirements = Object.entries(formData.requirements).reduce((acc, [k, v]) => {
      if (v !== '' && v !== null && v !== undefined) acc[k] = v
      return acc
    }, {})

    updateMutation.mutate({
      ...formData,
      requirements: cleanedRequirements,
    })
  }

  return (
    <Modal open={isOpen} onClose={onClose} title={`Edit Job — ${job?.title || ''}`} size="xl">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic info */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Basic Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Job Title <span className="text-red-500">*</span></label>
              <Input type="text" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category <span className="text-red-500">*</span></label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="input w-full"
                required
              >
                <option value="">Select category</option>
                {JOB_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat.toLowerCase()}>{cat}</option>
                ))}
                {formData.category && !JOB_CATEGORIES.find((c) => c.toLowerCase() === formData.category) && (
                  <option value={formData.category}>{formData.category}</option>
                )}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="input w-full"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Positions Available</label>
              <Input type="number" min="1"
                value={formData.positions_available}
                onChange={(e) => setFormData({ ...formData, positions_available: parseInt(e.target.value) || 1 })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Salary Range</label>
              <Input type="text" value={formData.salary_range}
                onChange={(e) => setFormData({ ...formData, salary_range: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
              <Input type="text" value={formData.location}
                onChange={(e) => setFormData({ ...formData, location: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Application Deadline</label>
              <Input type="date" value={formData.deadline}
                onChange={(e) => setFormData({ ...formData, deadline: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                className="input w-full"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Region & Urgency */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Region & Urgency</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Country <span className="text-red-500">*</span></label>
              <CountrySelect value={formData.country_code || formData.country} onChange={handleCountryChange} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Domain <span className="text-red-500">*</span></label>
              <select
                value={formData.domain}
                onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                className="input w-full"
              >
                <option value="">Select region</option>
                <option value="middle_east">Middle East</option>
                <option value="europe">Europe</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Urgency Level</label>
              <select
                value={formData.urgency_level}
                onChange={(e) => setFormData({ ...formData, urgency_level: e.target.value })}
                className="input w-full"
              >
                {URGENCY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Requirements */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Requirements</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Minimum Age</label>
              <Input type="number" min="18" max="65" value={formData.requirements.min_age}
                onChange={(e) => updateRequirement('min_age', e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Maximum Age</label>
              <Input type="number" min="18" max="65" value={formData.requirements.max_age}
                onChange={(e) => updateRequirement('max_age', e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Gender</label>
              <select
                value={formData.requirements.gender}
                onChange={(e) => updateRequirement('gender', e.target.value)}
                className="input w-full"
              >
                <option value="">Any</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Minimum Height (cm)</label>
              <Input type="number" min="140" max="220" value={formData.requirements.min_height}
                onChange={(e) => updateRequirement('min_height', e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Experience (years)</label>
              <Input type="number" min="0" max="30" value={formData.requirements.experience_years}
                onChange={(e) => updateRequirement('experience_years', e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Education</label>
              <select
                value={formData.requirements.education}
                onChange={(e) => updateRequirement('education', e.target.value)}
                className="input w-full"
              >
                <option value="">Any</option>
                <option value="primary">Primary School</option>
                <option value="secondary">Secondary School</option>
                <option value="diploma">Diploma</option>
                <option value="bachelors">Bachelor's Degree</option>
                <option value="masters">Master's Degree</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Languages</label>
              <Input type="text" value={formData.requirements.languages}
                onChange={(e) => updateRequirement('languages', e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Skills</label>
              <Input type="text" value={formData.requirements.skills}
                onChange={(e) => updateRequirement('skills', e.target.value)} />
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Flexibility Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Age Tolerance (±years)</label>
              <Input type="number" min="0" max="10" value={formData.wiggle_room.age_tolerance}
                onChange={(e) => updateWiggleRoom('age_tolerance', parseInt(e.target.value) || 0)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Height Tolerance (±cm)</label>
              <Input type="number" min="0" max="10" value={formData.wiggle_room.height_tolerance}
                onChange={(e) => updateWiggleRoom('height_tolerance', parseInt(e.target.value) || 0)} />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button type="button" variant="secondary" onClick={onClose} disabled={updateMutation.isLoading}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={updateMutation.isLoading}>
            {updateMutation.isLoading ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
