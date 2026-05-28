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
import { useSearchParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  MessageSquare, Search, Send, Phone, Mail, Bot, User,
  UserCheck, RefreshCw, Globe, Briefcase, MapPin, Clock,
  ChevronRight, AlertCircle, Wifi, WifiOff, Loader2,
  Mic, Square, Trash2, Paperclip, Wand2,
  SlidersHorizontal, ChevronDown, X as XIcon,
} from 'lucide-react'
import { clsx } from 'clsx'
import { format, formatDistanceToNow } from 'date-fns'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { Modal } from '../components/ui/Modal'
import { getCommunications, sendCommunication } from '../api'
import { useAuthStore } from '../stores/authStore'
import { ConversationDocumentsPanel } from '../components/communications/ConversationDocumentsPanel'

// ── API helpers ──────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || ''

async function apiFetch(path, opts = {}) {
  const token = useAuthStore.getState().token
  const isFormData = opts.body instanceof FormData
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(isFormData ? {} : { 'Cache-Control': 'no-cache' }),
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`)
  return res.json()
}

const STAGE_OPTIONS = [
  { value: '', label: 'All stages' },
  { value: 'new', label: 'New' },
  { value: 'responding', label: 'Responding' },
  { value: 'screening', label: 'Screening' },
  { value: 'interview', label: 'Interview' },
  { value: 'completed', label: 'Completed' },
]

const PIPELINE_OPTIONS = [
  { value: '', label: 'All pipeline' },
  { value: 'bot_engaging', label: 'Bot Engaging' },
  { value: 'cv_uploaded', label: 'CV Uploaded' },
  { value: 'cv_parsed', label: 'CV Parsed' },
  { value: 'pending_human_review', label: 'Pending Human Review' },
  { value: 'human_takeover_active', label: 'Human Takeover Active' },
  { value: 'shortlisted_or_rejected', label: 'Shortlisted / Rejected' },
]

const HANDOFF_OPTIONS = [
  { value: '', label: 'All owners' },
  { value: 'bot', label: 'Bot Controlled' },
  { value: 'human', label: 'Human Controlled' },
]

const SORT_OPTIONS = [
  { value: 'latest_desc', label: 'Latest first' },
  { value: 'latest_asc', label: 'Oldest first' },
]

const RESPONSE_OPTIONS = [
  { value: '', label: 'All responses' },
  { value: 'awaiting_candidate', label: 'Awaiting Candidate' },
  { value: 'awaiting_agent', label: 'Awaiting Agent' },
  { value: 'unread', label: 'Unread' },
  { value: 'replied', label: 'Replied' },
]

const getActiveChats = ({ search, conversationStage, pipelineStage, handoffState, sortBy, responseStatus, dateFrom, dateTo }) => {
  const params = new URLSearchParams()
  params.set('limit', '5000')
  if (search) params.set('search', search)
  if (conversationStage) params.set('conversation_stage', conversationStage)
  if (pipelineStage) params.set('pipeline_stage', pipelineStage)
  if (handoffState) params.set('handoff_state', handoffState)
  if (sortBy) params.set('sort_by', sortBy)
  if (responseStatus) params.set('response_status', responseStatus)
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  return apiFetch(`/api/communications/active-chats?${params.toString()}`)
}
const getTranscript = ({ id, responseStatus, dateFrom, dateTo }) => {
  const params = new URLSearchParams()
  params.set('limit', '5000')
  if (responseStatus) params.set('response_status', responseStatus)
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  return apiFetch(`/api/communications/candidate/${id}?${params.toString()}`)
}
const updateCandidateIdentity = (id, body) => apiFetch(`/api/candidates/${id}`, {
  method: 'PUT',
  body: JSON.stringify(body),
})
const takeover = (id) => apiFetch(`/api/communications/candidate/${id}/takeover`, { method: 'POST' })
const release = (id) => apiFetch(`/api/communications/candidate/${id}/release`, { method: 'POST' })
const sendMsg = (body) => apiFetch('/api/communications/send', {
  method: 'POST',
  body: body instanceof FormData ? body : JSON.stringify(body)
})

const parseAttachments = (value) => {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [value]
    } catch {
      if (value.startsWith('{') || value.startsWith('[')) return []
      return [value]
    }
  }
  return []
}

const getPrimaryAttachment = (msg) => {
  const attachments = parseAttachments(msg.attachments)
  if (attachments.length > 0) {
    const first = attachments[0]
    if (typeof first === 'string') return first
    if (first && typeof first === 'object') return first.url || null
  }
  // Chatbot media (voice notes, images) arrives with the playable/openable URL
  // on media_url or inside the metadata JSON (sync-message stores it there).
  if (msg.media_url) return msg.media_url
  let meta = msg.metadata
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) } catch { meta = null }
  }
  if (meta && meta.media_url) return meta.media_url
  return null
}

function MediaContent({ msg, isOutbound }) {
  const mediaUrl = getPrimaryAttachment(msg)
  if (!mediaUrl) return null

  if (msg.message_type === 'image') {
    return <img src={mediaUrl} alt="attachment" className="max-h-64 w-auto rounded-lg border border-white/20" />
  }

  if (msg.message_type === 'audio' || msg.message_type === 'voice') {
    return <audio controls src={mediaUrl} className="w-64 max-w-full" />
  }

  if (msg.message_type === 'video') {
    return <video controls src={mediaUrl} className="max-h-64 w-auto rounded-lg border border-white/20" />
  }

  if (msg.message_type === 'document') {
    return (
      <a
        href={mediaUrl}
        target="_blank"
        rel="noreferrer"
        className={clsx(
          'inline-flex items-center gap-2 underline text-sm',
          isOutbound ? 'text-white' : 'text-indigo-700'
        )}
      >
        <Paperclip size={14} />
        Open attachment
      </a>
    )
  }

  return null
}

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
  const hasMedia = Boolean(getPrimaryAttachment(msg))

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-200 dark:ring-amber-900/60 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    )
  }

  return (
    <div className={clsx('flex gap-2 mb-3', isInbound ? 'justify-start' : 'justify-end')}>
      {isInbound && (
        <div className="w-7 h-7 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center shrink-0 mt-1 ring-2 ring-white dark:ring-zinc-900">
          <User size={14} className="text-zinc-500 dark:text-zinc-400" />
        </div>
      )}
      <div className={clsx('max-w-[68%]', isInbound ? '' : 'items-end flex flex-col')}>
        {isAgent && (
          <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-300 font-semibold mb-0.5 mr-1">
            <UserCheck size={9} />
            {msg.sender_name || 'Agent'}
          </span>
        )}
        <div className={clsx(
          'rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words shadow-[0_2px_8px_rgb(0,0,0,0.04)] dark:shadow-[0_2px_8px_rgb(0,0,0,0.3)]',
          isInbound
            ? 'bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 rounded-tl-none ring-1 ring-inset ring-zinc-100 dark:ring-zinc-700'
            : isAgent
              ? 'bg-gradient-to-br from-indigo-500 to-indigo-600 text-white rounded-tr-none'
              : 'bg-gradient-to-br from-primary-500 to-primary-600 text-white rounded-tr-none'
        )}>
          {hasMedia && (
            <div className={msg.content ? 'mb-2' : ''}>
              <MediaContent msg={msg} isOutbound={!isInbound} />
            </div>
          )}
          {msg.content}
        </div>
        <div className={clsx('flex items-center gap-1.5 mt-1 text-[10px] text-zinc-400 dark:text-zinc-500', isInbound ? 'ml-1' : 'mr-1 flex-row-reverse')}>
          <span className="inline-flex items-center gap-1">
            <Clock size={9} />
            {format(new Date(msg.sent_at), 'HH:mm')}
          </span>
          {msg.detected_language && <LangBadge lang={msg.detected_language} />}
          {!isInbound && (
            <span
              className={clsx(
                'inline-flex items-center justify-center w-3.5 h-3.5 rounded-full',
                isAgent ? 'bg-indigo-100 dark:bg-indigo-900/60 text-indigo-600 dark:text-indigo-300' : 'bg-primary-100 dark:bg-primary-900/60 text-primary-600 dark:text-primary-300'
              )}
              title={isAgent ? 'Sent by agent' : 'Sent by bot'}
            >
              {isAgent ? <UserCheck size={8} /> : <Bot size={8} />}
            </span>
          )}
        </div>
      </div>
      {!isInbound && (
        <div className={clsx(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-1 ring-2 ring-white dark:ring-zinc-900 shadow-sm',
          isAgent ? 'bg-gradient-to-br from-indigo-400 to-indigo-600 text-white' : 'bg-gradient-to-br from-primary-400 to-primary-600 text-white'
        )}>
          {isAgent ? <UserCheck size={14} /> : <Bot size={14} />}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Communications() {
  const [searchParams] = useSearchParams()
  const [selectedId, setSelectedId] = useState(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState(searchParams.get('q') || '')
  const [conversationStage, setConversationStage] = useState(searchParams.get('conversation_stage') || '')
  const [pipelineStage, setPipelineStage] = useState(searchParams.get('pipeline_stage') || '')
  const [handoffState, setHandoffState] = useState(searchParams.get('handoff_state') || '')
  const [sortBy, setSortBy] = useState(searchParams.get('sort_by') || 'latest_desc')
  const [responseStatus, setResponseStatus] = useState(searchParams.get('response_status') || '')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '')
  const [transcriptResponseStatus, setTranscriptResponseStatus] = useState('')
  const [transcriptDateFrom, setTranscriptDateFrom] = useState('')
  const [transcriptDateTo, setTranscriptDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [showEditContactModal, setShowEditContactModal] = useState(false)
  const [editContactDraft, setEditContactDraft] = useState({ name: '', email: '', preferred_language: 'en', notes: '' })
  const [identityError, setIdentityError] = useState(null)
  const [chatList, setChatList] = useState([])
  const [escalatedChats, setEscalatedChats] = useState(() => new Set())
  const [transcript, setTranscript] = useState([])
  const [connected, setConnected] = useState(false)
  const [agentTyping, setAgentTyping] = useState(null)
  const [sendError, setSendError] = useState(null)
  const [isRecording, setIsRecording] = useState(false)
  const [audioBlob, setAudioBlob] = useState(null)
  const [audioUrl, setAudioUrl] = useState(null)
  const [sendChannel, setSendChannel] = useState('whatsapp') // 'whatsapp' | 'email' | 'both'
  const [msgContext, setMsgContext] = useState(null)           // { application, interview }
  const socketRef = useRef(null)
  const bottomRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const mediaChunksRef = useRef([])
  const mediaStreamRef = useRef(null)
  const fileInputRef = useRef(null)
  const queryClient = useQueryClient()

  const getCandidateDisplayName = useCallback((candidate) => {
    if (!candidate) return 'Unknown'
    return String(candidate.display_name || candidate.name || candidate.whatsapp_phone || candidate.phone || 'Unknown')
  }, [])

  const getPipelineStageLabel = useCallback((stage) => {
    const value = String(stage || '').toLowerCase()
    const map = {
      bot_engaging: 'Bot Engaging',
      cv_uploaded: 'CV Uploaded',
      cv_parsed: 'CV Parsed',
      pending_human_review: 'Pending Human Review',
      human_takeover_active: 'Human Takeover Active',
      shortlisted_or_rejected: 'Shortlisted / Rejected',
    }
    return map[value] || 'Bot Engaging'
  }, [])

  const getPipelineStageClasses = useCallback((stage) => {
    const value = String(stage || '').toLowerCase()
    if (value === 'human_takeover_active') return 'bg-indigo-100 text-indigo-700'
    if (value === 'pending_human_review') return 'bg-amber-100 text-amber-700'
    if (value === 'cv_uploaded') return 'bg-cyan-100 text-cyan-700'
    if (value === 'cv_parsed') return 'bg-emerald-100 text-emerald-700'
    if (value === 'shortlisted_or_rejected') return 'bg-violet-100 text-violet-700'
    return 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
  }, [])

  const getCandidateInitial = useCallback((candidate) => {
    const displayName = getCandidateDisplayName(candidate)
    return displayName.charAt(0).toUpperCase() || '?'
  }, [getCandidateDisplayName])

  // Selected candidate object from chatList
  const selectedCandidate = chatList.find(c => c.candidate_id === selectedId)

  useEffect(() => {
    if (!selectedCandidate) {
      setEditContactDraft({ name: '', email: '', preferred_language: 'en', notes: '' })
      setShowEditContactModal(false)
      return
    }
    setEditContactDraft({
      name: getCandidateDisplayName(selectedCandidate),
      email: selectedCandidate.email || '',
      preferred_language: selectedCandidate.preferred_language || 'en',
      notes: selectedCandidate.notes || '',
    })
    setIdentityError(null)
    setShowEditContactModal(false)
  }, [selectedCandidate, getCandidateDisplayName])

  useEffect(() => {
    const candidateFromUrl = searchParams.get('candidate')
    if (candidateFromUrl) {
      setSelectedId(candidateFromUrl)
    }
  }, [searchParams])

  const isCandidateEscalated = useCallback((candidate) => {
    if (!candidate) return false
    const phone = String(candidate.phone || candidate.whatsapp_phone || '').trim()
    return Boolean(candidate.requires_human)
      || String(candidate.ai_status || '').toLowerCase() === 'requires intervention'
      || (phone && escalatedChats.has(phone))
  }, [escalatedChats])

  // ── Fetch candidate message context (job + interview) when selection changes ──
  const { data: contextData } = useQuery({
    queryKey: ['candidate-context', selectedId],
    queryFn: () => apiFetch(`/api/communications/candidate/${selectedId}/context`),
    enabled: !!selectedId,
    staleTime: 60000,
  })
  useEffect(() => {
    setMsgContext(contextData || null)
  }, [contextData])

  const buildDefaultMessage = useCallback(() => {
    if (!msgContext) return ''
    const { application, interview } = msgContext
    const parts = []
    if (application?.job_title) {
      parts.push(`Regarding your application for the position of ${application.job_title}.`)
      if (application.job_description_snippet) {
        parts.push(application.job_description_snippet.trim())
      }
    }
    if (interview?.scheduled_datetime) {
      const dt = new Date(interview.scheduled_datetime)
      const dateStr = dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      const timeStr = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      parts.push(`Your interview is scheduled for ${dateStr} at ${timeStr}.`)
      if (interview.interview_job_title && interview.interview_job_title !== application?.job_title) {
        parts.push(`Role: ${interview.interview_job_title}.`)
      }
      if (interview.location) parts.push(`Location: ${interview.location}.`)
    }
    return parts.join('\n\n')
  }, [msgContext])

  // ── Fetch active chat list ─────────────────────────────────────────────────
  const { data: activeChatsData, isLoading: listLoading } = useQuery({
    queryKey: ['active-chats', search, conversationStage, pipelineStage, handoffState, sortBy, responseStatus, dateFrom, dateTo],
    queryFn: () => getActiveChats({
      search,
      conversationStage,
      pipelineStage,
      handoffState,
      sortBy,
      responseStatus,
      dateFrom,
      dateTo,
    }),
    refetchInterval: 30000, // fallback poll every 30s
  })

  useEffect(() => {
    if (Array.isArray(activeChatsData)) {
      setChatList(activeChatsData)
    }
  }, [activeChatsData])

  // ── Fetch transcript when candidate changes ────────────────────────────────
  const { data: transcriptData, isLoading: transcriptLoading } = useQuery({
    queryKey: ['transcript', selectedId, transcriptResponseStatus, transcriptDateFrom, transcriptDateTo],
    queryFn: () => getTranscript({
      id: selectedId,
      responseStatus: transcriptResponseStatus,
      dateFrom: transcriptDateFrom,
      dateTo: transcriptDateTo,
    }),
    enabled: !!selectedId,
  })

  useEffect(() => {
    if (!selectedId) {
      setTranscript([])
      return
    }
    setTranscript(Array.isArray(transcriptData) ? transcriptData : [])
  }, [selectedId, transcriptData])

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
      setTranscript(prev => {
        // Deduplicate: if an optimistic insert with the same server ID already exists, replace it
        const exists = prev.some(m => m.id === msg.id)
        if (exists) return prev.map(m => m.id === msg.id ? { ...msg, _optimistic: false } : m)
        return [...prev, msg]
      })
      // Update last message in chat list (+ promote a real captured name)
      const _realName = msg.candidate_name && String(msg.candidate_name).trim()
      const _phoneDigits = String(msg.phone || '').replace(/[^0-9]/g, '')
      const _nameIsReal = _realName && _realName.replace(/[^0-9]/g, '') !== _phoneDigits
      setChatList(prev => prev.map(c =>
        c.candidate_id === msg.candidate_id
          ? {
              ...c,
              last_message: msg.content,
              last_message_at: msg.sent_at,
              last_direction: msg.direction,
              ...(_nameIsReal ? { name: _realName, display_name: _realName } : {}),
            }
          : c
      ))
      // Refresh the documents panel for this candidate when a new document
      // upload arrives over WebSocket — otherwise the sidebar shows the
      // pre-upload count until the user manually refreshes.
      if (msg.message_type === 'document' || msg.message_type === 'image') {
        queryClient.invalidateQueries({ queryKey: ['candidate', msg.candidate_id] })
      }
    })

    socket.on('receive_message', (newMessage) => {
      const mapped = {
        id: newMessage.id || Date.now(),
        candidate_id: newMessage.candidate_id,
        direction: newMessage.direction || (newMessage.sender === 'candidate' ? 'inbound' : 'outbound'),
        message_type: newMessage.message_type || 'text',
        content: newMessage.text || '',
        sender_type: newMessage.sender || (newMessage.direction === 'inbound' ? 'candidate' : 'agent'),
        sent_at: newMessage.timestamp || new Date().toISOString(),
        attachments: newMessage.attachments || [],
      }
      setTranscript(prev => {
        if (prev.some(m => m.id === mapped.id)) return prev
        return [...prev, mapped]
      })
      setChatList(prev => prev.map(c =>
        c.candidate_id === mapped.candidate_id
          ? { ...c, last_message: mapped.content, last_message_at: mapped.sent_at, last_direction: mapped.direction }
          : c
      ))
    })

    socket.on('chat_activity', (activity) => {
      // Real-time identity: when the bot has captured the candidate's name,
      // candidate_name arrives as the real name (not the phone). Promote it to
      // name/display_name so the header + list switch from phone → name live.
      const realName = activity.candidate_name && String(activity.candidate_name).trim()
      const phoneStr = String(activity.phone || '').replace(/[^0-9]/g, '')
      const nameIsReal = realName && realName.replace(/[^0-9]/g, '') !== phoneStr
      setChatList(prev => {
        const exists = prev.find(c => c.candidate_id === activity.candidate_id)
        if (!exists && activity.candidate_name) {
          return [{ ...activity, name: activity.candidate_name, display_name: activity.candidate_name }, ...prev]
        }
        return prev.map(c =>
          c.candidate_id === activity.candidate_id
            ? {
                ...c,
                ...activity,
                last_message: activity.last_message,
                last_message_at: activity.ts,
                ...(nameIsReal ? { name: realName, display_name: realName } : {}),
              }
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

    socket.on('chat_escalated', (data) => {
      const escalatedPhone = String(data?.phone || '').trim()
      if (escalatedPhone) {
        setEscalatedChats(prev => {
          const next = new Set(prev)
          next.add(escalatedPhone)
          return next
        })
      }

      setChatList(prev => prev.map(c => {
        const candidatePhone = String(c.phone || c.whatsapp_phone || '').trim()
        const sameCandidate = (data?.candidate_id && c.candidate_id === data.candidate_id) || (escalatedPhone && candidatePhone === escalatedPhone)
        if (!sameCandidate) return c
        return {
          ...c,
          ai_status: 'Requires Intervention',
          requires_human: true,
        }
      }))
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

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      }
    }
  }, [audioUrl])

  // ── Takeover / Release mutations ───────────────────────────────────────────
  const takeoverMut = useMutation({
    mutationFn: (candidateId) => takeover(candidateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['active-chats'] }),
  })
  const releaseMut = useMutation({
    mutationFn: () => release(selectedId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['active-chats'] }),
  })

  const identityMut = useMutation({
    mutationFn: ({ candidateId, payload }) => updateCandidateIdentity(candidateId, payload),
    onSuccess: (_, vars) => {
      setChatList(prev => prev.map(c => (
        c.candidate_id === vars.candidateId
          ? {
            ...c,
            name: vars.payload.name,
            email: vars.payload.email,
            preferred_language: vars.payload.preferred_language,
            notes: vars.payload.notes,
            display_name: vars.payload.name || c.whatsapp_phone || c.phone,
          }
          : c
      )))
      setShowEditContactModal(false)
      setIdentityError(null)
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
    },
    onError: () => {
      setIdentityError('Failed to save identity. Please try again.')
    },
  })

  // ── Send message ───────────────────────────────────────────────────────────
  const discardAudio = useCallback(() => {
    setAudioBlob(null)
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      setAudioUrl(null)
    }
  }, [audioUrl])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }
  }, [isRecording])

  const startRecording = useCallback(async () => {
    try {
      setSendError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream

      const recorder = new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      mediaChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          mediaChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        const mimeType = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg' : 'audio/webm'
        const blob = new Blob(mediaChunksRef.current, { type: mimeType })
        if (audioUrl) URL.revokeObjectURL(audioUrl)
        setAudioBlob(blob)
        setAudioUrl(URL.createObjectURL(blob))
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop())
          mediaStreamRef.current = null
        }
      }

      recorder.start()
      setIsRecording(true)
    } catch (error) {
      setSendError('Could not access microphone. Please check browser permissions.')
    }
  }, [audioUrl])

  const handleSend = useCallback(async (e, fileToUpload = null) => {
    e?.preventDefault()
    const hasText = Boolean(message.trim())
    const hasAudio = Boolean(audioBlob)
    const hasFile = Boolean(fileToUpload)
    if ((!hasText && !hasAudio && !hasFile) || !selectedId) return

    setSendError(null)
    try {
      const formData = new FormData()
      formData.append('candidate_id', selectedId)
      // Map UI channel selector to backend `channels` field
      if (sendChannel === 'both') {
        formData.append('channels', 'whatsapp,email')
      } else {
        formData.append('channel', sendChannel)
      }
      if (hasText) formData.append('message', message.trim())
      // Add email subject when sending via email channel
      if (sendChannel === 'email' || sendChannel === 'both') {
        const subject = msgContext?.application?.job_title
          ? `Message from Dewan Recruitment — ${msgContext.application.job_title}`
          : 'Message from Dewan Recruitment'
        formData.append('email_subject', subject)
      }

      let optimisticType = 'text'
      if (hasAudio) {
        // Use ogg for WhatsApp compatibility (webm is not supported by WhatsApp API)
        const mimeType = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg' : 'audio/webm'
        const ext = mimeType.includes('ogg') ? 'ogg' : 'webm'
        formData.append('audio', new Blob(mediaChunksRef.current, { type: mimeType }), `voice-note.${ext}`)
        optimisticType = 'audio'
      } else if (hasFile) {
        formData.append('media', fileToUpload)
        optimisticType = fileToUpload.type?.startsWith('image/')
          ? 'image'
          : fileToUpload.type?.startsWith('audio/')
            ? 'audio'
            : fileToUpload.type?.startsWith('video/')
              ? 'video'
              : 'document'
      }

      // Clear inputs immediately so user can type next message
      const sentText = message.trim()
      setMessage('')
      discardAudio()
      if (fileInputRef.current) fileInputRef.current.value = ''

      const result = await sendMsg(formData)

      // Add sent message to transcript immediately (optimistic insert with real server ID)
      const optimisticMsg = {
        id: result.id || `temp-${Date.now()}`,
        candidate_id: selectedId,
        direction: 'outbound',
        message_type: result.message_type || optimisticType,
        content: sentText,
        attachments: result.attachments || [],
        sender_type: 'agent',
        sender_name: 'You',
        sent_at: new Date().toISOString(),
        _optimistic: true,
      }
      setTranscript(prev => {
        // Avoid duplicate if WebSocket event already arrived
        if (prev.some(m => m.id === optimisticMsg.id)) return prev
        return [...prev, optimisticMsg]
      })

      // Warn user about any delivery failures per channel
      if (result.simulated) {
        const errors = result.delivery_errors || {}
        const parts = Object.entries(errors).map(([ch, msg]) => `${ch}: ${msg}`)
        const detail = parts.length > 0 ? ` (${parts.join('; ')})` : ''
        setSendError(`⚠️ Message saved but delivery failed${detail}`)
      }
    } catch (err) {
      setSendError('Failed to send. Please try again.')
    }
  }, [message, selectedId, audioBlob, discardAudio])

  // ── Render ─────────────────────────────────────────────────────────────────
  // h-full (not h-screen) keeps the 3-pane layout inside Layout's <main>, so
  // there's no outer page scroll — only the inner conversation/transcript panels scroll.
  return (
    <div className="flex h-full bg-zinc-50 dark:bg-zinc-900/60 overflow-hidden rounded-2xl border border-zinc-200/60 dark:border-zinc-800/60">

      {/* ── Left: Chat list ─────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800/60">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-primary-700 to-indigo-600 dark:from-primary-300 dark:to-indigo-300 bg-clip-text text-transparent">
              Conversations
            </h1>
            <span
              className={clsx(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset',
                connected
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-900/60'
                  : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-900/60'
              )}
              title={connected ? 'Real-time connected' : 'Disconnected — reconnecting…'}
            >
              {connected
                ? <Wifi size={11} />
                : <WifiOff size={11} className="animate-pulse" />}
              {connected ? 'Live' : 'Offline'}
            </span>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" size={16} />
            <input
              type="text"
              placeholder="Search candidates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400 transition-all"
            />
          </div>
          {(() => {
            const activeFilterCount = [conversationStage, pipelineStage, responseStatus, handoffState, dateFrom, dateTo].filter(Boolean).length
              + (sortBy && sortBy !== 'latest_desc' ? 1 : 0)
            return (
              <div className="mt-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowFilters((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  <SlidersHorizontal size={12} />
                  Filters
                  {activeFilterCount > 0 && (
                    <span className="inline-flex items-center justify-center rounded-full bg-primary-600 text-white text-[10px] font-bold px-1.5 min-w-[16px] h-4">
                      {activeFilterCount}
                    </span>
                  )}
                  <ChevronDown size={12} className={clsx('transition-transform', showFilters && 'rotate-180')} />
                </button>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setConversationStage('')
                      setPipelineStage('')
                      setHandoffState('')
                      setSortBy('latest_desc')
                      setResponseStatus('')
                      setDateFrom('')
                      setDateTo('')
                    }}
                    className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  >
                    <XIcon size={11} /> Clear
                  </button>
                )}
              </div>
            )
          })()}
          {showFilters && (
            <div className="mt-2 grid grid-cols-2 gap-2 animate-fade-in">
              <select
                value={conversationStage}
                onChange={(e) => setConversationStage(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                {STAGE_OPTIONS.map((option) => (
                  <option key={option.value || 'all'} value={option.value}>{option.label}</option>
                ))}
              </select>
              <select
                value={pipelineStage}
                onChange={(e) => setPipelineStage(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                {PIPELINE_OPTIONS.map((option) => (
                  <option key={`pipeline-${option.value || 'all'}`} value={option.value}>{option.label}</option>
                ))}
              </select>
              <select
                value={responseStatus}
                onChange={(e) => setResponseStatus(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                {RESPONSE_OPTIONS.map((option) => (
                  <option key={option.value || 'all'} value={option.value}>{option.label}</option>
                ))}
              </select>
              <select
                value={handoffState}
                onChange={(e) => setHandoffState(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                {HANDOFF_OPTIONS.map((option) => (
                  <option key={`handoff-${option.value || 'all'}`} value={option.value}>{option.label}</option>
                ))}
              </select>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="col-span-2 w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={`sort-${option.value}`} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
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
            <div className="p-8 text-center text-zinc-400 dark:text-zinc-500">
              <MessageSquare size={40} className="mx-auto mb-2 text-zinc-200 dark:text-zinc-700" />
              <p className="text-sm">No conversations yet</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {chatList.map((c) => (
                <div
                  key={c.candidate_id}
                  onClick={() => { setSelectedId(c.candidate_id); setTranscript([]) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedId(c.candidate_id)
                      setTranscript([])
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className={clsx(
                    'relative w-full px-4 py-3 flex items-start gap-3 text-left transition-colors cursor-pointer',
                    selectedId === c.candidate_id
                      ? 'bg-primary-50/70 dark:bg-primary-950/30 before:content-[""] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r before:bg-gradient-to-b before:from-primary-500 before:to-indigo-500'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                  )}
                >
                  {/* Avatar */}
                  <div className={clsx(
                    'w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ring-2 ring-white dark:ring-zinc-900 shadow-sm',
                    c.is_human_handoff
                      ? 'bg-gradient-to-br from-indigo-400 to-indigo-600 text-white'
                      : 'bg-gradient-to-br from-primary-400 to-primary-600 text-white'
                  )}>
                    {getCandidateInitial(c)}
                  </div>

                  <div className="flex-1 min-w-0">
                    {isCandidateEscalated(c) && (
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[10px] bg-red-500 text-white px-2 py-0.5 rounded-full font-semibold animate-pulse">
                          Requires Intervention
                        </span>
                        {!c.is_human_handoff && (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              takeoverMut.mutate(c.candidate_id)
                            }}
                            disabled={takeoverMut.isPending}
                            className="text-[10px] px-2 py-1 h-auto bg-blue-600 hover:bg-blue-700"
                          >
                            Take Over Chat
                          </Button>
                        )}
                      </div>
                    )}
                    <div className="flex items-baseline justify-between gap-1 mb-0.5">
                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate">{getCandidateDisplayName(c)}</p>
                      {c.last_message_at && (
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">
                          {formatDistanceToNow(new Date(c.last_message_at), { addSuffix: false })}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{c.last_message || 'No messages'}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      {c.is_human_handoff
                        ? <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <UserCheck size={10} /> {c.agent_name || 'Agent'}
                        </span>
                        : <span className="text-[10px] bg-emerald-100 text-emerald-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <Bot size={10} /> Bot
                        </span>}
                      {isCandidateEscalated(c) && !c.is_human_handoff && (
                        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">
                          AI Hold
                        </span>
                      )}
                      <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-medium', getPipelineStageClasses(c.pipeline_stage))}>
                        {getPipelineStageLabel(c.pipeline_stage)}
                      </span>
                      {c.last_language && <LangBadge lang={c.last_language} />}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Center: Transcript ───────────────────────────────────────────────── */}
      {selectedId ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Transcript header */}
          <div className="px-5 py-3 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 shadow-sm shrink-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center font-bold text-primary-700 text-sm">
                  {getCandidateInitial(selectedCandidate)}
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900 dark:text-zinc-50 text-sm">{getCandidateDisplayName(selectedCandidate)}</h2>
                  <div className="mt-1">
                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-medium', getPipelineStageClasses(selectedCandidate?.pipeline_stage))}>
                      {getPipelineStageLabel(selectedCandidate?.pipeline_stage)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="flex items-center gap-1"><Phone size={11} /> {selectedCandidate?.phone || selectedCandidate?.whatsapp_phone}</span>
                    {selectedCandidate?.last_chatbot_state && (
                      <span className="flex items-center gap-1 text-zinc-400 dark:text-zinc-500">
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
                    onClick={() => selectedId && takeoverMut.mutate(selectedId)}
                    disabled={takeoverMut.isPending}
                    className="flex items-center gap-1.5 text-sm bg-indigo-600 hover:bg-indigo-700"
                  >
                    {takeoverMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
                    Take Over
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={transcriptResponseStatus}
                onChange={(e) => setTranscriptResponseStatus(e.target.value)}
                className="px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                {RESPONSE_OPTIONS.map((option) => (
                  <option key={`transcript-${option.value || 'all'}`} value={option.value}>{option.label}</option>
                ))}
              </select>
              <input
                type="date"
                value={transcriptDateFrom}
                onChange={(e) => setTranscriptDateFrom(e.target.value)}
                className="px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              />
              <input
                type="date"
                value={transcriptDateTo}
                onChange={(e) => setTranscriptDateTo(e.target.value)}
                className="px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              />
              <button
                type="button"
                onClick={() => {
                  setTranscriptResponseStatus('')
                  setTranscriptDateFrom('')
                  setTranscriptDateTo('')
                }}
                className="text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:text-zinc-300"
              >
                Clear transcript filters
              </button>
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
              <div className="h-full flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500">
                <MessageSquare size={48} className="mb-3 text-zinc-200 dark:text-zinc-700" />
                <p className="text-sm">No messages yet</p>
              </div>
            ) : (
              <>
                {transcript.map((msg, i) => <MsgBubble key={msg.id || i} msg={msg} />)}
                {agentTyping && (
                  <div className="flex justify-start mb-3">
                    <div className="bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800/60 rounded-2xl rounded-tl-none px-4 py-2 shadow-sm text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-2">
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
            <div className="px-4 py-3 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
              {sendError && (
                <div className="flex items-center gap-2 text-xs text-red-500 mb-2">
                  <AlertCircle size={12} /> {sendError}
                </div>
              )}

              {/* Channel selector + template prefill */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">Send via:</span>
                {[
                  { value: 'whatsapp', label: 'WhatsApp' },
                  { value: 'email', label: 'Email', disabled: !selectedCandidate.email },
                  { value: 'both', label: 'Both', disabled: !selectedCandidate.email },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={opt.disabled}
                    onClick={() => setSendChannel(opt.value)}
                    className={clsx(
                      'text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors',
                      sendChannel === opt.value
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:border-indigo-400 hover:text-indigo-600',
                      opt.disabled && 'opacity-40 cursor-not-allowed',
                    )}
                    title={opt.disabled ? 'Candidate has no email address' : undefined}
                  >
                    {opt.label}
                  </button>
                ))}
                {msgContext && buildDefaultMessage() && (
                  <button
                    type="button"
                    onClick={() => setMessage(buildDefaultMessage())}
                    className="ml-auto flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800"
                    title="Prefill with job/interview details"
                  >
                    <Wand2 size={12} /> Use template
                  </button>
                )}
              </div>

              {/* Job/interview context hint */}
              {msgContext?.application?.job_title && (
                <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-1.5 flex items-center gap-1">
                  <Briefcase size={10} />
                  {msgContext.application.job_title}
                  {msgContext.interview?.scheduled_datetime && (
                    <span className="ml-1 text-emerald-600">
                      · Interview {format(new Date(msgContext.interview.scheduled_datetime), 'dd MMM HH:mm')}
                    </span>
                  )}
                </div>
              )}

              <form onSubmit={handleSend} className="flex items-end gap-2">

                {isRecording ? (
                  <div className="flex-1 flex items-center justify-between bg-red-50 border border-red-200 rounded-xl px-4 py-2 h-11">
                    <div className="flex items-center gap-2 text-red-600 text-sm font-medium">
                      <div className="w-2 h-2 rounded-full bg-red-600 animate-pulse" />
                      Recording voice note...
                    </div>
                    <button
                      type="button"
                      onClick={stopRecording}
                      className="text-red-600 hover:bg-red-100 p-1.5 rounded-lg transition-colors"
                    >
                      <Square size={16} fill="currentColor" />
                    </button>
                  </div>
                ) : audioUrl ? (
                  <div className="flex-1 flex items-center gap-3 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-2 h-11">
                    <button
                      type="button"
                      onClick={discardAudio}
                      className="text-zinc-400 dark:text-zinc-500 hover:text-red-500 transition-colors"
                      title="Discard voice note"
                    >
                      <Trash2 size={18} />
                    </button>
                    <audio src={audioUrl} controls className="h-7 w-full max-w-[220px]" />
                  </div>
                ) : (
                  <>
                    <div className="flex items-center pb-1">
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        id="agent-media-upload"
                        accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt"
                        onChange={(e) => {
                          if (e.target.files?.[0]) handleSend(null, e.target.files[0])
                        }}
                      />
                      <label
                        htmlFor="agent-media-upload"
                        className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-indigo-600 cursor-pointer transition-colors"
                      >
                        <Paperclip size={20} />
                      </label>
                    </div>

                    <div className="flex-1 bg-zinc-50 dark:bg-zinc-900/60 rounded-xl border border-zinc-200 dark:border-zinc-800 focus-within:ring-2 focus-within:ring-indigo-400 focus-within:bg-white dark:bg-zinc-900 transition-all">
                      <textarea
                        value={message}
                        onChange={(e) => {
                          setMessage(e.target.value)
                          socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: true })
                        }}
                        onBlur={() => socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: false })}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                        placeholder="Type a message as agent..."
                        className="w-full bg-transparent border-0 focus:ring-0 p-3 max-h-28 resize-none text-sm"
                        rows={1}
                      />
                    </div>
                  </>
                )}

                {(message.trim() || audioBlob) ? (
                  <Button
                    type="submit"
                    className="mb-0.5 w-10 h-10 px-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 flex items-center justify-center"
                  >
                    <Send size={16} />
                  </Button>
                ) : !isRecording && (
                  <Button
                    type="button"
                    onClick={startRecording}
                    variant="outline"
                    className="mb-0.5 w-10 h-10 px-0 rounded-xl border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:text-indigo-600 hover:bg-indigo-50 flex items-center justify-center"
                  >
                    <Mic size={18} />
                  </Button>
                )}
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
        <div className="flex-1 flex items-center justify-center bg-zinc-50 dark:bg-zinc-900/60">
          <div className="text-center text-zinc-400 dark:text-zinc-500">
            <MessageSquare size={56} className="mx-auto mb-3 text-zinc-200 dark:text-zinc-700" />
            <p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">Select a conversation</p>
            <p className="text-sm">Choose from the list to view the full chat transcript</p>
          </div>
        </div>
      )}

      {/* ── Right: Candidate context ─────────────────────────────────────────── */}
      {selectedCandidate && (
        <div className="w-64 shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col overflow-y-auto scrollbar-thin">
          <div className="p-4 border-b border-zinc-100 dark:border-zinc-800/60">
            <h3 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3">Candidate Info</h3>
            <div className="flex flex-col items-center text-center">
              <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 text-xl font-bold mb-2">
                {getCandidateInitial(selectedCandidate)}
              </div>
              <p className="font-semibold text-zinc-900 dark:text-zinc-50">{getCandidateDisplayName(selectedCandidate)}</p>
              <button
                type="button"
                onClick={() => {
                  setEditContactDraft({
                    name: getCandidateDisplayName(selectedCandidate),
                    email: selectedCandidate.email || '',
                    preferred_language: selectedCandidate.preferred_language || 'en',
                    notes: selectedCandidate.notes || '',
                  })
                  setIdentityError(null)
                  setShowEditContactModal(true)
                }}
                className="mt-1 text-[11px] text-indigo-600 hover:text-indigo-700"
              >
                Edit contact
              </button>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{selectedCandidate.phone || selectedCandidate.whatsapp_phone}</p>
            </div>
          </div>

          <div className="p-4 space-y-3 text-sm">
            {/* Status */}
            <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              <div className={clsx('w-2 h-2 rounded-full', selectedCandidate.is_human_handoff ? 'bg-indigo-500' : 'bg-emerald-500')} />
              <span>{selectedCandidate.is_human_handoff ? `Agent: ${selectedCandidate.agent_name || 'Active'}` : 'Bot Active'}</span>
            </div>

            {/* Bot state */}
            {selectedCandidate.last_chatbot_state && (
              <div className="flex items-start gap-2 text-zinc-600 dark:text-zinc-400">
                <RefreshCw size={13} className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
                <div>
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-wide">Bot State</p>
                  <p className="text-xs font-medium">{selectedCandidate.last_chatbot_state.replace(/_/g, ' ')}</p>
                </div>
              </div>
            )}

            {/* Language */}
            {selectedCandidate.last_language && (
              <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                <Globe size={13} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
                <span className="text-xs">Language: <LangBadge lang={selectedCandidate.last_language} /></span>
              </div>
            )}

            {/* Candidate status */}
            {selectedCandidate.candidate_status && (
              <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                <Briefcase size={13} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
                <span className="text-xs capitalize">{selectedCandidate.candidate_status}</span>
              </div>
            )}

            <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              <div className="w-3 h-3 rounded-full bg-zinc-200 dark:bg-zinc-800 shrink-0" />
              <span className={clsx('text-[11px] px-1.5 py-0.5 rounded-full font-medium', getPipelineStageClasses(selectedCandidate.pipeline_stage))}>
                {getPipelineStageLabel(selectedCandidate.pipeline_stage)}
              </span>
            </div>

            {/* Last activity */}
            {selectedCandidate.last_message_at && (
              <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                <Clock size={13} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
                <span className="text-xs">{formatDistanceToNow(new Date(selectedCandidate.last_message_at), { addSuffix: true })}</span>
              </div>
            )}
          </div>

          {/* Documents & CVs sent by this candidate */}
          <div className="px-3 pb-3">
            <ConversationDocumentsPanel candidateId={selectedId} />
          </div>

          {/* Quick actions */}
          <div className="p-4 border-t border-zinc-100 dark:border-zinc-800/60 mt-auto">
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
                onClick={() => selectedId && takeoverMut.mutate(selectedId)}
                disabled={takeoverMut.isPending}
              >
                <UserCheck size={13} /> Take Over Chat
              </Button>
            )}
          </div>
        </div>
      )}

      <Modal
        open={showEditContactModal && Boolean(selectedCandidate)}
        onClose={() => {
          setShowEditContactModal(false)
          setIdentityError(null)
        }}
        title="Edit Contact"
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!selectedCandidate) return
            const trimmedName = editContactDraft.name.trim()
            if (!trimmedName) {
              setIdentityError('Name is required.')
              return
            }

            setIdentityError(null)
            identityMut.mutate({
              candidateId: selectedCandidate.candidate_id,
              payload: {
                name: trimmedName,
                email: editContactDraft.email.trim() || null,
                preferred_language: editContactDraft.preferred_language,
                notes: editContactDraft.notes.trim() || null,
              },
            })
          }}
          className="space-y-3"
        >
          <div>
            <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">Name</label>
            <input
              value={editContactDraft.name}
              onChange={(e) => setEditContactDraft(prev => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              placeholder="Candidate name"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">Email</label>
            <input
              value={editContactDraft.email}
              onChange={(e) => setEditContactDraft(prev => ({ ...prev, email: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              placeholder="Email address"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">Preferred language</label>
            <select
              value={editContactDraft.preferred_language}
              onChange={(e) => setEditContactDraft(prev => ({ ...prev, preferred_language: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
            >
              <option value="en">English</option>
              <option value="si">Sinhala</option>
              <option value="ta">Tamil</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">Notes</label>
            <textarea
              value={editContactDraft.notes}
              onChange={(e) => setEditContactDraft(prev => ({ ...prev, notes: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              placeholder="Add recruiter notes"
            />
          </div>

          {identityError && <p className="text-xs text-red-500">{identityError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowEditContactModal(false)
                setIdentityError(null)
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={identityMut.isPending}>
              {identityMut.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
