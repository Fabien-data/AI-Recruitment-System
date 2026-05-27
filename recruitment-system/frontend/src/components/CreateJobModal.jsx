import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createJob, createProjectJob, getProjects } from '../api'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { CountrySelect } from '../components/jobs/CountrySelect'
import { URGENCY_OPTIONS } from '../components/jobs/UrgencyPill'
import { defaultDomainForCountry } from '../constants/countries'
import toast from 'react-hot-toast'

const JOB_CATEGORIES = [
  'Security',
  'Hospitality',
  'Manufacturing',
  'Construction',
  'Healthcare',
  'Retail',
  'Logistics',
  'F&B Service',
  'Housekeeping',
  'Administration',
  'Other'
]

export function CreateJobModal({ projectId, isOpen, onClose }) {
  const queryClient = useQueryClient()
  const allowProjectSelection = !projectId
  const [selectedProjectId, setSelectedProjectId] = useState('')

  const { data: projectsData } = useQuery({
    queryKey: ['projects', { limit: 200 }],
    queryFn: () => getProjects({ limit: 200 }),
    enabled: allowProjectSelection && isOpen,
  })
  const projectsList = projectsData?.data || projectsData || []

  const [formData, setFormData] = useState({
    title: '',
    category: '',
    description: '',
    positions_available: 1,
    salary_range: '',
    location: '',
    country: '',
    country_code: '',
    domain: '',
    urgency_level: 'normal',
    status: 'active',
    deadline: '',
    required_fields_schema_text: '',
    requirements: {
      min_age: '',
      max_age: '',
      gender: '',
      min_height: '',
      experience_years: '',
      education: '',
      languages: '',
      skills: ''
    },
    wiggle_room: {
      age_tolerance: 2,
      height_tolerance: 2
    }
  })

  // When the user picks a country, auto-fill the domain only if they haven't
  // explicitly chosen one yet. They can still override afterwards.
  const handleCountryChange = (country) => {
    if (!country) {
      setFormData((prev) => ({ ...prev, country: '', country_code: '', domain: prev.domain }))
      return
    }
    setFormData((prev) => ({
      ...prev,
      country: country.name,
      country_code: country.code,
      domain: prev.domain || country.domain_default || '',
    }))
  }

  const SCHEMA_TEMPLATE = JSON.stringify({
    name: { mandatory: true },
    passport_number: { mandatory: true, ask_after: 'name' },
    preferred_shift: { mandatory: false }
  }, null, 2)

  const createMutation = useMutation({
    mutationFn: (data) => {
      if (projectId) {
        return createProjectJob(projectId, data)
      }
      return createJob({ ...data, project_id: selectedProjectId })
    },
    onSuccess: () => {
      // TanStack Query v5: invalidateQueries requires { queryKey } object.
      // The old v3-style array argument was a silent no-op, which is why
      // the project detail page never refreshed when a job was added.
      const linkedProjectId = projectId || selectedProjectId
      if (linkedProjectId) {
        queryClient.invalidateQueries({ queryKey: ['project', linkedProjectId] })
        queryClient.invalidateQueries({ queryKey: ['project-jobs', linkedProjectId] })
        queryClient.invalidateQueries({ queryKey: ['project-stats', linkedProjectId] })
        queryClient.invalidateQueries({ queryKey: ['project-candidates', linkedProjectId] })
      }
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Job created successfully')
      onClose()
      resetForm()
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create job')
    }
  })

  const resetForm = () => {
    setFormData({
      title: '',
      category: '',
      description: '',
      positions_available: 1,
      salary_range: '',
      location: '',
      country: '',
      country_code: '',
      domain: '',
      urgency_level: 'normal',
      status: 'active',
      deadline: '',
      required_fields_schema_text: '',
      requirements: {
        min_age: '',
        max_age: '',
        gender: '',
        min_height: '',
        experience_years: '',
        education: '',
        languages: '',
        skills: ''
      },
      wiggle_room: {
        age_tolerance: 2,
        height_tolerance: 2
      }
    })
    if (allowProjectSelection) {
      setSelectedProjectId('')
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()

    if (!formData.title || !formData.category) {
      toast.error('Please fill in all required fields')
      return
    }

    if (!formData.country) {
      toast.error('Country is required')
      return
    }
    if (!formData.domain) {
      toast.error('Domain (Middle East or Europe) is required')
      return
    }

    if (allowProjectSelection && !selectedProjectId) {
      toast.error('Please select a project for this job')
      return
    }

    // Clean up requirements - remove empty fields
    const cleanedRequirements = Object.entries(formData.requirements).reduce((acc, [key, value]) => {
      if (value !== '' && value !== null && value !== undefined) {
        acc[key] = value
      }
      return acc
    }, {})

    // Validate the per-job required-fields schema JSON before submitting so
    // recruiters get inline feedback instead of a 500 from the backend.
    let requiredFieldsSchema = {}
    if (formData.required_fields_schema_text && formData.required_fields_schema_text.trim()) {
      try {
        requiredFieldsSchema = JSON.parse(formData.required_fields_schema_text)
        if (typeof requiredFieldsSchema !== 'object' || Array.isArray(requiredFieldsSchema)) {
          toast.error('Required Fields Schema must be a JSON object')
          return
        }
      } catch (err) {
        toast.error('Required Fields Schema is not valid JSON')
        return
      }
    }

    const { required_fields_schema_text, ...rest } = formData
    const dataToSubmit = {
      ...rest,
      requirements: cleanedRequirements,
      required_fields_schema: requiredFieldsSchema,
    }

    createMutation.mutate(dataToSubmit)
  }

  const updateRequirement = (field, value) => {
    setFormData(prev => ({
      ...prev,
      requirements: {
        ...prev.requirements,
        [field]: value
      }
    }))
  }

  const updateWiggleRoom = (field, value) => {
    setFormData(prev => ({
      ...prev,
      wiggle_room: {
        ...prev.wiggle_room,
        [field]: value
      }
    }))
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Create New Job Position"
      size="xl"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {allowProjectSelection && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Project</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project <span className="text-red-500">*</span>
              </label>
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="input w-full"
                required
              >
                <option value="">Select a project</option>
                {projectsList.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title || project.name}
                    {project.client_name ? ` — ${project.client_name}` : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Jobs must belong to an existing project.</p>
            </div>
          </div>
        )}

        {/* Basic Information */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Basic Information</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Job Title <span className="text-red-500">*</span>
              </label>
              <Input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., Security Guard, Chef, Nurse"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category <span className="text-red-500">*</span>
              </label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="input w-full"
                required
              >
                <option value="">Select category</option>
                {JOB_CATEGORIES.map(cat => (
                  <option key={cat} value={cat.toLowerCase()}>{cat}</option>
                ))}
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
              placeholder="Describe the job role and responsibilities..."
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Positions Available</label>
              <Input
                type="number"
                min="1"
                value={formData.positions_available}
                onChange={(e) => setFormData({ ...formData, positions_available: parseInt(e.target.value) || 1 })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Salary Range</label>
              <Input
                type="text"
                value={formData.salary_range}
                onChange={(e) => setFormData({ ...formData, salary_range: e.target.value })}
                placeholder="e.g., 1500-2000 AED"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
              <Input
                type="text"
                value={formData.location}
                onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                placeholder="e.g., Dubai, UAE"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Application Deadline</label>
              <Input
                type="date"
                value={formData.deadline}
                onChange={(e) => setFormData({ ...formData, deadline: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                className="input w-full"
              >
                <option value="active">Active</option>
                <option value="future">Future</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Active jobs sync to the chatbot. Future jobs stay hidden until promoted.
              </p>
            </div>
          </div>
        </div>

        {/* Region & Urgency */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Region & Urgency</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Country <span className="text-red-500">*</span>
              </label>
              <CountrySelect
                value={formData.country_code || formData.country}
                onChange={handleCountryChange}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Domain <span className="text-red-500">*</span>
              </label>
              <select
                value={formData.domain}
                onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                className="input w-full"
              >
                <option value="">Select region</option>
                <option value="middle_east">Middle East</option>
                <option value="europe">Europe</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">Auto-suggested from country.</p>
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
              <Input
                type="number"
                min="18"
                max="65"
                value={formData.requirements.min_age}
                onChange={(e) => updateRequirement('min_age', e.target.value)}
                placeholder="e.g., 21"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Maximum Age</label>
              <Input
                type="number"
                min="18"
                max="65"
                value={formData.requirements.max_age}
                onChange={(e) => updateRequirement('max_age', e.target.value)}
                placeholder="e.g., 40"
              />
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
              <Input
                type="number"
                min="140"
                max="220"
                value={formData.requirements.min_height}
                onChange={(e) => updateRequirement('min_height', e.target.value)}
                placeholder="e.g., 165"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Experience (years)</label>
              <Input
                type="number"
                min="0"
                max="30"
                value={formData.requirements.experience_years}
                onChange={(e) => updateRequirement('experience_years', e.target.value)}
                placeholder="e.g., 2"
              />
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
              <Input
                type="text"
                value={formData.requirements.languages}
                onChange={(e) => updateRequirement('languages', e.target.value)}
                placeholder="e.g., English, Arabic"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Skills</label>
              <Input
                type="text"
                value={formData.requirements.skills}
                onChange={(e) => updateRequirement('skills', e.target.value)}
                placeholder="e.g., Driving, Cooking"
              />
            </div>
          </div>
        </div>

        {/* Wiggle Room (Tolerance) */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Flexibility Settings</h3>
          <p className="text-sm text-gray-600">Define tolerance levels for non-critical requirements</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Age Tolerance (±years)</label>
              <Input
                type="number"
                min="0"
                max="10"
                value={formData.wiggle_room.age_tolerance}
                onChange={(e) => updateWiggleRoom('age_tolerance', parseInt(e.target.value) || 0)}
              />
              <p className="text-xs text-gray-500 mt-1">Flexibility in age requirements</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Height Tolerance (±cm)</label>
              <Input
                type="number"
                min="0"
                max="10"
                value={formData.wiggle_room.height_tolerance}
                onChange={(e) => updateWiggleRoom('height_tolerance', parseInt(e.target.value) || 0)}
              />
              <p className="text-xs text-gray-500 mt-1">Flexibility in height requirements</p>
            </div>
          </div>
        </div>

        {/* Chatbot Settings */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 border-b pb-2">Chatbot Settings</h3>
          <p className="text-sm text-gray-600">
            Controls how the WhatsApp chatbot surfaces this job and which questions it asks candidates.
          </p>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">
                Required Fields Schema (JSON)
              </label>
              <button
                type="button"
                onClick={() =>
                  setFormData((prev) => ({ ...prev, required_fields_schema_text: SCHEMA_TEMPLATE }))
                }
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                Insert template
              </button>
            </div>
            <textarea
              value={formData.required_fields_schema_text}
              onChange={(e) =>
                setFormData({ ...formData, required_fields_schema_text: e.target.value })
              }
              className="input w-full font-mono text-xs"
              rows={6}
              placeholder='{"name": {"mandatory": true}, "passport_number": {"mandatory": true, "ask_after": "name"}}'
            />
            <p className="text-xs text-gray-500 mt-1">
              Per-field intake schema for the chatbot. Mandatory fields are asked first; optional ones
              only when the candidate is engaged. Leave blank to use category defaults.
            </p>
          </div>
        </div>

        {/* Form Actions */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={createMutation.isLoading}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={createMutation.isLoading}
          >
            {createMutation.isLoading ? 'Creating...' : 'Create Job'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
