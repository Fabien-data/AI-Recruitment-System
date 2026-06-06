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
import { useSearchParams, Link } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  MessageSquare, Search, Send, Phone, Mail, Bot, User,
  UserCheck, RefreshCw, Globe, Briefcase, MapPin, Clock,
  ChevronRight, AlertCircle, Wifi, WifiOff, Loader2,
  Mic, Square, Trash2, Paperclip, Wand2,
  SlidersHorizontal, ChevronDown, X as XIcon,
  FileText, Download, Eye, Image as ImageIcon,
  FolderKanban, Tag,
} from 'lucide-react'
import { clsx } from 'clsx'
import { categoryColor } from '../utils/categoryColor'
import { format, formatDistanceToNow } from 'date-fns'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { Modal } from '../components/ui/Modal'
import { getCommunications, sendCommunication, getCandidate } from '../api'
import { useAuthStore } from '../stores/authStore'
import { ConversationDocumentsPanel } from '../components/communications/ConversationDocumentsPanel'
import { CallPresenceToggle } from '../components/communications/CallPresenceToggle'
import { DispositionSelect, dispositionClasses, dispositionLabel } from '../components/communications/DispositionSelect'
import { CallRemarksPanel } from '../components/communications/CallRemarksPanel'
import { CVReviewModal } from './CVManager'
import { CANDIDATE_STAGE_LABELS, CANDIDATE_STATUS_BUCKETS, STATUS_COLORS, normalizeStatus, getStageLabel } from '../constants/lifecycle'

// Primary status buckets the agent works through, one at a time. Bound to the
// canonical candidates.status (server-side filter) — mutually exclusive, so a
// candidate appears in exactly one bucket and drops out as it advances.
// Shared source of truth: CANDIDATE_STATUS_BUCKETS (lifecycle.js).
const STATUS_BUCKET_VALUES = new Set(CANDIDATE_STATUS_BUCKETS.map((b) => b.value))

// The candidate's canonical recruitment stage (New/Screening/Certified/…) shown
// on the chat row so an agent sees — and live-tracks — where each lead sits.
function StageBadge({ status }) {
  const key = normalizeStatus(String(status || '').toLowerCase())
  const label = CANDIDATE_STAGE_LABELS[key]
  if (!label) return null
  return (
    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-semibold border', STATUS_COLORS[key] || 'bg-zinc-100 text-zinc-600 border-zinc-200')}>
      {label}
    </span>
  )
}

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

// One-tap label suggestions (Messenger-style) — common recruitment-call labels.
// Dynamic queue tags are appended at the call site; already-applied ones hidden.
const SUGGESTED_LABELS = ['Interested', 'Callback', 'CV pending', 'Strong candidate', 'Not reachable', 'Wrong number']

const getActiveChats = ({ search, statusBucket, projectId, pipelineStage, handoffState, sortBy, responseStatus, dateFrom, dateTo, disposition, contacted, claimed, callStatus }) => {
  const params = new URLSearchParams()
  params.set('limit', '5000')
  if (search) params.set('search', search)
  if (statusBucket) params.set('status', statusBucket)
  if (projectId) params.set('project_id', projectId)
  if (pipelineStage) params.set('pipeline_stage', pipelineStage)
  if (handoffState) params.set('handoff_state', handoffState)
  if (sortBy) params.set('sort_by', sortBy)
  if (responseStatus) params.set('response_status', responseStatus)
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  if (disposition) params.set('disposition', disposition)
  if (contacted) params.set('contacted', contacted)
  if (claimed) params.set('claimed', claimed)
  if (callStatus) params.set('call_status', callStatus)
  return apiFetch(`/api/communications/active-chats?${params.toString()}`)
}

// Server-side project list for the conversations filter dropdown.
const getProjectsForFilter = () =>
  apiFetch('/api/projects?limit=200').then((r) => (Array.isArray(r) ? r : (r?.data || r?.projects || [])))
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

// Call presence. start surfaces the 409 conflict body (who's already on the
// call) so the UI can warn the agent and offer to start anyway (?force=1).
async function startCall(id, force) {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_BASE}/api/communications/candidate/${id}/call-start${force ? '?force=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 409) {
    const err = new Error('call_conflict')
    err.conflict = data
    throw err
  }
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`)
  return data
}
const endCall = (id) => apiFetch(`/api/communications/candidate/${id}/call-end`, { method: 'POST' })
const callHeartbeat = (ids) => apiFetch('/api/communications/calls/heartbeat', {
  method: 'POST',
  body: JSON.stringify({ candidate_ids: ids }),
})
const setDispositionApi = (id, disposition) => apiFetch(`/api/communications/candidate/${id}/disposition`, {
  method: 'PATCH',
  body: JSON.stringify({ disposition }),
})
const claimCandidate = (id) => apiFetch(`/api/communications/candidate/${id}/claim`, { method: 'POST' })
const unclaimCandidate = (id) => apiFetch(`/api/communications/candidate/${id}/unclaim`, { method: 'POST' })
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

// Derive a display filename + whether the media is a PDF/image from url or content.
function mediaMeta(msg, mediaUrl) {
  const fromContent = String(msg.content || '').replace(/^📄\s*/, '').trim()
  const urlName = (() => {
    try { return decodeURIComponent(String(mediaUrl).split('?')[0].split('/').pop() || '') } catch { return '' }
  })()
  const name = (fromContent && /\.\w{2,5}$/.test(fromContent)) ? fromContent : (urlName || fromContent || 'document')
  const lower = `${name} ${mediaUrl}`.toLowerCase()
  const isPdf = lower.includes('.pdf')
  const isImage = /\.(jpg|jpeg|png|webp|gif|bmp|tiff)\b/.test(lower)
  return { name, isPdf, isImage }
}

function MediaContent({ msg, isOutbound }) {
  const [viewer, setViewer] = useState(false)
  const mediaUrl = getPrimaryAttachment(msg)
  if (!mediaUrl) return null

  const type = msg.message_type
  const { name, isPdf, isImage } = mediaMeta(msg, mediaUrl)

  if (type === 'image' || type === 'sticker' || (type === 'document' && isImage)) {
    return (
      <>
        <button type="button" onClick={() => setViewer(true)} className="block group">
          <img
            src={mediaUrl}
            alt={name || 'image'}
            className="max-h-64 w-auto rounded-lg border border-white/20 group-hover:opacity-90 transition-opacity cursor-zoom-in"
          />
        </button>
        <Modal open={viewer} onClose={() => setViewer(false)} title={name || 'Image'} size="2xl">
          <img src={mediaUrl} alt={name || 'image'} className="w-full h-auto rounded-lg" />
          <div className="mt-3 flex justify-end">
            <a href={mediaUrl} download target="_blank" rel="noreferrer">
              <Button variant="secondary" size="sm"><Download size={14} className="mr-1" /> Download</Button>
            </a>
          </div>
        </Modal>
      </>
    )
  }

  if (type === 'audio' || type === 'voice') {
    return <audio controls src={mediaUrl} className="w-64 max-w-full" />
  }

  if (type === 'video') {
    return <video controls src={mediaUrl} className="max-h-64 w-auto rounded-lg border border-white/20" />
  }

  // Documents (PDF / Word / other) — file card with quick-view + download.
  return (
    <>
      <div className={clsx(
        'inline-flex items-center gap-2.5 rounded-xl px-3 py-2 max-w-[16rem]',
        isOutbound ? 'bg-white/15' : 'bg-zinc-100 dark:bg-zinc-700/60'
      )}>
        <span className={clsx('shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
          isOutbound ? 'bg-white/20' : 'bg-white dark:bg-zinc-800')}>
          <FileText size={16} className={isPdf ? 'text-red-500' : 'text-indigo-500'} />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium truncate">{name}</span>
          <span className="flex items-center gap-2 mt-0.5">
            {isPdf && (
              <button type="button" onClick={() => setViewer(true)}
                className={clsx('inline-flex items-center gap-1 text-[11px] underline', isOutbound ? 'text-white/90' : 'text-indigo-600 dark:text-indigo-300')}>
                <Eye size={11} /> View
              </button>
            )}
            <a href={mediaUrl} target="_blank" rel="noreferrer"
              className={clsx('inline-flex items-center gap-1 text-[11px] underline', isOutbound ? 'text-white/90' : 'text-indigo-600 dark:text-indigo-300')}>
              <Download size={11} /> Open
            </a>
          </span>
        </span>
      </div>
      {isPdf && (
        <Modal open={viewer} onClose={() => setViewer(false)} title={name || 'Document'} size="3xl">
          <iframe src={`${mediaUrl}#toolbar=1`} title={name || 'document'} className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700" style={{ height: '75vh' }} />
        </Modal>
      )}
    </>
  )
}

// Parse the message metadata JSON (location coords, reaction emoji, etc.).
function parseMsgMeta(msg) {
  let meta = msg.metadata
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) } catch { meta = null }
  }
  return meta || {}
}

// Renders the body of a message for ALL types so the transcript is complete:
// text, media (image/voice/document/video/sticker), interactive replies,
// location pins, reactions, and a graceful fallback for unknown / missing-media.
const MEDIA_TYPES = ['image', 'document', 'audio', 'voice', 'video', 'sticker']

function MessageBody({ msg, isOutbound }) {
  const type = msg.message_type
  const meta = parseMsgMeta(msg)
  const mediaUrl = getPrimaryAttachment(msg)

  // Interactive button/list reply → show the chosen option as a chip.
  if (type === 'interactive') {
    return (
      <span className="inline-flex items-center gap-1 rounded-lg border border-current/40 px-2 py-1 text-xs font-medium opacity-90">
        <ChevronRight size={12} /> {msg.content || 'Selected an option'}
      </span>
    )
  }

  // Location pin → map link.
  if (type === 'location') {
    const lat = meta.latitude
    const lng = meta.longitude
    const url = meta.maps_url || ((lat != null && lng != null) ? `https://www.google.com/maps?q=${lat},${lng}` : null)
    const label = meta.name || String(msg.content || '').replace(/^📍\s*Location:\s*/, '') || 'Shared location'
    return (
      <span className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1"><MapPin size={13} /> {label}</span>
        {url && <a href={url} target="_blank" rel="noreferrer" className="text-[11px] underline opacity-90">Open in Maps</a>}
      </span>
    )
  }

  // Reaction → emoji line.
  if (type === 'reaction') {
    const emoji = meta.emoji || String(msg.content || '👍').replace(/\s*\(reaction\)$/, '')
    return <span className="text-xl leading-none">{emoji}</span>
  }

  // Media with a resolved URL → rich media (image/voice/video/document/sticker).
  if (MEDIA_TYPES.includes(type)) {
    if (mediaUrl) {
      const showCaption = (type === 'audio' || type === 'voice') && msg.content
      return (
        <>
          <MediaContent msg={msg} isOutbound={isOutbound} />
          {showCaption && <div className="mt-1 text-sm whitespace-pre-wrap break-words">{msg.content}</div>}
        </>
      )
    }
    // Media type but no URL (re-host failed / not synced) → graceful fallback.
    return (
      <span className="inline-flex items-center gap-1 text-xs italic opacity-80">
        <AlertCircle size={12} /> {msg.content || `${type} (media unavailable)`}
      </span>
    )
  }

  // Text / unknown.
  if (msg.content) return <span>{msg.content}</span>
  return <span className="italic opacity-70">{type && type !== 'text' ? `[${type} message]` : ''}</span>
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

// ── Category badge ────────────────────────────────────────────────────────────
// Colored label for an open-ended category (job role, project, sector, country).
// Colors are assigned deterministically by categoryColor() so any new job or
// project added later automatically gets a stable, distinct color — no code edit.
// Self-hides when there's no value; long text truncates with a hover tooltip.

function CategoryBadge({ value, icon: Icon, title, max = 18 }) {
  if (!value) return null
  const text = String(value)
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text
  return (
    <span
      title={title ? `${title}: ${text}` : text}
      className={clsx(
        'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium max-w-[140px]',
        categoryColor(text),
      )}
    >
      {Icon && <Icon size={10} className="shrink-0" />}
      <span className="truncate">{short}</span>
    </span>
  )
}

// ── Candidate labels (manual tags) ─────────────────────────────────────────────
// Parse candidates.tags which may arrive as a Postgres text[] (JS array),
// a JSON string, or a comma-separated string depending on dialect/source.
function parseTagList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string') {
    const s = value.trim()
    if (s.startsWith('[')) {
      try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(Boolean) : [] } catch { /* fall through */ }
    }
    return s.split(',').map((t) => t.trim()).filter(Boolean)
  }
  return []
}

function LabelsEditor({ tags, onAdd, onRemove, saving, suggestions = [] }) {
  const [input, setInput] = useState('')
  const submit = () => {
    const v = input.trim()
    if (v) { onAdd(v); setInput('') }
  }
  return (
    <div className="p-4 border-b border-zinc-100 dark:border-zinc-800/60">
      <p className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
        <Tag size={12} /> Labels
      </p>
      <div className="flex flex-wrap gap-1 mb-2">
        {tags.length === 0 && <span className="text-xs text-zinc-400 dark:text-zinc-500 italic">No labels yet</span>}
        {tags.map((t) => (
          <span key={t} className={clsx('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium', categoryColor(t))}>
            {t}
            <button type="button" onClick={() => onRemove(t)} className="hover:opacity-70" aria-label={`Remove ${t}`}>
              <XIcon size={9} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          placeholder="Add label…"
          className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800"
        />
        <button type="button" onClick={submit} disabled={saving}
          className="text-xs px-2.5 py-1.5 rounded-lg bg-zinc-900 text-white disabled:opacity-50">
          Add
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="mt-2.5">
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-1.5">Suggested</p>
          <div className="flex flex-wrap gap-1">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onAdd(s)}
                disabled={saving}
                className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:border-zinc-400 disabled:opacity-50 transition-colors"
              >
                <span className="text-zinc-400">+</span> {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
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
          {/* Unified renderer: text, media, interactive, location, reaction,
              sticker, and a graceful fallback for unknown / missing-media. */}
          <MessageBody msg={msg} isOutbound={!isInbound} />
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
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedId, setSelectedId] = useState(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState(searchParams.get('q') || '')
  const [pipelineStage, setPipelineStage] = useState(searchParams.get('pipeline_stage') || '')
  const [handoffState, setHandoffState] = useState(searchParams.get('handoff_state') || '')
  const [sortBy, setSortBy] = useState(searchParams.get('sort_by') || 'latest_desc')
  const [responseStatus, setResponseStatus] = useState(searchParams.get('response_status') || '')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '')
  // Primary status bucket (server-side, ca.status) — defaults to New so an agent
  // starts on the queue they work first.
  const [statusBucket, setStatusBucket] = useState(() => {
    const s = searchParams.get('status')
    return s && STATUS_BUCKET_VALUES.has(s) ? s : 'new'
  })
  // Project scope (server-side, effective project) — remembered per agent.
  const [projectId, setProjectId] = useState(() => searchParams.get('project_id') || localStorage.getItem('comms.projectId') || '')
  const [jobFilter, setJobFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  // Smart-view / triage filters (Phase 2).
  const [disposition, setDispositionFilter] = useState(searchParams.get('disposition') || '')
  const [contacted, setContacted] = useState(searchParams.get('contacted') || '')
  const [claimed, setClaimed] = useState(searchParams.get('claimed') || '')
  const [callStatus, setCallStatus] = useState(searchParams.get('call_status') || '')
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
  const currentUser = useAuthStore((s) => s.user)
  const [cvModalOpen, setCvModalOpen] = useState(false)
  // Refs used by the takeover/disposition fix so the selected chat survives a
  // list refetch even when an active filter would exclude it.
  const selectedIdRef = useRef(null)
  const chatListRef = useRef([])
  const selectedCandidateRef = useRef(null)
  // Mirror the active status bucket into a ref so the socket effect (deps: [])
  // can decide whether a live stage-change should drop a row from the list.
  const statusBucketRef = useRef(statusBucket)
  useEffect(() => { statusBucketRef.current = statusBucket }, [statusBucket])

  // Remember the agent's chosen project across sessions.
  useEffect(() => {
    if (projectId) localStorage.setItem('comms.projectId', projectId)
    else localStorage.removeItem('comms.projectId')
  }, [projectId])

  // Server-side project list for the filter dropdown.
  const { data: projectList = [] } = useQuery({
    queryKey: ['comms-projects'],
    queryFn: getProjectsForFilter,
    staleTime: 5 * 60 * 1000,
  })
  // If the remembered project is no longer available, fall back to All.
  useEffect(() => {
    if (projectId && projectId !== 'unassigned' && projectList.length > 0
        && !projectList.some((p) => String(p.id) === String(projectId))) {
      setProjectId('')
    }
  }, [projectList, projectId])

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

  // Selected candidate object — resilient so it never goes undefined mid-action.
  // Right after a takeover / disposition change under an active filter, the row
  // can drop out of the refetched list; we fall back to the last-known selected
  // row so the header/input/buttons don't blank out (the takeover-after-filter
  // bug). The list itself also pins the selected row (see active-chats effect).
  const matchedSelected = chatList.find(c => c.candidate_id === selectedId)
  const selectedCandidate = matchedSelected
    || (selectedCandidateRef.current?.candidate_id === selectedId ? selectedCandidateRef.current : null)

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { chatListRef.current = chatList }, [chatList])
  useEffect(() => { if (matchedSelected) selectedCandidateRef.current = matchedSelected }, [matchedSelected])

  // Client-side role/label filters — distinct options derived from the loaded
  // list. Project + status are filtered server-side (see active-chats query).
  const jobOptions = [...new Set(chatList.map(c => c.effective_job_title || c.latest_job_title).filter(Boolean))].sort()
  const tagOptions = [...new Set(chatList.flatMap(c => parseTagList(c.tags)))].sort()
  const visibleChats = chatList.filter(c =>
    (!jobFilter || (c.effective_job_title || c.latest_job_title) === jobFilter) &&
    (!tagFilter || parseTagList(c.tags).includes(tagFilter))
  )

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

  // Mirror the open chat into the URL (?candidate=) so leaving Messages (e.g. to
  // CV Manager full page, Candidates, etc.) and coming back restores the exact
  // conversation the agent was working — they never lose their place.
  useEffect(() => {
    const current = searchParams.get('candidate') || ''
    if (selectedId && selectedId !== current) {
      const next = new URLSearchParams(searchParams)
      next.set('candidate', selectedId)
      setSearchParams(next, { replace: true })
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

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
    queryKey: ['active-chats', search, statusBucket, projectId, pipelineStage, handoffState, sortBy, responseStatus, dateFrom, dateTo, disposition, contacted, claimed, callStatus],
    queryFn: () => getActiveChats({
      search,
      statusBucket,
      projectId,
      pipelineStage,
      handoffState,
      sortBy,
      responseStatus,
      dateFrom,
      dateTo,
      disposition,
      contacted,
      claimed,
      callStatus,
    }),
    refetchInterval: 30000, // fallback poll every 30s
  })

  useEffect(() => {
    if (!Array.isArray(activeChatsData)) return
    let next = activeChatsData
    const selId = selectedIdRef.current
    // If the open conversation fell out of the current filter, keep it pinned at
    // the top (flagged) so a takeover / disposition change never blanks out the
    // chat the agent is actively working.
    if (selId && !next.some(c => c.candidate_id === selId)) {
      const prevRow = chatListRef.current.find(c => c.candidate_id === selId)
      if (prevRow) next = [{ ...prevRow, _pinned: true }, ...next]
    }
    setChatList(next)
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

  // Full candidate record (metadata, skills, age, experience) for the info panel.
  const { data: candidateDetailRaw } = useQuery({
    queryKey: ['candidate-detail', selectedId],
    queryFn: () => getCandidate(selectedId),
    enabled: !!selectedId,
  })
  const candidateDetail = candidateDetailRaw?.candidate || candidateDetailRaw || null

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
        // Carry media + metadata so images/voice/location render live without a
        // refetch (new_message also carries these; whichever survives dedup keeps them).
        media_url: newMessage.media_url || null,
        metadata: newMessage.metadata || null,
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

    // In-call presence: another agent started/ended a phone call. Patch the row
    // so the 📞 badge appears/disappears live for everyone.
    socket.on('call_status_changed', (data) => {
      if (!data?.candidate_id) return
      setChatList(prev => prev.map(c =>
        c.candidate_id === data.candidate_id
          ? (data.on_call
              ? { ...c, call_status: 'on_call', call_agent_id: data.call_agent_id, call_agent_name: data.call_agent_name, call_started_at: data.call_started_at }
              : { ...c, call_status: null, call_agent_id: null, call_agent_name: null, call_started_at: null })
          : c
      ))
    })

    // Lead status (disposition) changed by any agent — patch the row live.
    socket.on('disposition_changed', (d) => {
      if (!d?.candidate_id) return
      setChatList(prev => prev.map(c =>
        c.candidate_id === d.candidate_id ? { ...c, disposition: d.disposition, last_contacted_at: d.ts } : c
      ))
    })

    // Candidate advanced/changed stage (any source: calling console, CV Manager,
    // applications). Patch the live status badge, and drop the row from the list
    // if it no longer matches the active bucket — unless it's the open chat.
    socket.on('candidate_stage_changed', (d) => {
      if (!d?.candidate_id || !d.status) return
      setChatList(prev => {
        const bucket = statusBucketRef.current
        const isOpen = selectedIdRef.current === d.candidate_id
        return prev.flatMap(c => {
          if (c.candidate_id !== d.candidate_id) return [c]
          const updated = { ...c, candidate_status: d.status, conversation_stage: d.status }
          if (bucket && d.status !== bucket && !isOpen) return []   // left this bucket
          return [updated]
        })
      })
    })

    // Shared-pool claim changed by any agent — patch the row live.
    socket.on('claim_changed', (d) => {
      if (!d?.candidate_id) return
      setChatList(prev => prev.map(c =>
        c.candidate_id === d.candidate_id ? { ...c, claimed_by: d.claimed_by || null, claimer_name: d.claimer_name || null } : c
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

  // ── Heartbeat my active calls so the server TTL sweep never reaps them ──────
  const myCallKey = chatList
    .filter(c => c.call_status === 'on_call' && c.call_agent_id === currentUser?.id)
    .map(c => c.candidate_id)
    .join(',')
  useEffect(() => {
    if (!myCallKey) return undefined
    const ids = myCallKey.split(',')
    const t = setInterval(() => { callHeartbeat(ids).catch(() => {}) }, 60000)
    return () => clearInterval(t)
  }, [myCallKey])

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
  // Optimistically flip the row locally so the open chat updates instantly and
  // survives the refetch even under a handoff_state filter (the takeover-after-
  // filter fix). The WebSocket handoff_start/end echo merges by candidate_id.
  const takeoverMut = useMutation({
    mutationFn: (candidateId) => takeover(candidateId),
    onSuccess: (_data, candidateId) => {
      setChatList(prev => prev.map(c => c.candidate_id === candidateId
        ? { ...c, is_human_handoff: true, agent_id: currentUser?.id, agent_name: currentUser?.full_name || 'You', pipeline_stage: 'human_takeover_active' }
        : c))
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
    },
  })
  const releaseMut = useMutation({
    mutationFn: (candidateId) => release(candidateId || selectedId),
    onSuccess: (_data, candidateId) => {
      const id = candidateId || selectedId
      setChatList(prev => prev.map(c => c.candidate_id === id
        ? { ...c, is_human_handoff: false, agent_id: null, agent_name: null, pipeline_stage: 'bot_engaging' }
        : c))
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
    },
  })

  // ── In-call presence mutations ─────────────────────────────────────────────
  const callStartMut = useMutation({
    mutationFn: ({ id, force }) => startCall(id, force),
    onSuccess: (_data, vars) => {
      setChatList(prev => prev.map(c => c.candidate_id === vars.id
        ? { ...c, call_status: 'on_call', call_agent_id: currentUser?.id, call_agent_name: currentUser?.full_name || 'You', call_started_at: new Date().toISOString() }
        : c))
    },
    onError: (err, vars) => {
      if (err?.conflict) {
        const who = err.conflict.call_agent_name || 'Another agent'
        if (window.confirm(`${who} is already on a call with this candidate. Start a call anyway?`)) {
          callStartMut.mutate({ id: vars.id, force: true })
        }
      } else {
        window.alert('Could not start the call. Please try again.')
      }
    },
  })
  const callEndMut = useMutation({
    mutationFn: (id) => endCall(id),
    onSuccess: (_data, id) => {
      setChatList(prev => prev.map(c => c.candidate_id === id
        ? { ...c, call_status: null, call_agent_id: null, call_agent_name: null, call_started_at: null }
        : c))
    },
  })

  // ── Disposition (lead status) + shared-pool claim mutations ────────────────
  const dispositionMut = useMutation({
    mutationFn: ({ id, value }) => setDispositionApi(id, value),
    onSuccess: (_data, vars) => {
      setChatList(prev => prev.map(c => c.candidate_id === vars.id
        ? { ...c, disposition: vars.value, last_contacted_at: new Date().toISOString() }
        : c))
      queryClient.invalidateQueries({ queryKey: ['candidate-detail', vars.id] })
    },
  })
  const claimMut = useMutation({
    mutationFn: (id) => claimCandidate(id),
    onSuccess: (_data, id) => {
      setChatList(prev => prev.map(c => c.candidate_id === id
        ? { ...c, claimed_by: currentUser?.id, claimer_name: currentUser?.full_name || 'You' }
        : c))
    },
  })
  const unclaimMut = useMutation({
    mutationFn: (id) => unclaimCandidate(id),
    onSuccess: (_data, id) => {
      setChatList(prev => prev.map(c => c.candidate_id === id
        ? { ...c, claimed_by: null, claimer_name: null }
        : c))
    },
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

  // Manual candidate labels (tags). Optimistically patch the chat-list row so
  // the left-list chips update instantly, then refetch for consistency.
  const tagsMut = useMutation({
    mutationFn: ({ candidateId, tags }) => updateCandidateIdentity(candidateId, { tags }),
    onSuccess: (_, vars) => {
      setChatList(prev => prev.map(c =>
        c.candidate_id === vars.candidateId ? { ...c, tags: vars.tags } : c
      ))
      queryClient.invalidateQueries({ queryKey: ['candidate-detail', vars.candidateId] })
      queryClient.invalidateQueries({ queryKey: ['candidate', vars.candidateId] })
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
          {/* At-a-glance counts so agents can size up the queue without scrolling. */}
          {chatList.length > 0 && (() => {
            const total = chatList.length
            const handoff = chatList.filter(c => c.is_human_handoff).length
            const bot = total - handoff
            const cv = chatList.filter(c => c.cv_uploaded || c.has_cv || String(c.last_chatbot_state || '').toLowerCase().includes('cv')).length
            const unread = chatList.filter(c => Number(c.unread_count) > 0).length
            const Chip = ({ tone, children }) => (
              <span className={clsx('px-2 py-0.5 rounded-full font-semibold', tone)}>{children}</span>
            )
            return (
              <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
                <Chip tone="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{total} chats</Chip>
                <Chip tone="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">{bot} bot</Chip>
                {handoff > 0 && <Chip tone="bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300">{handoff} with agent</Chip>}
                {cv > 0 && <Chip tone="bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300">{cv} CV</Chip>}
                {unread > 0 && <Chip tone="bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">{unread} unread</Chip>}
              </div>
            )
          })()}
          {/* Primary status buckets — the agent works one at a time; a candidate
              drops out of its bucket as it advances (New → Screening → … ). */}
          <div className="mb-2 flex flex-wrap gap-1">
            {CANDIDATE_STATUS_BUCKETS.map((b) => (
              <button
                key={b.value}
                type="button"
                onClick={() => setStatusBucket(b.value)}
                className={clsx(
                  'px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors',
                  statusBucket === b.value
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                )}
              >
                {b.label}
              </button>
            ))}
          </div>
          {/* Project scope — server-side; one agent typically works one project. */}
          <div className="mb-2 flex items-center gap-1.5">
            <FolderKanban size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
            >
              <option value="">All projects</option>
              <option value="unassigned">Unassigned (no project)</option>
              {projectList.map((p) => (
                <option key={p.id} value={p.id}>{p.title || p.name || 'Untitled project'}</option>
              ))}
            </select>
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
          {/* Smart views — one-tap triage filters so the 5 agents can divide the
              queue without colliding (these set the same query state the API uses). */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {[
              { key: 'oncall', label: 'On call now', active: callStatus === 'on_call', toggle: () => setCallStatus(callStatus === 'on_call' ? '' : 'on_call') },
              { key: 'uncontacted', label: 'Uncontacted', active: contacted === 'no', toggle: () => setContacted(contacted === 'no' ? '' : 'no') },
              { key: 'mine', label: 'Mine', active: claimed === 'me', toggle: () => setClaimed(claimed === 'me' ? '' : 'me') },
              { key: 'escalated', label: 'Escalated', active: pipelineStage === 'pending_human_review', toggle: () => setPipelineStage(pipelineStage === 'pending_human_review' ? '' : 'pending_human_review') },
            ].map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.toggle}
                className={clsx(
                  'px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
                  chip.active
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>
          {(() => {
            // Status bucket + project are primary scopes shown above (not counted).
            const activeFilterCount = [pipelineStage, responseStatus, handoffState, dateFrom, dateTo, jobFilter, disposition, contacted, claimed, callStatus].filter(Boolean).length
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
                      setPipelineStage('')
                      setHandoffState('')
                      setSortBy('latest_desc')
                      setResponseStatus('')
                      setDateFrom('')
                      setDateTo('')
                      setJobFilter('')
                      setDispositionFilter('')
                      setContacted('')
                      setClaimed('')
                      setCallStatus('')
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
              <select
                value={jobFilter}
                onChange={(e) => setJobFilter(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                <option value="">All roles</option>
                {jobOptions.map((option) => (
                  <option key={`role-${option}`} value={option}>{option}</option>
                ))}
              </select>
              {tagOptions.length > 0 && (
                <select
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
                >
                  <option value="">All labels</option>
                  {tagOptions.map((option) => (
                    <option key={`tag-${option}`} value={option}>{option}</option>
                  ))}
                </select>
              )}
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
          ) : visibleChats.length === 0 ? (
            <div className="p-8 text-center text-zinc-400 dark:text-zinc-500">
              <MessageSquare size={40} className="mx-auto mb-2 text-zinc-200 dark:text-zinc-700" />
              <p className="text-sm">{chatList.length === 0 ? 'No conversations yet' : 'No conversations match the filters'}</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {visibleChats.map((c) => (
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
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {c._pinned && (
                        <span className="text-[10px] bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded-full font-medium" title="Kept open — outside the current filter">
                          pinned
                        </span>
                      )}
                      {c.call_status === 'on_call' && (
                        <span className="text-[10px] bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-1">
                          <Phone size={10} className="animate-pulse" /> {c.call_agent_id === currentUser?.id ? 'You' : (c.call_agent_name || 'On call')}
                        </span>
                      )}
                      {c.disposition && (
                        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-semibold', dispositionClasses(c.disposition))}>
                          {dispositionLabel(c.disposition)}
                        </span>
                      )}
                      {c.claimed_by && (
                        <span
                          className="text-[10px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1"
                          title={`Claimed by ${c.claimed_by === currentUser?.id ? 'you' : (c.claimer_name || 'an agent')}`}
                        >
                          <UserCheck size={10} /> {c.claimed_by === currentUser?.id ? 'Mine' : (c.claimer_name || 'Claimed')}
                        </span>
                      )}
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
                      <StageBadge status={c.candidate_status} />
                      <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-medium', getPipelineStageClasses(c.pipeline_stage))}>
                        {getPipelineStageLabel(c.pipeline_stage)}
                      </span>
                      {c.last_language && <LangBadge lang={c.last_language} />}
                      <CategoryBadge value={c.effective_job_title || c.latest_job_title}     icon={Briefcase}    title="Role" />
                      <CategoryBadge value={c.effective_project_title || c.latest_project_title} icon={FolderKanban} title="Project" />
                      <CategoryBadge value={c.latest_job_category}  icon={Tag}          title="Sector" />
                      <CategoryBadge value={c.latest_job_country}   icon={MapPin}       title="Country" />
                      {/* Manual labels (capped to keep the row tidy). */}
                      {parseTagList(c.tags).slice(0, 3).map((t) => (
                        <CategoryBadge key={`tag-${t}`} value={t} icon={Tag} title="Label" />
                      ))}
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
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StageBadge status={selectedCandidate?.candidate_status} />
                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-medium', getPipelineStageClasses(selectedCandidate?.pipeline_stage))}>
                      {getPipelineStageLabel(selectedCandidate?.pipeline_stage)}
                    </span>
                    <CategoryBadge value={selectedCandidate?.effective_job_title || selectedCandidate?.latest_job_title}     icon={Briefcase}    title="Role" max={28} />
                    <CategoryBadge value={selectedCandidate?.effective_project_title || selectedCandidate?.latest_project_title} icon={FolderKanban} title="Project" max={28} />
                    <CategoryBadge value={selectedCandidate?.latest_job_category}  icon={Tag}          title="Sector" max={28} />
                    <CategoryBadge value={selectedCandidate?.latest_job_country}   icon={MapPin}       title="Country" max={28} />
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

              {/* In-call presence + Takeover / Release */}
              <div className="flex items-center gap-2">
                <CallPresenceToggle
                  candidate={selectedCandidate}
                  currentUserId={currentUser?.id}
                  starting={callStartMut.isPending}
                  ending={callEndMut.isPending}
                  onStart={() => selectedId && callStartMut.mutate({ id: selectedId })}
                  onEnd={() => selectedId && callEndMut.mutate(selectedId)}
                />
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
        <div className="w-80 shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col overflow-y-auto scrollbar-thin">
          {/* Header — identity + quick jumps (Messenger-style) */}
          <div className="p-4 border-b border-zinc-100 dark:border-zinc-800/60">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 text-lg font-bold shrink-0">
                {getCandidateInitial(selectedCandidate)}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-zinc-900 dark:text-zinc-50 truncate">{getCandidateDisplayName(selectedCandidate)}</p>
                <Link to={`/candidates/${selectedId}`} className="text-[11px] text-indigo-600 hover:text-indigo-700">View profile</Link>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              <Phone size={12} className="shrink-0" /> {selectedCandidate.phone || selectedCandidate.whatsapp_phone || '—'}
            </div>
            <div className="mt-3 flex items-center gap-2">
              {/* Opens the full CV review/edit flow as a modal over the chat —
                  the agent never leaves the conversation they're working. */}
              <button
                type="button"
                onClick={() => setCvModalOpen(true)}
                className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <FileText size={12} /> CV Manager
              </button>
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
                className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <User size={12} /> Edit
              </button>
            </div>
          </div>

          {/* Activity — assignment + last contact (the agent's working state) */}
          <div className="p-4 border-b border-zinc-100 dark:border-zinc-800/60">
            <p className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3">Activity</p>
            <div>
              {selectedCandidate.claimed_by ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-violet-700 dark:text-violet-300 inline-flex items-center gap-1 min-w-0">
                    <UserCheck size={12} className="shrink-0" />
                    <span className="truncate">{selectedCandidate.claimed_by === currentUser?.id ? 'Claimed by you' : `Claimed by ${selectedCandidate.claimer_name || 'an agent'}`}</span>
                  </span>
                  {selectedCandidate.claimed_by === currentUser?.id && (
                    <button
                      type="button"
                      onClick={() => unclaimMut.mutate(selectedId)}
                      disabled={unclaimMut.isPending}
                      className="text-[11px] text-zinc-500 hover:text-rose-600 underline underline-offset-2 shrink-0"
                    >
                      Release
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => claimMut.mutate(selectedId)}
                  disabled={claimMut.isPending}
                  className="w-full text-xs inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-violet-200 text-violet-700 hover:bg-violet-50 disabled:opacity-60"
                >
                  <UserCheck size={13} /> Claim this chat
                </button>
              )}
            </div>
            {selectedCandidate.last_contacted_at && (
              <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                Last contacted {formatDistanceToNow(new Date(selectedCandidate.last_contacted_at), { addSuffix: true })}
              </p>
            )}
          </div>

          {/* Call log & remarks — kept high (above Labels) so agents log and see
              calls first while working the candidate. */}
          <div className="border-b border-zinc-100 dark:border-zinc-800/60 pt-3">
            <CallRemarksPanel candidateId={selectedId} candidateStatus={selectedCandidate?.candidate_status} />
          </div>

          {/* Manual labels (tags) for this candidate + one-tap suggestions. */}
          <LabelsEditor
            tags={parseTagList(candidateDetail?.tags ?? selectedCandidate.tags)}
            saving={tagsMut.isPending}
            suggestions={(() => {
              const applied = parseTagList(candidateDetail?.tags ?? selectedCandidate.tags)
              return [...new Set([...SUGGESTED_LABELS, ...tagOptions])].filter((t) => !applied.includes(t)).slice(0, 6)
            })()}
            onAdd={(t) => {
              const cur = parseTagList(candidateDetail?.tags ?? selectedCandidate.tags)
              if (cur.includes(t)) return
              tagsMut.mutate({ candidateId: selectedId, tags: [...cur, t] })
            }}
            onRemove={(t) => {
              const cur = parseTagList(candidateDetail?.tags ?? selectedCandidate.tags)
              tagsMut.mutate({ candidateId: selectedId, tags: cur.filter((x) => x !== t) })
            }}
          />

          <div className="p-4 space-y-3 text-sm">
            <p className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Status &amp; details</p>
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
                <span className="text-xs capitalize">{getStageLabel(normalizeStatus(String(selectedCandidate.candidate_status || '').toLowerCase()))}</span>
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

            {/* Extracted profile (from chat + CV) */}
            {candidateDetail && (() => {
              let meta = candidateDetail.metadata
              if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { meta = {} } }
              meta = meta || {}
              const rows = [
                ['Age', (candidateDetail.age || meta.age) ? `${candidateDetail.age || meta.age} yrs` : null],
                ['Height', meta.height_cm ? `${meta.height_cm} cm` : null],
                ['Experience', (candidateDetail.experience_years || meta.experience_years) ? `${candidateDetail.experience_years || meta.experience_years} yrs` : null],
                ['Country', meta.destination_country || meta.country || null],
                ['Licenses', meta.licenses || null],
                ['Prev. Employer', meta.previous_employer || null],
                ['English', meta.english_proficiency || null],
              ].filter(r => r[1])
              const skills = Array.isArray(candidateDetail.skills)
                ? candidateDetail.skills
                : String(candidateDetail.skills || '').split(',').map(s => s.trim()).filter(Boolean)
              if (rows.length === 0 && skills.length === 0) return null
              return (
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/60">
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1.5">Profile</p>
                  <div className="space-y-1">
                    {rows.map(([label, val]) => (
                      <div key={label} className="flex justify-between gap-2 text-xs">
                        <span className="text-zinc-400 dark:text-zinc-500 shrink-0">{label}</span>
                        <span className="text-zinc-700 dark:text-zinc-200 text-right break-words">{val}</span>
                      </div>
                    ))}
                  </div>
                  {skills.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {skills.slice(0, 12).map((s, i) => (
                        <span key={i} className="px-2 py-0.5 bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 rounded-full text-[10px] font-medium">{s}</span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}
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

      {/* CV Manager — opened in-place over the conversation (no navigation), so
          the agent returns to the exact same chat when they close it. */}
      {cvModalOpen && selectedId && (
        <CVReviewModal
          candidate={{ id: selectedId, name: getCandidateDisplayName(selectedCandidate) }}
          onClose={() => {
            setCvModalOpen(false)
            queryClient.invalidateQueries({ queryKey: ['candidate', selectedId] })
            queryClient.invalidateQueries({ queryKey: ['candidate-detail', selectedId] })
          }}
        />
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
