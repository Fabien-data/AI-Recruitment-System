/**
 * Communications.jsx — Live Agent Chat Dashboard
 * ================================================
 * Three-panel layout:
 *   Left:   Active chat list with real-time activity badges
 *   Center: Full scrollable transcript with bot/agent/candidate bubbles
 *   Right:  Candidate context card (profile, job interest, state)
 *
 * Real-time via Socket.io:
 *   - new_message      → append message to transcript
 *   - chat_activity    → update last message in left list
 *   - handoff_start    → show "Agent Active" badge
 *   - handoff_end      → show "Bot Active" badge
 *   - agent_typing     → typing indicator in transcript
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import {
  MessageSquare, Search, Send, Phone, Mail, Bot, User,
  UserCheck, RefreshCw, Globe, Briefcase, MapPin, Clock,
  ChevronRight, AlertCircle, Wifi, WifiOff, Loader2
} from 'lucide-react'
import { clsx } from 'clsx'
import { format, formatDistanceToNow } from 'date-fns'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { getCommunications, sendCommunication } from '../api'
import { useAuthStore } from '../stores/authStore'

// ── API helpers ──────────────────────────────────────────────────────────────

const API_BASE = 'http://localhost:3000'; // Hardcoded for local test

async function apiFetch(path, opts = {}) {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`)
  return res.json()
}

const getActiveChats = (search) => apiFetch(`/api/communications/active-chats?search=${encodeURIComponent(search || '')}&limit=100`)
const getTranscript = (id) => apiFetch(`/api/communications/candidate/${id}?limit=200`)
const takeover = (id) => apiFetch(`/api/communications/candidate/${id}/takeover`, { method: 'POST' })
const release = (id) => apiFetch(`/api/communications/candidate/${id}/release`, { method: 'POST' })
const sendMsg = (body) => apiFetch('/api/communications/send', { method: 'POST', body: JSON.stringify(body) })

// ── Language badge ────────────────────────────────────────────────────────────

const LANG_LABEL = { en: 'EN', si: 'SI', ta: 'TA', singlish: 'SL', tanglish: 'TL' }
const LANG_COLOR = {
  en: 'bg-blue-100 text-blue-700', si: 'bg-yellow-100 text-yellow-700',
  ta: 'bg-orange-100 text-orange-700', singlish: 'bg-emerald-100 text-emerald-700',
  tanglish: 'bg-purple-100 text-purple-700',
}

function LangBadge({ lang }) {
  if (!lang) return null
  return (
    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded-full', LANG_COLOR[lang] || 'bg-gray-100 text-gray-600')}>
      {LANG_LABEL[lang] || lang.toUpperCase()}
    </span>
  )
}

// ── Sender avatar ─────────────────────────────────────────────────────────────

function MsgBubble({ msg }) {
  const isInbound = msg.direction === 'inbound'
  const isSystem = msg.sender_type === 'system'
  const isAgent = msg.sender_type === 'agent'

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs bg-amber-50 text-amber-600 border border-amber-200 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    )
  }

  return (
    <div className={clsx('flex gap-2 mb-3', isInbound ? 'justify-start' : 'justify-end')}>
      {isInbound && (
        <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center shrink-0 mt-1">
          <User size={14} className="text-slate-500" />
        </div>
      )}
      <div className={clsx('max-w-[68%]', isInbound ? '' : 'items-end flex flex-col')}>
        {isAgent && (
          <span className="text-[10px] text-indigo-500 font-semibold mb-0.5 mr-1">
            {msg.sender_name || 'Agent'}
          </span>
        )}
        <div className={clsx(
          'rounded-2xl px-4 py-2.5 shadow-sm text-sm whitespace-pre-wrap break-words',
          isInbound
            ? 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
            : isAgent
              ? 'bg-indigo-600 text-white rounded-tr-none'
              : 'bg-primary-600 text-white rounded-tr-none'
        )}>
          {msg.content}
        </div>
        <div className={clsx('flex items-center gap-1 mt-0.5 text-[10px] text-gray-400', isInbound ? 'ml-1' : 'mr-1 flex-row-reverse')}>
          <span>{format(new Date(msg.sent_at), 'HH:mm')}</span>
          {msg.detected_language && <LangBadge lang={msg.detected_language} />}
          {!isInbound && (
            <span>{isAgent ? '🧑‍💼' : '🤖'}</span>
          )}
        </div>
      </div>
      {!isInbound && (
        <div className={clsx(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-1',
          isAgent ? 'bg-indigo-100' : 'bg-primary-100'
        )}>
          {isAgent ? <UserCheck size={14} className="text-indigo-600" /> : <Bot size={14} className="text-primary-600" />}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Communications() {
  const [selectedId, setSelectedId] = useState(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [chatList, setChatList] = useState([])
  const [transcript, setTranscript] = useState([])
  const [connected, setConnected] = useState(false)
  const [agentTyping, setAgentTyping] = useState(null)
  const [sendError, setSendError] = useState(null)
  const socketRef = useRef(null)
  const bottomRef = useRef(null)
  const queryClient = useQueryClient()

  // Selected candidate object from chatList
  const selectedCandidate = chatList.find(c => c.candidate_id === selectedId)

  // ── Fetch active chat list ─────────────────────────────────────────────────
  const { isLoading: listLoading } = useQuery({
    queryKey: ['active-chats', search],
    queryFn: () => getActiveChats(search),
    onSuccess: (data) => {
      setChatList(prev => {
        // Merge API data with any real-time updates we received
        const merged = Array.isArray(data) ? data : []
        return merged
      })
    },
    refetchInterval: 30000, // fallback poll every 30s
  })

  // ── Fetch transcript when candidate changes ────────────────────────────────
  const { isLoading: transcriptLoading } = useQuery({
    queryKey: ['transcript', selectedId],
    queryFn: () => getTranscript(selectedId),
    enabled: !!selectedId,
    onSuccess: (data) => setTranscript(Array.isArray(data) ? data : []),
  })

  // ── Socket.io real-time ────────────────────────────────────────────────────
  useEffect(() => {
    const token = useAuthStore.getState().token
    if (!token) {
      console.warn("Communications.jsx: No auth token found. Cannot connect Socket.io.")
      return
    }

    const socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      // Re-join current candidate room after reconnect
      if (selectedId) socket.emit('join_candidate', selectedId)
    })
    socket.on('disconnect', () => setConnected(false))

    socket.on('new_message', (msg) => {
      setTranscript(prev => [...prev, msg])
      // Update last message in chat list
      setChatList(prev => prev.map(c =>
        c.candidate_id === msg.candidate_id
          ? { ...c, last_message: msg.content, last_message_at: msg.sent_at, last_direction: msg.direction }
          : c
      ))
    })

    socket.on('chat_activity', (activity) => {
      setChatList(prev => {
        const exists = prev.find(c => c.candidate_id === activity.candidate_id)
        if (!exists && activity.candidate_name) {
          return [{ ...activity, name: activity.candidate_name }, ...prev]
        }
        return prev.map(c =>
          c.candidate_id === activity.candidate_id
            ? { ...c, ...activity, last_message: activity.last_message, last_message_at: activity.ts }
            : c
        )
      })
    })

    socket.on('handoff_start', ({ candidate_id, agent_name }) => {
      setChatList(prev => prev.map(c =>
        c.candidate_id === candidate_id ? { ...c, is_human_handoff: true, agent_name } : c
      ))
    })

    socket.on('handoff_end', ({ candidate_id }) => {
      setChatList(prev => prev.map(c =>
        c.candidate_id === candidate_id ? { ...c, is_human_handoff: false, agent_name: null } : c
      ))
    })

    socket.on('agent_typing', ({ agent_name, is_typing }) => {
      setAgentTyping(is_typing ? agent_name : null)
    })

    return () => socket.disconnect()
  }, []) // eslint-disable-line

  // Join/leave candidate room when selection changes
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return
    if (selectedId) socket.emit('join_candidate', selectedId)
    return () => { if (selectedId) socket.emit('leave_candidate', selectedId) }
  }, [selectedId])

  // Auto-scroll to bottom of transcript
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript, agentTyping])

  // ── Takeover / Release mutations ───────────────────────────────────────────
  const takeoverMut = useMutation({
    mutationFn: () => takeover(selectedId),
    onSuccess: () => queryClient.invalidateQueries(['active-chats']),
  })
  const releaseMut = useMutation({
    mutationFn: () => release(selectedId),
    onSuccess: () => queryClient.invalidateQueries(['active-chats']),
  })

  // ── Send message ───────────────────────────────────────────────────────────
  const handleSend = useCallback(async (e) => {
    e?.preventDefault()
    if (!message.trim() || !selectedId) return
    setSendError(null)
    try {
      const result = await sendMsg({ candidate_id: selectedId, channel: 'whatsapp', message })
      setMessage('')
      // Optimistically add to transcript
      setTranscript(prev => [...prev, {
        id: result.id || Date.now(),
        direction: 'outbound',
        content: message,
        sender_type: 'agent',
        sender_name: 'You',
        sent_at: new Date().toISOString(),
      }])
    } catch (err) {
      setSendError('Failed to send. Please try again.')
    }
  }, [message, selectedId])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">

      {/* ── Left: Chat list ─────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-slate-900">Conversations</h1>
            <div className="flex items-center gap-1.5">
              {connected
                ? <Wifi size={14} className="text-emerald-500" />
                : <WifiOff size={14} className="text-red-400 animate-pulse" />}
              <span className={clsx('text-[10px] font-medium', connected ? 'text-emerald-600' : 'text-red-400')}>
                {connected ? 'Live' : 'Offline'}
              </span>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search candidates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400 transition-all"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex gap-3 items-center">
                  <Skeleton className="w-10 h-10 rounded-full" />
                  <div className="flex-1"><Skeleton className="h-3 w-2/3 mb-2" /><Skeleton className="h-2 w-1/2" /></div>
                </div>
              ))}
            </div>
          ) : chatList.length === 0 ? (
            <div className="p-8 text-center text-slate-400">
              <MessageSquare size={40} className="mx-auto mb-2 text-slate-200" />
              <p className="text-sm">No conversations yet</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {chatList.map((c) => (
                <button
                  key={c.candidate_id}
                  onClick={() => { setSelectedId(c.candidate_id); setTranscript([]) }}
                  className={clsx(
                    'w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-slate-50 transition-colors',
                    selectedId === c.candidate_id && 'bg-primary-50 hover:bg-primary-50'
                  )}
                >
                  {/* Avatar */}
                  <div className={clsx(
                    'w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0',
                    c.is_human_handoff ? 'bg-indigo-100 text-indigo-700' : 'bg-primary-100 text-primary-700'
                  )}>
                    {c.name?.charAt(0)?.toUpperCase() || '?'}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-1 mb-0.5">
                      <p className="text-sm font-semibold text-slate-900 truncate">{c.name || 'Unknown'}</p>
                      {c.last_message_at && (
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {formatDistanceToNow(new Date(c.last_message_at), { addSuffix: false })}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 truncate">{c.last_message || 'No messages'}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      {c.is_human_handoff
                        ? <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <UserCheck size={10} /> {c.agent_name || 'Agent'}
                        </span>
                        : <span className="text-[10px] bg-emerald-100 text-emerald-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <Bot size={10} /> Bot
                        </span>}
                      {c.last_language && <LangBadge lang={c.last_language} />}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Center: Transcript ───────────────────────────────────────────────── */}
      {selectedId ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Transcript header */}
          <div className="h-16 px-5 bg-white border-b border-slate-200 flex items-center justify-between shadow-sm shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center font-bold text-primary-700 text-sm">
                {selectedCandidate?.name?.charAt(0)?.toUpperCase() || '?'}
              </div>
              <div>
                <h2 className="font-semibold text-slate-900 text-sm">{selectedCandidate?.name || 'Candidate'}</h2>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><Phone size={11} /> {selectedCandidate?.phone || selectedCandidate?.whatsapp_phone}</span>
                  {selectedCandidate?.last_chatbot_state && (
                    <span className="flex items-center gap-1 text-slate-400">
                      <ChevronRight size={11} /> {selectedCandidate.last_chatbot_state.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Takeover / Release button */}
            <div className="flex items-center gap-2">
              {selectedCandidate?.is_human_handoff ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => releaseMut.mutate()}
                  disabled={releaseMut.isPending}
                  className="flex items-center gap-1.5 text-sm border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                >
                  {releaseMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                  Release to Bot
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => takeoverMut.mutate()}
                  disabled={takeoverMut.isPending}
                  className="flex items-center gap-1.5 text-sm bg-indigo-600 hover:bg-indigo-700"
                >
                  {takeoverMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
                  Take Over
                </Button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {transcriptLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className={clsx('flex', i % 2 === 0 ? 'justify-end' : 'justify-start')}>
                    <Skeleton className={clsx('h-12 rounded-2xl', i % 2 === 0 ? 'w-48' : 'w-56')} />
                  </div>
                ))}
              </div>
            ) : transcript.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <MessageSquare size={48} className="mb-3 text-slate-200" />
                <p className="text-sm">No messages yet</p>
              </div>
            ) : (
              <>
                {transcript.map((msg, i) => <MsgBubble key={msg.id || i} msg={msg} />)}
                {agentTyping && (
                  <div className="flex justify-start mb-3">
                    <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-none px-4 py-2 shadow-sm text-xs text-slate-400 flex items-center gap-2">
                      <span className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                      </span>
                      {agentTyping} is typing…
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          {/* Input */}
          {selectedCandidate?.is_human_handoff && (
            <div className="px-4 py-3 bg-white border-t border-slate-200 shrink-0">
              {sendError && (
                <div className="flex items-center gap-2 text-xs text-red-500 mb-2">
                  <AlertCircle size={12} /> {sendError}
                </div>
              )}
              <form onSubmit={handleSend} className="flex items-end gap-2">
                <div className="flex-1 bg-slate-50 rounded-xl border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-400 focus-within:bg-white transition-all">
                  <textarea
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value)
                      socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: true })
                    }}
                    onBlur={() => socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: false })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                    placeholder="Type a message as agent… (Enter to send)"
                    className="w-full bg-transparent border-0 focus:ring-0 p-3 max-h-28 resize-none text-sm"
                    rows={1}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={!message.trim()}
                  className="mb-0.5 w-10 h-10 px-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 flex items-center justify-center"
                >
                  <Send size={16} />
                </Button>
              </form>
            </div>
          )}

          {/* Bot-control notice */}
          {!selectedCandidate?.is_human_handoff && (
            <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-100 shrink-0 flex items-center gap-2 text-sm text-emerald-700">
              <Bot size={16} />
              <span>Bot is handling this conversation. Click <strong>Take Over</strong> to reply as an agent.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-slate-50">
          <div className="text-center text-slate-400">
            <MessageSquare size={56} className="mx-auto mb-3 text-slate-200" />
            <p className="text-lg font-medium text-slate-500">Select a conversation</p>
            <p className="text-sm">Choose from the list to view the full chat transcript</p>
          </div>
        </div>
      )}

      {/* ── Right: Candidate context ─────────────────────────────────────────── */}
      {selectedCandidate && (
        <div className="w-64 shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Candidate Info</h3>
            <div className="flex flex-col items-center text-center">
              <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 text-xl font-bold mb-2">
                {selectedCandidate.name?.charAt(0)?.toUpperCase() || '?'}
              </div>
              <p className="font-semibold text-slate-900">{selectedCandidate.name}</p>
              <p className="text-xs text-slate-500">{selectedCandidate.phone || selectedCandidate.whatsapp_phone}</p>
            </div>
          </div>

          <div className="p-4 space-y-3 text-sm">
            {/* Status */}
            <div className="flex items-center gap-2 text-slate-600">
              <div className={clsx('w-2 h-2 rounded-full', selectedCandidate.is_human_handoff ? 'bg-indigo-500' : 'bg-emerald-500')} />
              <span>{selectedCandidate.is_human_handoff ? `Agent: ${selectedCandidate.agent_name || 'Active'}` : 'Bot Active'}</span>
            </div>

            {/* Bot state */}
            {selectedCandidate.last_chatbot_state && (
              <div className="flex items-start gap-2 text-slate-600">
                <RefreshCw size={13} className="mt-0.5 shrink-0 text-slate-400" />
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide">Bot State</p>
                  <p className="text-xs font-medium">{selectedCandidate.last_chatbot_state.replace(/_/g, ' ')}</p>
                </div>
              </div>
            )}

            {/* Language */}
            {selectedCandidate.last_language && (
              <div className="flex items-center gap-2 text-slate-600">
                <Globe size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs">Language: <LangBadge lang={selectedCandidate.last_language} /></span>
              </div>
            )}

            {/* Candidate status */}
            {selectedCandidate.candidate_status && (
              <div className="flex items-center gap-2 text-slate-600">
                <Briefcase size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs capitalize">{selectedCandidate.candidate_status}</span>
              </div>
            )}

            {/* Last activity */}
            {selectedCandidate.last_message_at && (
              <div className="flex items-center gap-2 text-slate-600">
                <Clock size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs">{formatDistanceToNow(new Date(selectedCandidate.last_message_at), { addSuffix: true })}</span>
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="p-4 border-t border-slate-100 mt-auto">
            {selectedCandidate.is_human_handoff ? (
              <Button
                variant="outline"
                className="w-full text-xs flex items-center justify-center gap-1.5 border-emerald-300 text-emerald-700"
                onClick={() => releaseMut.mutate()}
                disabled={releaseMut.isPending}
              >
                <Bot size={13} /> Release to Bot
              </Button>
            ) : (
              <Button
                className="w-full text-xs flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                onClick={() => takeoverMut.mutate()}
                disabled={takeoverMut.isPending}
              >
                <UserCheck size={13} /> Take Over Chat
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
