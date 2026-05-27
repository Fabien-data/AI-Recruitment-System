import { Component } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

// Local route/component-level error boundary. The top-level ErrorBoundary in
// App.jsx catches everything but can't reset on its own — a single crash takes
// the whole app down until reload. Wrap pages or large widgets in this so a
// fault in one place doesn't black-out the entire view, and the user can hit
// "Try again" to remount the subtree without a full reload.
//
// Pass `resetKey` (anything that changes when the user navigates / picks a new
// resource) to clear the error state automatically on key change. Pass `name`
// to label the message — useful when the boundary is reused.
export class ErrorBoundary extends Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error(`ErrorBoundary[${this.props.name || 'anon'}] caught:`, error, info)
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null })
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    if (this.props.fallback) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback({ error: this.state.error, reset: () => this.setState({ hasError: false, error: null }) })
        : this.props.fallback
    }

    return (
      <div className="m-4 rounded-2xl border border-red-200 bg-red-50 p-6 dark:border-red-900/40 dark:bg-red-950/30">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-red-600 dark:text-red-300" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-red-900 dark:text-red-200">
              {this.props.title || 'Something went wrong'}
            </h3>
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-3 inline-flex items-center gap-1 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-900 dark:text-red-300"
            >
              <RefreshCw size={14} />
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
