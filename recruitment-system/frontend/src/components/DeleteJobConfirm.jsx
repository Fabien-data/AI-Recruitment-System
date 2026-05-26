import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteJob } from '../api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'

export function DeleteJobConfirm({ isOpen, job, onClose }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => deleteJob(job.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Job deleted and removed from chatbot')
      onClose()
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to delete job'),
  })

  if (!job) return null

  return (
    <Modal open={isOpen} onClose={onClose} title="Delete job?" size="sm">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900/50 dark:bg-rose-950/30">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-rose-600 dark:text-rose-400" />
          <div className="text-sm text-rose-900 dark:text-rose-200">
            <p className="font-medium">This cannot be undone.</p>
            <p className="mt-1">
              <span className="font-semibold">{job.title}</span> will be permanently deleted from the
              database and removed from the chatbot knowledge base.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={mutation.isLoading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => mutation.mutate()}
            disabled={mutation.isLoading}
            className="bg-rose-600 hover:bg-rose-700"
          >
            {mutation.isLoading ? 'Deleting...' : 'Delete Job'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
