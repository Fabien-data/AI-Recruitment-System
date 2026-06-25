import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'

// Same base + transport setup the working Communications page uses (it connects
// directly to the Cloud Run backend via VITE_API_URL; sockets don't traverse
// Firebase Hosting).
const API_BASE = import.meta.env.VITE_API_URL || ''

/**
 * useRealtime — one Socket.io connection per mounting page that turns backend
 * events into React Query cache invalidations, so lists go live without the
 * agent hard-refreshing.
 *
 * The backend auto-joins every authenticated socket to the `global` room and
 * broadcasts these events with `io.emit(...)`, so no room-join is needed here.
 * Unlike Communications.jsx (which surgically patches local state for 11 event
 * types), this hook just marks the relevant queries stale → React Query
 * refetches. Simpler, and reuses each page's existing query as-is.
 *
 * @param {object}   opts
 * @param {object}   [opts.handlers]       map of eventName → (payload, queryClient) => void
 * @param {string[]} [opts.events]         event names that should trigger invalidation
 * @param {Array[]}  [opts.invalidateKeys] query keys to invalidate when any `events` fire
 *
 * Pass `events`/`invalidateKeys` as stable references (module-level consts) —
 * the socket connects once per mount and reads handlers via a ref, so changing
 * these between renders won't re-subscribe.
 */
export function useRealtime({ handlers = {}, events = [], invalidateKeys = [] } = {}) {
  const queryClient = useQueryClient()
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const token = useAuthStore.getState().token
    if (!token) return undefined

    const socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
    })

    const bound = []
    const sub = (name, fn) => { socket.on(name, fn); bound.push([name, fn]) }

    // Custom per-event handlers (full control over the payload).
    for (const name of Object.keys(handlersRef.current)) {
      sub(name, (payload) => handlersRef.current[name]?.(payload, queryClient))
    }

    // Sugar: invalidate the given query keys whenever any of `events` arrive.
    if (invalidateKeys.length) {
      for (const name of events) {
        sub(name, () => {
          for (const key of invalidateKeys) {
            queryClient.invalidateQueries({ queryKey: key })
          }
        })
      }
    }

    return () => {
      bound.forEach(([name, fn]) => socket.off(name, fn))
      socket.disconnect()
    }
    // Connect once per mount; handlers come from the ref. `events`/`invalidateKeys`
    // are expected to be stable module-level consts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
