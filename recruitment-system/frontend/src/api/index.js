import axios from 'axios'

const API_BASE = import.meta.env.VITE_API_URL || ''
export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
})

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

// Jobs
export const getJobs = (params) =>
  apiClient.get('/api/jobs', { params }).then(res => res.data)

export const getJob = (id) =>
  apiClient.get(`/api/jobs/${id}`).then(res => res.data)

export const createJob = (data) =>
  apiClient.post('/api/jobs', data).then(res => res.data)

export const updateJob = (id, data) =>
  apiClient.put(`/api/jobs/${id}`, data).then(res => res.data)

export const deleteJob = (id) =>
  apiClient.delete(`/api/jobs/${id}`).then(res => res.data)

// Applications
export const getApplications = (params) =>
  apiClient.get('/api/applications', { params }).then(res => res.data)

export const createApplication = (data) =>
  apiClient.post('/api/applications', data).then(res => res.data)

export const updateApplication = (id, data) =>
  apiClient.put(`/api/applications/${id}`, data).then(res => res.data)

export const transferApplication = (id, data) =>
  apiClient.post(`/api/applications/${id}/transfer`, data).then(res => res.data)

export const getMatchingCandidates = (jobId) =>
  apiClient.get(`/api/applications/match/${jobId}`).then(res => res.data)

// Communications
export const getCommunications = (candidateId) =>
  apiClient.get(`/api/communications/candidate/${candidateId}`).then(res => res.data)

export const sendCommunication = (data) =>
  apiClient.post('/api/communications/send', data).then(res => res.data)

// Mock Data API (for testing)
export const seedMockData = () =>
  apiClient.post('/api/mock/seed').then(res => res.data)

export const clearMockData = () =>
  apiClient.delete('/api/mock/clear').then(res => res.data)

export const getMockCandidates = () =>
  apiClient.get('/api/mock/candidates').then(res => res.data)

export const getMockProjects = () =>
  apiClient.get('/api/mock/projects').then(res => res.data)

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

// Duplicate detection
export const getDuplicateCandidates = (params) =>
  apiClient.get('/api/candidates/duplicates', { params }).then(res => res.data)

export const mergeCandidates = (data) =>
  apiClient.post('/api/candidates/merge', data).then(res => res.data)

