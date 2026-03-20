import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createProjectJob } from '../api'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
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
  const [formData, setFormData] = useState({
    title: '',
    category: '',
    description: '',
    positions_available: 1,
    salary_range: '',
    location: '',
    deadline: '',
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

  const createMutation = useMutation({
    mutationFn: (data) => createProjectJob(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries(['project', projectId])
      queryClient.invalidateQueries(['project-jobs', projectId])
      queryClient.invalidateQueries(['jobs'])
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
      deadline: '',
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
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    
    if (!formData.title || !formData.category) {
      toast.error('Please fill in all required fields')
      return
    }

    // Clean up requirements - remove empty fields
    const cleanedRequirements = Object.entries(formData.requirements).reduce((acc, [key, value]) => {
      if (value !== '' && value !== null && value !== undefined) {
        acc[key] = value
      }
      return acc
    }, {})

    const dataToSubmit = {
      ...formData,
      requirements: cleanedRequirements
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Application Deadline</label>
            <Input
              type="date"
              value={formData.deadline}
              onChange={(e) => setFormData({ ...formData, deadline: e.target.value })}
            />
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
