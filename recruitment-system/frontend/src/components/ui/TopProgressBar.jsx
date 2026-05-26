import { useEffect, useRef, useState } from 'react'
import { useIsFetching, useIsMutating } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'

// Thin progress bar pinned to the top of the viewport. Visible during route
// changes and while any react-query fetch or mutation is in flight.
export function TopProgressBar() {
  const fetching = useIsFetching()
  const mutating = useIsMutating()
  const location = useLocation()
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState(0)
  const intervalRef = useRef(null)
  const hideTimerRef = useRef(null)

  const busy = fetching > 0 || mutating > 0

  useEffect(() => {
    setVisible(true)
    setProgress(15)
    const t = setTimeout(() => setProgress(60), 80)
    const finish = setTimeout(() => {
      setProgress(100)
      const hide = setTimeout(() => setVisible(false), 280)
      return () => clearTimeout(hide)
    }, 300)
    return () => {
      clearTimeout(t)
      clearTimeout(finish)
    }
  }, [location.pathname])

  useEffect(() => {
    if (busy) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      setVisible(true)
      setProgress((p) => (p < 20 ? 20 : p))
      intervalRef.current = setInterval(() => {
        setProgress((p) => (p < 85 ? p + (90 - p) * 0.15 : p))
      }, 220)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
      setProgress(100)
      hideTimerRef.current = setTimeout(() => {
        setVisible(false)
        setProgress(0)
      }, 300)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [busy])

  return (
    <div className="pointer-events-none fixed top-0 left-0 right-0 z-[60] h-[2px]">
      <div
        className="h-full bg-mixed-gradient bg-[length:200%_100%] animate-gradient-shift shadow-glow-blue transition-[width,opacity] duration-200 ease-out"
        style={{
          width: `${progress}%`,
          opacity: visible ? 1 : 0,
        }}
      />
    </div>
  )
}
