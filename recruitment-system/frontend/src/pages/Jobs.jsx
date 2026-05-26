import { useState, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useDropzone } from 'react-dropzone'
import { getJobs, magicCreateJob, refreshJobKnowledgeBase } from '../api'
import { Briefcase, FolderKanban, Plus, Sparkles, UploadCloud, RefreshCw, Loader2 } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Card } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { CreateJobModal } from '../components/CreateJobModal'
import toast from 'react-hot-toast'

const MAX_FLYERS_PER_BATCH = 20

export default function Jobs() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('active')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [urgentOnly, setUrgentOnly] = useState(false)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [uploadState, setUploadState] = useState({
    isProcessing: false,
    filenames: [],
    result: null,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['jobs', { status: statusFilter, category: categoryFilter || undefined }],
    queryFn: () => getJobs({ status: statusFilter, category: categoryFilter || undefined })
  })

  const refreshMutation = useMutation({
    mutationFn: refreshJobKnowledgeBase,
    onSuccess: (result) => {
      toast.success(`Knowledge base refreshed for ${result.total || 0} active jobs`)
    },
    onError: () => {
      toast.error('Failed to refresh knowledge base')
    },
  })

  const handleFlyerUpload = useCallback(async (acceptedFiles) => {
    if (!acceptedFiles?.length) return

    const filenames = acceptedFiles.map((file) => file.name)
    setUploadState({ isProcessing: true, filenames, result: null })

    const formData = new FormData()
    acceptedFiles.forEach((file) => {
      formData.append('flyer', file)
    })

    try {
      const result = await magicCreateJob(formData)
      setUploadState({ isProcessing: false, filenames, result })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success(
        result.failed > 0
          ? `Processed ${result.succeeded || 0} of ${result.totalFiles || filenames.length} flyers`
          : `Processed ${result.succeeded || filenames.length} flyer${(result.succeeded || filenames.length) === 1 ? '' : 's'}`
      )
    } catch (error) {
      setUploadState(prev => ({ ...prev, isProcessing: false }))
      toast.error(error.response?.data?.error || 'Failed to process flyer')
    }
  }, [queryClient])

  const handleDropRejected = useCallback((rejections) => {
    if (!rejections?.length) return

    const tooMany = rejections.some((item) =>
      item.errors?.some((error) => error.code === 'too-many-files')
    )

    if (tooMany) {
      toast.error(`You can upload up to ${MAX_FLYERS_PER_BATCH} flyers at once.`)
      return
    }

    toast.error('Some files were rejected. Please upload image files only (JPG, PNG, WEBP).')
  }, [])

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: handleFlyerUpload,
    onDropRejected: handleDropRejected,
    accept: { 'image/*': ['.jpeg', '.jpg', '.png', '.webp'] },
    multiple: true,
    maxFiles: MAX_FLYERS_PER_BATCH,
    noClick: true,
    noKeyboard: true,
  })

  const visibleFilenames = uploadState.filenames.slice(0, 3)
  const hiddenFilenameCount = Math.max(0, uploadState.filenames.length - visibleFilenames.length)
  const uploadResultItems = uploadState.result
    ? [
        ...(uploadState.result.results || []).map((item, index) => ({
          key: `success-${item.fileName}-${index}`,
          fileName: item.fileName,
          jobsCount: item.jobs?.length || 0,
          status: 'success',
          message: item.message || 'Processed',
        })),
        ...(uploadState.result.failures || []).map((item, index) => ({
          key: `failed-${item.fileName}-${index}`,
          fileName: item.fileName,
          jobsCount: 0,
          status: 'failed',
          message: item.error || 'Failed to process',
        })),
      ]
    : []

  const jobsListAll = data?.data || []
  const jobsList = urgentOnly ? jobsListAll.filter(j => j.is_urgent) : jobsListAll

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={Briefcase}
        tone="blue"
        title="Jobs"
        subtitle="View and manage job listings. Drop a flyer to auto-create a job and push it to the chatbot knowledge base."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => refreshMutation.mutate()}
              loading={refreshMutation.isPending}
            >
              {!refreshMutation.isPending && <RefreshCw size={16} />}
              Refresh Knowledge Base
            </Button>
            <Button variant="secondary" onClick={() => setIsCreateModalOpen(true)}>
              <Plus size={16} />
              Create Job Manually
            </Button>
            <Button variant="primary" onClick={open}>
              <Sparkles size={16} />
              Magic Create Flyers
            </Button>
          </>
        }
      />

      <Card className="mb-6 overflow-hidden">
        <div
          {...getRootProps()}
          className={`group relative rounded-3xl border border-dashed p-6 md:p-8 transition-all duration-300 ${isDragActive ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/40/70'}`}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white">
                <Sparkles size={12} />
                AI ingestion
              </div>
              <h2 className="mt-4 text-2xl font-bold tracking-tight text-zinc-900">Magic Create from job flyers</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                Upload one or many posters, social images, or flyers. The backend extracts each role, creates the project and job records, and refreshes the chatbot knowledge base when the roles are ready to go live.
              </p>

              <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-600">
                <span className="rounded-full bg-zinc-100 px-3 py-1 font-medium">Project auto-detection</span>
                <span className="rounded-full bg-zinc-100 px-3 py-1 font-medium">Structured requirements</span>
                <span className="rounded-full bg-zinc-100 px-3 py-1 font-medium">Pending review for low confidence</span>
              </div>

              {uploadState.filenames.length > 0 && (
                <p className="mt-4 text-sm text-zinc-500">
                  {uploadState.filenames.length > 1 ? 'Last files:' : 'Last file:'}{' '}
                  <span className="font-semibold text-zinc-900">
                    {visibleFilenames.join(', ')}
                    {hiddenFilenameCount > 0 ? ` +${hiddenFilenameCount} more` : ''}
                  </span>
                </p>
              )}
            </div>

            <div className="flex flex-col items-start gap-3 lg:items-end">
              <div className="flex items-center gap-3 rounded-3xl bg-zinc-950 px-4 py-3 text-white shadow-lg">
                <div className="rounded-2xl bg-white dark:bg-zinc-900/10 p-2">
                  <UploadCloud size={18} />
                </div>
                <div>
                  <p className="text-sm font-semibold">Drop files here</p>
                  <p className="text-xs text-zinc-300">JPG, PNG, or WEBP. Up to {MAX_FLYERS_PER_BATCH} files per batch.</p>
                </div>
              </div>
              <Button variant="secondary" onClick={open}>
                Choose files
              </Button>
            </div>
          </div>

          {uploadState.isProcessing && (
            <div className="absolute inset-0 flex items-center justify-center rounded-3xl bg-white dark:bg-zinc-900/80 backdrop-blur-sm">
              <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 shadow-lg">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-900" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900">AI is analyzing the flyer</p>
                  <p className="text-xs text-zinc-500">Creating jobs and updating the knowledge base.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {uploadState.result && (
        <Card className="mb-6 p-5 border-zinc-200 dark:border-zinc-800 bg-zinc-50/80">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">Latest ingestion</p>
              <h3 className="mt-1 text-lg font-bold text-zinc-900">
                {uploadState.result.totalFiles > 1
                  ? `${uploadState.result.succeeded || 0} flyers processed`
                  : (uploadState.result.results?.[0]?.project?.title || uploadState.result.results?.[0]?.project?.name || 'Flyer processed')}
              </h3>
              <p className="mt-1 text-sm text-zinc-600">
                {uploadState.result.totalFiles || uploadState.result.results?.length || 0} file(s) selected. {uploadState.result.succeeded || 0} succeeded, {uploadState.result.failed || 0} failed.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(uploadState.result.results || []).map((item, index) => (
                <span key={`${item.fileName}-${index}`} className="rounded-full bg-white dark:bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-700 shadow-sm border border-zinc-200 dark:border-zinc-800">
                  {item.fileName} · {item.jobs?.length || 0} job(s)
                </span>
              ))}
            </div>
          </div>
          {(uploadState.result.failures || []).length > 0 && (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {uploadState.result.failures.length} flyer(s) failed. The successful uploads are already saved.
            </div>
          )}

          {uploadResultItems.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50">
                    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">File</th>
                    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">Jobs Created</th>
                    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {uploadResultItems.map((item) => (
                    <tr key={item.key} className="border-b border-zinc-100 last:border-b-0">
                      <td className="px-4 py-2 text-sm text-zinc-800">{item.fileName}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${item.status === 'success' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                          {item.status === 'success' ? 'Success' : 'Failed'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm text-zinc-700">{item.jobsCount}</td>
                      <td className="px-4 py-2 text-sm text-zinc-600">{item.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Filters */}
      <div className="card mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input w-full sm:w-40"
              aria-label="Filter by status"
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="closed">Closed</option>
              <option value="filled">Filled</option>
              <option value="">All</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Category</label>
            <input
              type="text"
              placeholder="e.g. security, hospitality"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="input"
              aria-label="Filter by category"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={urgentOnly}
                onChange={(e) => setUrgentOnly(e.target.checked)}
              />
              Urgent only
            </label>
          </div>
        </div>
      </div>

      {/* Jobs List */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : jobsList.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 dark:text-zinc-400">
            <Briefcase className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600 mb-2" aria-hidden />
            <p className="font-medium">No jobs found</p>
            <p className="text-sm mt-1">Adjust your filters or create a new job.</p>
            <div className="mt-4 flex justify-center">
              <Button variant="primary" onClick={() => setIsCreateModalOpen(true)}>
                <Plus size={16} />
                Create Job Manually
              </Button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60">
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Title</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Category</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Project</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Positions</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobsList.map((job) => (
                  <tr key={job.id} className="border-b border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td className="py-3 px-4 font-medium text-zinc-900 dark:text-zinc-50">
                      <div className="flex items-center gap-2">
                        <span>{job.title}</span>
                        {job.is_urgent && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                            Urgent
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-zinc-600 dark:text-zinc-400">{job.category}</td>
                    <td className="py-3 px-4">
                      {job.project_title ? (
                        <Link 
                          to={`/projects/${job.project_id}`}
                          className="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700"
                        >
                          <FolderKanban size={14} />
                          <span>{job.project_title}</span>
                        </Link>
                      ) : (
                        <span className="text-zinc-400 dark:text-zinc-500 text-sm">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <Badge status={job.status} />
                    </td>
                    <td className="py-3 px-4 text-zinc-600 dark:text-zinc-400">
                      {job.positions_filled ?? 0} / {job.positions_available ?? 1}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex gap-2">
                        <Link
                          to={`/jobs/${job.id}/candidates`}
                          className="text-primary-600 hover:text-primary-700 font-medium text-sm"
                        >
                          View Candidates
                        </Link>
                        <span className="text-zinc-300 dark:text-zinc-600">|</span>
                        <Link
                          to={`/jobs/${job.id}`}
                          className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:text-zinc-300 font-medium text-sm"
                        >
                          Details
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateJobModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </div>
  )
}
