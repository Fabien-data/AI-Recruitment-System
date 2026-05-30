import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || ''
export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
})

function downloadBlobResponse(response, fallbackName = 'export.csv') {
  const disposition = response.headers?.['content-disposition'] || ''
  const match = disposition.match(/filename=([^;]+)/i)
  const rawName = match?.[1]?.trim()?.replace(/^"|"$/g, '')
  const fileName = rawName || fallbackName
  const blob = new Blob([response.data], { type: response.headers?.['content-type'] || 'text/csv' })
  const blobUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = blobUrl
  link.setAttribute('download', fileName)
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(blobUrl)
}

// Auth API
export const login = (credentials) =>
  apiClient.post('/api/auth/login', credentials).then(res => res.data)

export const register = (data) =>
  apiClient.post('/api/auth/register', data).then(res => res.data)

// Candidates
export const getCandidates = (params) =>
  apiClient.get('/api/candidates', { params }).then(res => res.data)

export const getCandidate = (id) =>
  apiClient.get(`/api/candidates/${id}`).then(res => res.data)

export const createCandidate = (data) =>
  apiClient.post('/api/candidates', data).then(res => res.data)

export const updateCandidate = (id, data) =>
  apiClient.put(`/api/candidates/${id}`, data).then(res => res.data)

export const deleteCandidate = (id) =>
  apiClient.delete(`/api/candidates/${id}`).then(res => res.data)

export const resolveCandidateIntervention = (id) =>
  apiClient.post(`/api/candidates/${id}/resolve-intervention`).then(res => res.data)

// Re-run AI extraction on a stored CV/document (Auto-OCR / re-parse fallback).
export const reparseCv = (cvId) =>
  apiClient.post(`/api/candidates/cv/${cvId}/reparse`).then(res => res.data)

// Jobs
export const getJobs = (params) =>
  apiClient.get('/api/jobs', { params }).then(res => res.data)

export const getJob = (id) =>
  apiClient.get(`/api/jobs/${id}`).then(res => res.data)

export const createJob = (data) =>
  apiClient.post('/api/jobs', data).then(res => res.data)

export const magicCreateJob = (formData) =>
  apiClient.post('/api/jobs/magic-create', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(res => res.data)

// Review-first AI ingestion: parses the flyer and returns extracted fields
// for the agent to review/edit. Nothing is written to the DB until the
// FlyerReviewModal calls createProject + createJob.
export const extractJobFlyers = (formData) =>
  apiClient.post('/api/jobs/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(res => res.data)

export const updateJob = (id, data) =>
  apiClient.put(`/api/jobs/${id}`, data).then(res => res.data)

export const deleteJob = (id) =>
  apiClient.delete(`/api/jobs/${id}`).then(res => res.data)

export const refreshJobKnowledgeBase = () =>
  apiClient.post('/api/chatbot-sync/refresh-jobs').then(res => res.data)

// Resync ALL knowledge (jobs + projects + FAQs) to the chatbot via the outbox.
export const fullResyncChatbot = () =>
  apiClient.post('/api/chatbot-sync/full-resync').then(res => res.data)

export const getChatbotOutboxStatus = () =>
  apiClient.get('/api/chatbot-sync/outbox-status').then(res => res.data)

// Ad Links (Meta Click-to-WhatsApp campaign links per job)
export const getAdLinks = (params) =>
  apiClient.get('/api/ad-links', { params }).then(res => res.data)

export const generateAdLink = (data) =>
  apiClient.post('/api/ad-links/generate', data).then(res => res.data)

export const toggleAdLink = (adRef) =>
  apiClient.patch(`/api/ad-links/${adRef}/toggle`).then(res => res.data)

export const deleteAdLink = (adRef) =>
  apiClient.delete(`/api/ad-links/${adRef}`).then(res => res.data)

// Knowledge Base
export const getKnowledgeBaseEntries = (params) =>
  apiClient.get('/api/knowledge-base', { params }).then(res => res.data)

export const getKnowledgeBaseCategories = (params) =>
  apiClient.get('/api/knowledge-base/categories', { params }).then(res => res.data)

export const createKnowledgeBaseEntry = (data) =>
  apiClient.post('/api/knowledge-base', data).then(res => res.data)

export const updateKnowledgeBaseEntry = (id, data) =>
  apiClient.put(`/api/knowledge-base/${id}`, data).then(res => res.data)

export const deleteKnowledgeBaseEntry = (id) =>
  apiClient.delete(`/api/knowledge-base/${id}`).then(res => res.data)

export const importKnowledgeBaseEntries = (entries, tenant_id = null) =>
  apiClient.post('/api/knowledge-base/import', { tenant_id, entries }).then(res => res.data)

// Knowledge Base Documents (PDF/DOCX/TXT uploads parsed + chunked for the chatbot)
export const getKnowledgeDocuments = (params) =>
  apiClient.get('/api/knowledge-documents', { params }).then(res => res.data)

export const uploadKnowledgeDocument = (file, { title, category } = {}) => {
  const formData = new FormData()
  formData.append('file', file)
  if (title) formData.append('title', title)
  if (category) formData.append('category', category)
  return apiClient.post('/api/knowledge-documents', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(res => res.data)
}

export const deleteKnowledgeDocument = (id) =>
  apiClient.delete(`/api/knowledge-documents/${id}`).then(res => res.data)

export const getKnowledgeDocumentChunks = (id) =>
  apiClient.get(`/api/knowledge-documents/${id}/chunks`).then(res => res.data)

// Applications
export const getApplications = (params) =>
  apiClient.get('/api/applications', { params }).then(res => res.data)

export const createApplication = (data) =>
  apiClient.post('/api/applications', data).then(res => res.data)

export const updateApplication = (id, data) =>
  apiClient.put(`/api/applications/${id}`, data).then(res => res.data)

export const transferApplication = (id, data) =>
  apiClient.post(`/api/applications/${id}/transfer`, data).then(res => res.data)

export const deleteApplication = (id) =>
  apiClient.delete(`/api/applications/${id}`).then(res => res.data)

export const getMatchingCandidates = (jobId) =>
  apiClient.get(`/api/applications/match/${jobId}`).then(res => res.data)

// Communications
export const getCommunications = (candidateId) =>
  apiClient.get(`/api/communications/candidate/${candidateId}`).then(res => res.data)

export const sendCommunication = (data) =>
  apiClient.post(
    '/api/communications/send',
    data,
    data instanceof FormData
      ? { headers: { 'Content-Type': 'multipart/form-data' } }
      : undefined
  ).then(res => res.data)

// Auto-Assign API
export const getJobCandidates = (jobId) =>
  apiClient.get(`/api/auto-assign/job/${jobId}/candidates`).then(res => res.data)

export const autoAssignCandidate = (candidateId, threshold = 50) =>
  apiClient.post(`/api/auto-assign/candidate/${candidateId}`, { threshold }).then(res => res.data)

export const batchAutoAssign = (threshold = 50, status = 'new') =>
  apiClient.post('/api/auto-assign/batch', { threshold, status }).then(res => res.data)

export const getGeneralPool = (params) =>
  apiClient.get('/api/auto-assign/pool', { params }).then(res => res.data)

// Projects
export const getProjects = (params) =>
  apiClient.get('/api/projects', { params }).then(res => res.data)

export const getProject = (id) =>
  apiClient.get(`/api/projects/${id}`).then(res => res.data)

export const createProject = (data) =>
  apiClient.post('/api/projects', data).then(res => res.data)

export const updateProject = (id, data) =>
  apiClient.put(`/api/projects/${id}`, data).then(res => res.data)

export const deleteProject = (id) =>
  apiClient.delete(`/api/projects/${id}`).then(res => res.data)

export const getProjectJobs = (id) =>
  apiClient.get(`/api/projects/${id}/jobs`).then(res => res.data)

export const createProjectJob = (projectId, data) =>
  apiClient.post(`/api/projects/${projectId}/jobs`, data).then(res => res.data)

export const getProjectCandidates = (id, params) =>
  apiClient.get(`/api/projects/${id}/candidates`, { params }).then(res => res.data)

export const assignProjectTeam = (id, data) =>
  apiClient.post(`/api/projects/${id}/assign-team`, data).then(res => res.data)

export const removeProjectTeam = (id, userId) =>
  apiClient.delete(`/api/projects/${id}/team/${userId}`).then(res => res.data)

export const getProjectStats = (id) =>
  apiClient.get(`/api/projects/${id}/stats`).then(res => res.data)

export const exportProjectCsv = async (id, params = {}) => {
  const response = await apiClient.get(`/api/projects/${id}/export/csv`, {
    params,
    responseType: 'blob'
  })
  downloadBlobResponse(response, `project_${id}_applications_export.csv`)
}

// Candidate Workflow APIs
export const rejectToPool = (applicationId, data) =>
  apiClient.post(`/api/applications/${applicationId}/reject-to-pool`, data).then(res => res.data)

export const certifyApplication = (applicationId, data) =>
  apiClient.put(`/api/applications/${applicationId}`, data).then(res => res.data)

// Notification History
export const getNotificationHistory = (candidateId) =>
  apiClient.get(`/api/communications/candidate/${candidateId}/notifications`).then(res => res.data)

// Bulk Communication
export const sendBulkCommunication = (data) =>
  apiClient.post('/api/communications/send-bulk', data).then(res => res.data)

// Batch certify
export const batchCertifyApplications = (data) =>
  apiClient.post('/api/applications/batch-certify', data).then(res => res.data)

// Interviews
export const getInterviews = (params) =>
  apiClient.get('/api/interviews', { params }).then(res => res.data)

export const getUpcomingInterviews = () =>
  apiClient.get('/api/interviews/upcoming').then(res => res.data)

export const getInterview = (id) =>
  apiClient.get(`/api/interviews/${id}`).then(res => res.data)

export const createInterview = (data) =>
  apiClient.post('/api/interviews', data).then(res => res.data)

export const updateInterview = (id, data) =>
  apiClient.put(`/api/interviews/${id}`, data).then(res => res.data)

export const deleteInterview = (id) =>
  apiClient.delete(`/api/interviews/${id}`).then(res => res.data)

export const sendInterviewReminder = (id, data) =>
  apiClient.post(`/api/interviews/${id}/remind`, data).then(res => res.data)

// Analytics
export const getAnalyticsOverview = (params) =>
  apiClient.get('/api/analytics/overview', { params }).then(res => res.data)

export const getJobPipeline = (jobId) =>
  apiClient.get(`/api/analytics/jobs/${jobId}/pipeline`).then(res => res.data)

export const getRecruiterPerformance = (params) =>
  apiClient.get('/api/analytics/recruiter-performance', { params }).then(res => res.data)

export const getAdPerformance = () =>
  apiClient.get('/api/analytics/ad-performance').then(res => res.data)

export const exportAnalyticsCsv = async (params = {}) => {
  const response = await apiClient.get('/api/analytics/export', {
    params,
    responseType: 'blob'
  })
  downloadBlobResponse(response, 'recruitment_export.csv')
}

// Duplicate detection
export const getDuplicateCandidates = (params) =>
  apiClient.get('/api/candidates/duplicates', { params }).then(res => res.data)

export const mergeCandidates = (data) =>
  apiClient.post('/api/candidates/merge', data).then(res => res.data)

// Candidate photo upload
export const uploadCandidatePhoto = (id, formData) =>
  apiClient.post(`/api/candidates/${id}/photo`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(res => res.data)

// Admin APIs
export const getAdminStats = () =>
  apiClient.get('/api/admin/stats').then(res => res.data)

export const getAdminUsers = (params) =>
  apiClient.get('/api/admin/users', { params }).then(res => res.data)

export const createAdminUser = (data) =>
  apiClient.post('/api/admin/users', data).then(res => res.data)

export const updateAdminUser = (id, data) =>
  apiClient.put(`/api/admin/users/${id}`, data).then(res => res.data)

export const deleteAdminUser = (id) =>
  apiClient.delete(`/api/admin/users/${id}`).then(res => res.data)

export const getAuditLogs = (params) =>
  apiClient.get('/api/admin/audit-logs', { params }).then(res => res.data)

// ── Admin Observability (Migration 021) ────────────────────────────────────
export const getSections = () =>
  apiClient.get('/api/admin/sections').then(res => res.data)

export const getUserPermissions = (userId) =>
  apiClient.get(`/api/admin/users/${userId}/permissions`).then(res => res.data)

export const updateUserPermissions = (userId, permissions) =>
  apiClient.put(`/api/admin/users/${userId}/permissions`, { permissions }).then(res => res.data)

export const getUserActivity = (userId, params) =>
  apiClient.get(`/api/admin/users/${userId}/activity`, { params }).then(res => res.data)

export const getUserSessions = (userId, params) =>
  apiClient.get(`/api/admin/users/${userId}/sessions`, { params }).then(res => res.data)

export const getUserKpi = (userId, params) =>
  apiClient.get(`/api/admin/users/${userId}/kpi`, { params }).then(res => res.data)

export const getGlobalActivity = (params) =>
  apiClient.get('/api/admin/activity', { params }).then(res => res.data)

export const logoutBackend = () =>
  apiClient.post('/api/auth/logout').then(res => res.data)

// ── Marketing Hub ──────────────────────────────────────────────────────────
export const getLeads = (params) =>
  apiClient.get('/api/marketing-hub/leads', { params }).then(res => res.data)

export const getLead = (id) =>
  apiClient.get(`/api/marketing-hub/leads/${id}`).then(res => res.data)

export const createLead = (data) =>
  apiClient.post('/api/marketing-hub/leads', data).then(res => res.data)

export const updateLead = (id, data) =>
  apiClient.patch(`/api/marketing-hub/leads/${id}`, data).then(res => res.data)

export const deleteLead = (id) =>
  apiClient.delete(`/api/marketing-hub/leads/${id}`).then(res => res.data)

export const uploadLeadDocument = (leadId, file, docType = 'other') => {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('doc_type', docType)
  return apiClient.post(`/api/marketing-hub/leads/${leadId}/documents`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(res => res.data)
}

export const deleteLeadDocument = (docId) =>
  apiClient.delete(`/api/marketing-hub/documents/${docId}`).then(res => res.data)

export const convertLead = (id, data = {}) =>
  apiClient.post(`/api/marketing-hub/leads/${id}/convert`, data).then(res => res.data)

export const searchJobsForLead = (q, limit = 10) =>
  apiClient.get('/api/marketing-hub/job-search', { params: { q, limit } }).then(res => res.data)

export const getMarketingCountries = () =>
  apiClient.get('/api/marketing-hub/countries').then(res => res.data)

export const getLeadSources = () =>
  apiClient.get('/api/marketing-hub/lead-sources').then(res => res.data)

export const getLeadFollowUps = (leadId) =>
  apiClient.get(`/api/marketing-hub/leads/${leadId}/follow-ups`).then(res => res.data)

export const createLeadFollowUp = (leadId, data) =>
  apiClient.post(`/api/marketing-hub/leads/${leadId}/follow-ups`, data).then(res => res.data)

export const updateLeadFollowUp = (id, data) =>
  apiClient.patch(`/api/marketing-hub/follow-ups/${id}`, data).then(res => res.data)

export const getDueFollowUps = () =>
  apiClient.get('/api/marketing-hub/follow-ups/due').then(res => res.data)

export const getLeadTemplates = () =>
  apiClient.get('/api/marketing-hub/templates').then(res => res.data)

export const sendLeadTemplate = (leadId, template_key, channel) =>
  apiClient.post(`/api/marketing-hub/leads/${leadId}/send-template`, { template_key, channel }).then(res => res.data)

// ── Marketing Hub Analytics ───────────────────────────────────────────────
export const getMarketingOverview = (range = '30d') =>
  apiClient.get('/api/marketing-hub/analytics/overview', { params: { range } }).then(res => res.data)

export const getMarketingFunnel = (range = '30d') =>
  apiClient.get('/api/marketing-hub/analytics/funnel', { params: { range } }).then(res => res.data)

export const getMarketingBySource = (range = '30d') =>
  apiClient.get('/api/marketing-hub/analytics/by-source', { params: { range } }).then(res => res.data)

export const getMarketingByAgent = (range = '30d') =>
  apiClient.get('/api/marketing-hub/analytics/by-agent', { params: { range } }).then(res => res.data)

export const getMarketingTimeseries = (range = '30d') =>
  apiClient.get('/api/marketing-hub/analytics/timeseries', { params: { range } }).then(res => res.data)

export const getMarketingCohort = (range = '90d') =>
  apiClient.get('/api/marketing-hub/analytics/cohort', { params: { range } }).then(res => res.data)

export const getMarketingTimeToStage = (range = '30d') =>
  apiClient.get('/api/marketing-hub/analytics/time-to-stage', { params: { range } }).then(res => res.data)

export const exportMarketingLeadsCsv = async (range = '30d') => {
  const response = await apiClient.get('/api/marketing-hub/analytics/export.csv', {
    params: { range },
    responseType: 'blob',
  })
  downloadBlobResponse(response, `marketing_leads_${range}.csv`)
}

