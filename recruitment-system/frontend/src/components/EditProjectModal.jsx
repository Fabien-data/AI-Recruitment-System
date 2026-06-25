import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateProject } from '../api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { X } from 'lucide-react'
import toast from 'react-hot-toast'
import { clsx } from 'clsx'
import { COUNTRY_OPTIONS, currencyForCountry } from '../constants/countries'
import { INDUSTRY_OPTIONS, BENEFIT_OPTIONS, DEFAULT_BENEFITS_STATE } from '../constants/lifecycle'

// JSON fields may arrive as a real object/array, a JSON string, or null.
function safeParseObject(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function safeParseArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

// Normalize a date-ish value to the YYYY-MM-DD format <input type="date"> wants.
function toDateInputValue(value) {
  if (!value) return ''
  const str = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10)
  const d = new Date(str)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function toFormState(project) {
  if (!project) return null
  const industryArr = safeParseArray(project.industry_types)
  const industry_types = industryArr.length > 0
    ? industryArr
    : (project.industry_type ? [project.industry_type] : [])
  const salary = safeParseObject(project.salary_info)
  const contact = safeParseObject(project.contact_info)
  return {
    title: project.title || '',
    client_name: project.client_name || '',
    industry_types,
    description: project.description || '',
    countries: safeParseArray(project.countries),
    status: project.status || 'planning',
    priority: project.priority || 'normal',
    total_positions: project.total_positions || 0,
    start_date: toDateInputValue(project.start_date),
    interview_date: toDateInputValue(project.interview_date),
    end_date: toDateInputValue(project.end_date),
    benefits: { ...DEFAULT_BENEFITS_STATE, ...safeParseObject(project.benefits) },
    salary_info: {
      min: salary.min ?? '',
      max: salary.max ?? '',
      currency: salary.currency || 'AED',
    },
    contact_info: {
      whatsapp: contact.whatsapp ?? '',
      mobile: contact.mobile ?? '',
      email: contact.email ?? '',
      address: contact.address ?? '',
      special_details: contact.special_details ?? '',
    },
  }
}

export function EditProjectModal({ isOpen, project, onClose }) {
  const queryClient = useQueryClient()
  const [formData, setFormData] = useState(() => toFormState(project))
  const [otherIndustry, setOtherIndustry] = useState('')
  const [countrySearch, setCountrySearch] = useState('')

  useEffect(() => {
    if (isOpen && project) {
      setFormData(toFormState(project))
      setOtherIndustry('')
      setCountrySearch('')
    }
  }, [isOpen, project])

  const updateMutation = useMutation({
    mutationFn: (data) => updateProject(project.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', project.id] })
      toast.success('Project updated')
      onClose()
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to update project'),
  })

  if (!formData) return null

  const handleIndustryToggle = (industry) => {
    setFormData((prev) => ({
      ...prev,
      industry_types: prev.industry_types.includes(industry)
        ? prev.industry_types.filter((i) => i !== industry)
        : [...prev.industry_types, industry],
    }))
  }

  const handleAddOtherIndustry = () => {
    const trimmed = otherIndustry.trim()
    if (!trimmed) return
    if (formData.industry_types.includes(trimmed)) {
      toast.error(`"${trimmed}" already added`)
      return
    }
    setFormData((prev) => ({ ...prev, industry_types: [...prev.industry_types, trimmed] }))
    setOtherIndustry('')
  }

  const handleBenefitToggle = (key) => {
    setFormData((prev) => {
      const next = { ...prev.benefits, [key]: !prev.benefits[key] }
      const opt = BENEFIT_OPTIONS.find((o) => o.key === key)
      if (opt?.exclusiveWith && next[key]) {
        next[opt.exclusiveWith] = false
      }
      return { ...prev, benefits: next }
    })
  }

  const handleCountryToggle = (country) => {
    setFormData((prev) => ({
      ...prev,
      salary_info: {
        ...prev.salary_info,
        currency: prev.countries.length === 0 ? currencyForCountry(country) : prev.salary_info.currency,
      },
      countries: prev.countries.includes(country)
        ? prev.countries.filter((c) => c !== country)
        : [...prev.countries, country],
    }))
  }

  const filteredCountryOptions = COUNTRY_OPTIONS.filter((country) => {
    const q = countrySearch.trim().toLowerCase()
    return !q || country.toLowerCase().includes(q)
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!formData.title || !formData.client_name || formData.industry_types.length === 0 || formData.countries.length === 0) {
      toast.error('Please fill in all required fields (incl. at least one industry and country)')
      return
    }
    // Mirror the create flow: also send legacy industry_type = first element.
    updateMutation.mutate({
      ...formData,
      industry_type: formData.industry_types[0],
    })
  }

  return (
    <Modal open={isOpen} onClose={onClose} title={`Edit Project — ${project?.title || ''}`} size="xl">
      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Basic Information */}
        <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Basic Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Project Title"
              required
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            />
            <Input
              label="Client Name"
              required
              value={formData.client_name}
              onChange={(e) => setFormData({ ...formData, client_name: e.target.value })}
            />
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Status</label>
              <select
                value={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                className="input w-full"
              >
                <option value="planning">Planning</option>
                <option value="active">Active</option>
                <option value="on_hold">On Hold</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Priority</label>
              <select
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                className="input w-full"
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          {/* Industry multi-select */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Industry Type <span className="text-red-500">*</span>
              <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                (select one or more; use Other for custom)
              </span>
            </label>
            {formData.industry_types.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {formData.industry_types.map((ind) => (
                  <span
                    key={ind}
                    className="inline-flex items-center gap-2 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 px-3 py-1 rounded-full text-sm border border-blue-200 dark:border-blue-900/60"
                  >
                    {ind}
                    <button
                      type="button"
                      onClick={() => handleIndustryToggle(ind)}
                      className="text-blue-700 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
                      aria-label={`Remove ${ind}`}
                    >
                      <X size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
              {INDUSTRY_OPTIONS.map((industry) => {
                const selected = formData.industry_types.includes(industry)
                return (
                  <label
                    key={industry}
                    className={clsx(
                      'flex items-center gap-2 p-2 border-2 rounded-lg cursor-pointer transition-all',
                      selected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                        : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => handleIndustryToggle(industry)}
                      className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                    />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{industry}</span>
                  </label>
                )
              })}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Other (e.g., Marine Services) and press Add"
                value={otherIndustry}
                onChange={(e) => setOtherIndustry(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddOtherIndustry()
                  }
                }}
                className="input flex-1"
              />
              <Button type="button" variant="secondary" onClick={handleAddOtherIndustry}>Add</Button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description</label>
            <textarea
              rows={3}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="input w-full resize-none"
            />
          </div>
        </div>

        {/* Countries */}
        <div className="pb-6 border-b border-zinc-200 dark:border-zinc-800">
          <label className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 block mb-4">
            Country of Recruitment <span className="text-red-500">*</span>
          </label>
          <div className="mb-3">
            <input
              type="text"
              value={countrySearch}
              onChange={(e) => setCountrySearch(e.target.value)}
              className="input w-full"
              placeholder="Search countries..."
              aria-label="Search countries"
            />
          </div>
          {formData.countries.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {formData.countries.map((country) => (
                <span key={country} className="inline-flex items-center gap-2 bg-primary-50 text-primary-700 px-3 py-1 rounded-full text-sm border border-primary-200">
                  {country}
                  <button
                    type="button"
                    onClick={() => handleCountryToggle(country)}
                    className="text-primary-700 hover:text-primary-900"
                    aria-label={`Remove ${country}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-56 overflow-y-auto pr-1">
            {filteredCountryOptions.map((country) => (
              <label key={country} className={clsx(
                'flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all',
                formData.countries.includes(country)
                  ? 'border-primary-500 bg-primary-50 shadow-sm'
                  : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
              )}>
                <input
                  type="checkbox"
                  checked={formData.countries.includes(country)}
                  onChange={() => handleCountryToggle(country)}
                  className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                />
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{country}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Timeline */}
        <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Timeline</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input type="date" label="Start Date" value={formData.start_date}
              onChange={(e) => setFormData({ ...formData, start_date: e.target.value })} />
            <Input type="date" label="Interview Start Date" value={formData.interview_date}
              onChange={(e) => setFormData({ ...formData, interview_date: e.target.value })} />
            <Input type="date" label="End Date" value={formData.end_date}
              onChange={(e) => setFormData({ ...formData, end_date: e.target.value })} />
          </div>
        </div>

        {/* Positions & Benefits */}
        <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Positions & Benefits</h3>
          <Input
            type="number"
            label="Total Positions"
            min="0"
            value={formData.total_positions}
            onChange={(e) => setFormData({ ...formData, total_positions: parseInt(e.target.value) || 0 })}
          />
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">Benefits Included</label>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {BENEFIT_OPTIONS.map(({ key, label }) => (
                <label key={key} className={clsx(
                  'flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all',
                  formData.benefits[key]
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/30'
                    : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                )}>
                  <input
                    type="checkbox"
                    checked={!!formData.benefits[key]}
                    onChange={() => handleBenefitToggle(key)}
                    className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                  />
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Salary */}
        <div className="space-y-4 pb-6 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Salary Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              type="number"
              label="Minimum Salary"
              value={formData.salary_info.min}
              onChange={(e) => setFormData({ ...formData, salary_info: { ...formData.salary_info, min: e.target.value } })}
            />
            <Input
              type="number"
              label="Maximum Salary"
              value={formData.salary_info.max}
              onChange={(e) => setFormData({ ...formData, salary_info: { ...formData.salary_info, max: e.target.value } })}
            />
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Currency</label>
              <select
                value={formData.salary_info.currency}
                onChange={(e) => setFormData({ ...formData, salary_info: { ...formData.salary_info, currency: e.target.value } })}
                className="input w-full"
              >
                {formData.countries.length > 0 && (
                  <option value={currencyForCountry(formData.countries[0])}>{currencyForCountry(formData.countries[0])} (Auto)</option>
                )}
                <option value="AED">AED</option>
                <option value="QAR">QAR</option>
                <option value="OMR">OMR</option>
                <option value="BHD">BHD</option>
                <option value="SAR">SAR</option>
                <option value="KWD">KWD</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>
        </div>

        {/* Contact */}
        <div className="space-y-4 pb-6">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Contact Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="WhatsApp Number"
              value={formData.contact_info.whatsapp}
              onChange={(e) => setFormData({ ...formData, contact_info: { ...formData.contact_info, whatsapp: e.target.value } })}
            />
            <Input
              label="Client Mobile Number"
              value={formData.contact_info.mobile}
              onChange={(e) => setFormData({ ...formData, contact_info: { ...formData.contact_info, mobile: e.target.value } })}
            />
            <Input
              type="email"
              label="Email"
              value={formData.contact_info.email}
              onChange={(e) => setFormData({ ...formData, contact_info: { ...formData.contact_info, email: e.target.value } })}
            />
          </div>
          <Input
            label="Address"
            value={formData.contact_info.address}
            onChange={(e) => setFormData({ ...formData, contact_info: { ...formData.contact_info, address: e.target.value } })}
          />
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Special Details</label>
            <textarea
              rows={3}
              className="input w-full resize-none"
              value={formData.contact_info.special_details}
              onChange={(e) => setFormData({ ...formData, contact_info: { ...formData.contact_info, special_details: e.target.value } })}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-6 border-t-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 -mx-6 -mb-6 px-6 py-4 rounded-b-xl sticky bottom-0">
          <Button type="button" variant="secondary" onClick={onClose} disabled={updateMutation.isLoading}>
            Cancel
          </Button>
          <Button type="submit" loading={updateMutation.isLoading}>
            Save Changes
          </Button>
        </div>
      </form>
    </Modal>
  )
}
