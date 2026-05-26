import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { ConfirmModal } from '../ui/Modal'
import { deleteApplication } from '../../api'

export function DeleteApplicationConfirm({ open, onClose, application }) {
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: () => deleteApplication(application.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['interviews'] })
      toast.success('Application deleted')
      onClose()
    },
    onError: (error) => {
      const code = error.response?.status
      const message = error.response?.data?.error
        || (code === 403 ? 'Only admins can delete applications' : 'Failed to delete application')
      toast.error(message)
    },
  })

  if (!application) return null

  const candidateName = application.candidate_name || 'this candidate'
  const jobTitle = application.job_title || 'this job'

  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      onConfirm={() => deleteMutation.mutate()}
      title="Delete application?"
      message={`Permanently remove the application for ${candidateName} on ${jobTitle}? Any scheduled interview for this application will also be removed. This cannot be undone.`}
      loading={deleteMutation.isPending}
      danger
    />
  )
}
