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

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSearchParams, Link } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  MessageSquare, Search, Send, Phone, Mail, Bot, User,
  UserCheck, RefreshCw, Globe, Briefcase, MapPin, Clock,
  ChevronRight, AlertCircle, Wifi, WifiOff, Loader2, Check, CheckCheck,
  Mic, Square, Trash2, Paperclip, Wand2,
  SlidersHorizontal, ChevronDown, X as XIcon,
  FileText, Download, Eye, Image as ImageIcon,
  FolderKanban, Tag, UserPlus, List, Maximize2, Megaphone,
} from 'lucide-react'
import { clsx } from 'clsx'
import { categoryColor } from '../utils/categoryColor'
import { format, formatDistanceToNow } from 'date-fns'
import { formatInterviewLong, formatInterviewDateTime } from '../utils/datetime'
import { formatHeight } from '../utils/height'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { Modal } from '../components/ui/Modal'
import { getCommunications, sendCommunication, getCandidate, getMyPreferences, updateMyPreferences } from '../api'
import { useAuthStore, useSectionAccess } from '../stores/authStore'
import { notify } from '../components/ui/Toast'
import { CampaignDialog } from '../components/communications/CampaignDialog'
import { ConversationDocumentsPanel } from '../components/communications/ConversationDocumentsPanel'
import { JobDrawer } from '../components/communications/JobDrawer'
import { CallPresenceToggle } from '../components/communications/CallPresenceToggle'
import { DispositionSelect, dispositionClasses, dispositionLabel } from '../components/communications/DispositionSelect'
import { CallRemarksPanel } from '../components/communications/CallRemarksPanel'
import { ClickToCall } from '../components/ClickToCall'
import { AddCandidateDialog } from '../components/communications/AddCandidateDialog'
import { QuickReplyPicker } from '../components/communications/QuickReplyPicker'
import toast from 'react-hot-toast'
import { CVReviewModal } from './CVManager'
import { CANDIDATE_STAGE_LABELS, CANDIDATE_STATUS_BUCKETS, CANDIDATE_MANUAL_STATUS_OPTIONS, STATUS_COLORS, normalizeStatus, getStageLabel } from '../constants/lifecycle'

// Primary status buckets the agent works through, one at a time. Bound to the
// canonical candidates.status (server-side filter) — mutually exclusive, so a
// candidate appears in exactly one bucket and drops out as it advances.
// Shared source of truth: CANDIDATE_STATUS_BUCKETS (lifecycle.js).
const STATUS_BUCKET_VALUES = new Set(CANDIDATE_STATUS_BUCKETS.map((b) => b.value))

// Persist the agent's Messages workspace (bucket / sort / every list filter) so
// navigating away and back — or refreshing — never dumps them on "all chats"
// (UPGRADES.md #3.0, "never lose your place"). localStorage gives instant
// same-device restore (read in the state initializers below, the same proven
// pattern as comms.projectId); the server copy in user_preferences syncs it
// across devices and is seeded back into localStorage on first load.
const COMMS_PREFS_KEY = 'comms.filters'
function loadCommsPrefs() {
  try { return JSON.parse(localStorage.getItem(COMMS_PREFS_KEY) || '{}') || {} }
  catch { return {} }
}

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

const getActiveChats = ({ search, statusBucket, projectId, pipelineStage, handoffState, sortBy, responseStatus, dateFrom, dateTo, disposition, contacted, claimed, claimedUserId, callStatus }) => {
  const params = new URLSearchParams()
  // No artificial cap — the list is virtualized, so the full bucket loads in one
  // scroll. Backend clamps to a safety ceiling.
  params.set('limit', '20000')
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
  if (claimedUserId) params.set('claimed_by', claimedUserId)
  if (callStatus) params.set('call_status', callStatus)
  return apiFetch(`/api/communications/active-chats?${params.toString()}`)
}

// Real aggregate counts (header pills + per-tab badges). Deliberately omits the
// status bucket — the endpoint returns every bucket's count so each tab shows
// its own total regardless of which tab is active.
const getActiveChatsCounts = ({ search, projectId, pipelineStage, handoffState, responseStatus, dateFrom, dateTo, disposition, contacted, claimed, claimedUserId, callStatus }) => {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  if (projectId) params.set('project_id', projectId)
  if (pipelineStage) params.set('pipeline_stage', pipelineStage)
  if (handoffState) params.set('handoff_state', handoffState)
  if (responseStatus) params.set('response_status', responseStatus)
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  if (disposition) params.set('disposition', disposition)
  if (contacted) params.set('contacted', contacted)
  if (claimed) params.set('claimed', claimed)
  if (claimedUserId) params.set('claimed_by', claimedUserId)
  if (callStatus) params.set('call_status', callStatus)
  return apiFetch(`/api/communications/active-chats/counts?${params.toString()}`)
}

// Active users for the admin "Claimed by <user>" filter + transfer picker.
const getActiveUsers = () =>
  apiFetch('/api/admin/users').then((r) => (Array.isArray(r) ? r : (r?.data || r?.users || []))).catch(() => [])

// Admin-only: transfer a claimed chat to another agent.
const transferCandidate = (id, toUserId) =>
  apiFetch(`/api/communications/candidate/${id}/transfer`, { method: 'POST', body: JSON.stringify({ to_user_id: toUserId }) })

// Server-side project list for the conversations filter dropdown.
const getProjectsForFilter = () =>
  apiFetch('/api/projects?limit=200').then((r) => (Array.isArray(r) ? r : (r?.data || r?.projects || [])))
// Resolve a phone number (any format: +94…/94…/0…) to a candidate id for the 3CX
// screen-pop deep-link (/communications?phoneNumber=…). apiFetch throws "404: …"
// when no candidate matches the number.
const resolveCandidateByPhone = (phone) =>
  apiFetch(`/api/communications/resolve?phone=${encodeURIComponent(phone)}`)
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
// Move a candidate to a chosen canonical stage (cascades through applications +
// re-derives candidate.status server-side). Powers the in-chat stage control.
const setCandidateStageApi = (id, stage) => apiFetch(`/api/candidates/${id}/stage`, {
  method: 'PUT',
  body: JSON.stringify({ stage }),
})

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
const unclaimCandidate = (id, reason) => apiFetch(`/api/communications/candidate/${id}/unclaim`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) })
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

// ── Outbound delivery indicator ───────────────────────────────────────────────
// WhatsApp-style ticks so the agent can SEE whether a message reached the
// candidate: ✓ sent · ✓✓ delivered · ✓✓ (blue) read · ⚠ not delivered (+reason).
// Reads metadata.delivery_status (set at send time, honest about failures) and is
// upgraded by Meta receipts via /status-sync (delivered_at / read_at).
const DELIVERY_REASON_LABEL = {
  out_of_window: 'no reply in 24h — needs a template',
  out_of_window_queued: 'queued until the candidate replies',
  no_whatsapp: 'not a WhatsApp number',
  token_expired: 'WhatsApp token expired',
  rate_limited: 'rate-limited by WhatsApp',
  no_phone: 'no phone number',
  config: 'messaging not configured',
}
function deliveryState(msg) {
  if (msg.direction === 'inbound') return null
  let meta = msg.metadata
  if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { meta = {} } }
  meta = meta || {}
  // latest_status is the AUTHORITATIVE Meta delivery receipt (via /status-sync);
  // it must win over the optimistic send-time delivery_status. Meta often ACCEPTS
  // a free-form message (returns a message id, delivery_status='sent') and then
  // FAILS final delivery when the candidate is outside the 24h window — so a
  // failed receipt must never show as a ✓.
  const latest = meta.latest_status
  if (latest === 'failed' || meta.delivery_status === 'failed') {
    return { kind: 'failed', reason: meta.delivery_reason || meta.reason || null }
  }
  if (msg.read_at || latest === 'read') return { kind: 'read' }
  if (msg.delivered_at || latest === 'delivered') return { kind: 'delivered' }
  // Parked in pending_messages (candidate outside the 24h window): delivers
  // automatically on their next reply. Receipts above win once the flush sends it.
  if (meta.delivery_status === 'queued') {
    return { kind: 'queued', reengage: !!meta.reengage_sent }
  }
  return { kind: 'sent' }
}
function DeliveryTick({ msg }) {
  const st = deliveryState(msg)
  if (!st) return null
  if (st.kind === 'failed') {
    const why = DELIVERY_REASON_LABEL[st.reason] || st.reason
      || 'WhatsApp could not deliver it — the candidate likely has not replied in 24h, so only an approved template can reach them'
    return (
      <span className="inline-flex items-center gap-0.5 text-rose-500" title={`Not delivered — ${why}`}>
        <AlertCircle size={11} /> <span className="text-[9px] font-semibold">Not delivered</span>
      </span>
    )
  }
  if (st.kind === 'queued') {
    const why = st.reengage
      ? 'Will deliver automatically when the candidate replies — a re-engagement template was sent to prompt them'
      : 'Will deliver automatically when the candidate replies'
    return (
      <span className="inline-flex items-center gap-0.5 text-amber-500" title={why}>
        <Clock size={11} /> <span className="text-[9px] font-semibold">Queued</span>
      </span>
    )
  }
  if (st.kind === 'read') return <span className="text-sky-500" title="Read"><CheckCheck size={12} /></span>
  if (st.kind === 'delivered') return <span className="text-zinc-400" title="Delivered"><CheckCheck size={12} /></span>
  return <span className="text-zinc-400" title="Sent"><Check size={12} /></span>
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
          {!isInbound && <DeliveryTick msg={msg} />}
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
  // Saved workspace prefs (localStorage), computed once. URL params win, then
  // saved prefs, then defaults — so a deep-link still overrides, but a plain
  // nav back to Messages restores the agent's last filters.
  const savedPrefsRef = useRef(undefined)
  if (savedPrefsRef.current === undefined) savedPrefsRef.current = loadCommsPrefs()
  const savedPrefs = savedPrefsRef.current
  const [selectedId, setSelectedId] = useState(null)
  // Inbound 3CX call ringing for a candidate routed to this agent (screen-pop).
  const [incomingCall, setIncomingCall] = useState(null)
  const [addCandidateOpen, setAddCandidateOpen] = useState(false)
  const [campaignOpen, setCampaignOpen] = useState(false)
  // Mass-send is a control-tower action (admin + sourcing only).
  const canCampaign = useSectionAccess('control_tower', 'edit')
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState(searchParams.get('q') || savedPrefs.search || '')
  const [pipelineStage, setPipelineStage] = useState(searchParams.get('pipeline_stage') || savedPrefs.pipelineStage || '')
  const [handoffState, setHandoffState] = useState(searchParams.get('handoff_state') || savedPrefs.handoffState || '')
  const [sortBy, setSortBy] = useState(searchParams.get('sort_by') || savedPrefs.sortBy || 'latest_desc')
  const [responseStatus, setResponseStatus] = useState(searchParams.get('response_status') || savedPrefs.responseStatus || '')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || savedPrefs.dateFrom || '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || savedPrefs.dateTo || '')
  // Primary status bucket (server-side, ca.status). Defaults to '' = "All chats"
  // so an agent sees every conversation by default (a deep-link / saved pref can
  // still pin a specific bucket).
  const [statusBucket, setStatusBucket] = useState(() => {
    const s = searchParams.get('status') ?? savedPrefs.statusBucket
    return STATUS_BUCKET_VALUES.has(s) ? s : ''
  })
  // Project scope (server-side, effective project) — remembered per agent.
  const [projectId, setProjectId] = useState(() => searchParams.get('project_id') || localStorage.getItem('comms.projectId') || '')
  const [jobFilter, setJobFilter] = useState(savedPrefs.jobFilter || '')
  const [tagFilter, setTagFilter] = useState(savedPrefs.tagFilter || '')
  // Smart-view / triage filters (Phase 2).
  const [disposition, setDispositionFilter] = useState(searchParams.get('disposition') || savedPrefs.disposition || '')
  const [contacted, setContacted] = useState(searchParams.get('contacted') || savedPrefs.contacted || '')
  const [claimed, setClaimed] = useState(searchParams.get('claimed') || savedPrefs.claimed || '')
  // Admin-only "Claimed by <user>" filter (like Mine, but for any chosen agent).
  const [claimedUserId, setClaimedUserId] = useState(searchParams.get('claimed_by') || '')
  const [callStatus, setCallStatus] = useState(searchParams.get('call_status') || savedPrefs.callStatus || '')
  // Compact mode collapses the secondary filter header (counts, project, filters)
  // so the agent sees more chats at once. Persisted per-device.
  const [compactFilters, setCompactFilters] = useState(() => {
    try { return localStorage.getItem('comms.compactFilters') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('comms.compactFilters', compactFilters ? '1' : '0') } catch { /* ignore */ }
  }, [compactFilters])
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
  const isAdmin = currentUser?.role === 'admin'
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

  // Persist the full workspace filter set: localStorage (instant, read by the
  // initializers above) + server (debounced, cross-device). Skips the server
  // write on mount so a fresh-device default blob can't clobber the saved
  // server copy before the seed effect below restores it.
  const firstPersistRef = useRef(true)
  useEffect(() => {
    const blob = {
      statusBucket, sortBy, search, pipelineStage, handoffState,
      responseStatus, disposition, contacted, claimed, callStatus,
      dateFrom, dateTo, jobFilter, tagFilter, projectId,
    }
    try { localStorage.setItem(COMMS_PREFS_KEY, JSON.stringify(blob)) } catch { /* quota — ignore */ }
    if (firstPersistRef.current) { firstPersistRef.current = false; return }
    const t = setTimeout(() => { updateMyPreferences({ communications: blob }).catch(() => {}) }, 800)
    return () => clearTimeout(t)
  }, [statusBucket, sortBy, search, pipelineStage, handoffState, responseStatus,
      disposition, contacted, claimed, callStatus, dateFrom, dateTo, jobFilter, tagFilter, projectId])

  // Cross-device restore: on first load, if THIS device has no saved filters,
  // hydrate from the server preference. Runs once; never overrides a deep-link
  // or a choice the agent makes during the session.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    if (Object.keys(savedPrefs).length > 0) return // device already has local prefs
    getMyPreferences().then((prefs) => {
      const c = prefs && prefs.communications
      if (!c || typeof c !== 'object') return
      if (STATUS_BUCKET_VALUES.has(c.statusBucket)) setStatusBucket(c.statusBucket)
      if (c.sortBy) setSortBy(c.sortBy)
      if (typeof c.search === 'string') setSearch(c.search)
      if (typeof c.pipelineStage === 'string') setPipelineStage(c.pipelineStage)
      if (typeof c.handoffState === 'string') setHandoffState(c.handoffState)
      if (typeof c.responseStatus === 'string') setResponseStatus(c.responseStatus)
      if (typeof c.disposition === 'string') setDispositionFilter(c.disposition)
      if (typeof c.contacted === 'string') setContacted(c.contacted)
      if (typeof c.claimed === 'string') setClaimed(c.claimed)
      if (typeof c.dateFrom === 'string') setDateFrom(c.dateFrom)
      if (typeof c.dateTo === 'string') setDateTo(c.dateTo)
      if (typeof c.jobFilter === 'string') setJobFilter(c.jobFilter)
      if (typeof c.tagFilter === 'string') setTagFilter(c.tagFilter)
      if (c.projectId && !projectId) setProjectId(c.projectId)
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
  // Full candidate record (metadata, skills, age, experience) for the info panel.
  // Also the fallback identity when the candidate isn't in the loaded chat list
  // (e.g. deep-linked via Applications "Open Chat" — they may be past the 500-row
  // cap or have no whatsapp thread). Without this the header rendered "Unknown".
  const { data: candidateDetailRaw } = useQuery({
    queryKey: ['candidate-detail', selectedId],
    queryFn: () => getCandidate(selectedId),
    enabled: !!selectedId,
  })
  const candidateDetail = candidateDetailRaw?.candidate || candidateDetailRaw || null

  const matchedSelected = chatList.find(c => c.candidate_id === selectedId)
  // Synthesize a chat-row shape from the full candidate record so a deep-linked
  // candidate not present in chatList still shows name/phone/stage/job.
  const detailAsRow = (candidateDetail && selectedId && String(candidateDetail.id) === String(selectedId))
    ? {
        candidate_id: selectedId,
        name: candidateDetail.name,
        phone: candidateDetail.phone,
        whatsapp_phone: candidateDetail.whatsapp_phone,
        email: candidateDetail.email,
        preferred_language: candidateDetail.preferred_language,
        notes: candidateDetail.notes,
        candidate_status: candidateDetail.status,
        conversation_stage: candidateDetail.conversation_stage,
        effective_job_title: candidateDetail.job_title || candidateDetail.latest_job_title,
        effective_project_title: candidateDetail.project_title || candidateDetail.latest_project_title,
        tags: candidateDetail.tags,
        cv_uploaded: candidateDetail.cv_uploaded,
        is_human_handoff: candidateDetail.is_human_handoff,
      }
    : null
  const selectedCandidate = matchedSelected
    || (selectedCandidateRef.current?.candidate_id === selectedId ? selectedCandidateRef.current : null)
    || detailAsRow

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { chatListRef.current = chatList }, [chatList])
  useEffect(() => { if (matchedSelected) selectedCandidateRef.current = matchedSelected }, [matchedSelected])

  // WhatsApp's 24-hour rule: a free-form (non-template) message is only
  // delivered if the candidate replied within the last 24h. If their last
  // INBOUND message is older than that (or they never replied), Meta accepts the
  // send but fails delivery — so warn the agent BEFORE they type. Derived from
  // the loaded transcript (inbound timestamps).
  const lastInboundAt = useMemo(() => {
    let max = 0
    for (const m of transcript) {
      if (m.direction === 'inbound' && m.sent_at) {
        const t = new Date(m.sent_at).getTime()
        if (t > max) max = t
      }
    }
    return max || null
  }, [transcript])
  const outOfWindow = transcript.length > 0 && (lastInboundAt === null || (Date.now() - lastInboundAt) > 24 * 60 * 60 * 1000)

  // Re-engage: (re)send the welcome message to the OPEN candidate. In-window it
  // delivers as free-form; outside it, it uses the approved welcome template
  // (TEMPLATE_WELCOME) — the only way to reopen a dormant chat. The result lands
  // in the transcript with an honest delivery tick.
  const reengageMut = useMutation({
    mutationFn: () => apiFetch(`/api/candidates/${selectedId}/send-welcome`, { method: 'POST' }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['transcript'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
      if (res?.sent) {
        toast.success('Welcome message sent')
      } else if (res?.queued) {
        toast('Welcome queued — it will deliver automatically when the candidate replies', { icon: '⏳', duration: 6000 })
      } else {
        const why = res?.reason === 'out_of_window'
          ? "candidate hasn't replied in 24h — an approved welcome template must be configured (TEMPLATE_WELCOME)"
          : res?.reason === 'no_whatsapp' ? 'not a WhatsApp number'
          : (res?.reason || 'could not be delivered')
        toast(`Welcome not delivered — ${why}`, { icon: '⚠️', duration: 8000 })
      }
    },
    onError: (e) => toast.error(e?.message || 'Failed to send welcome'),
  })

  // Re-engage: send the dedicated re-engagement nudge to the OPEN candidate.
  // In-window it's a friendly free-form check-in; outside the 24h window it's the
  // approved dewan_reengage template that prompts the candidate to reply.
  const reengageNudgeMut = useMutation({
    mutationFn: () => apiFetch(`/api/candidates/${selectedId}/reengage`, { method: 'POST' }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['transcript'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
      if (res?.sent) {
        toast.success('Re-engagement message sent')
      } else if (res?.queued) {
        toast('Re-engagement queued — it will deliver when the candidate replies', { icon: '⏳', duration: 6000 })
      } else {
        const why = res?.reason === 'no_whatsapp' ? 'not a WhatsApp number'
          : (res?.reason || 'could not be delivered')
        toast(`Re-engagement not delivered — ${why}`, { icon: '⚠️', duration: 8000 })
      }
    },
    onError: (e) => toast.error(e?.message || 'Failed to send re-engagement'),
  })

  // Client-side role/label filters — distinct options derived from the loaded
  // list. Project + status are filtered server-side (see active-chats query).
  const jobOptions = [...new Set(chatList.map(c => c.effective_job_title || c.latest_job_title).filter(Boolean))].sort()
  const tagOptions = [...new Set(chatList.flatMap(c => parseTagList(c.tags)))].sort()
  const visibleChats = chatList.filter(c =>
    (!jobFilter || (c.effective_job_title || c.latest_job_title) === jobFilter) &&
    (!tagFilter || parseTagList(c.tags).includes(tagFilter))
  )

  // Virtualize the chat list so the full bucket (potentially thousands of rows)
  // renders in one scroll without mounting every DOM node.
  const listParentRef = useRef(null)
  const rowVirtualizer = useVirtualizer({
    count: visibleChats.length,
    getScrollElement: () => listParentRef.current,
    estimateSize: () => 92,
    overscan: 12,
  })

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

  // 3CX screen-pop deep-link: /communications?phoneNumber=<caller> (also accepts
  // ?phone=). 3CX only knows the caller's number, never our candidate UUID, so it
  // cannot build a ?candidate= link. Resolve the number → open that chat → normalise
  // the URL to ?candidate= so the rest of the page behaves like any normal deep-link.
  // phoneLinkRef tracks the handled value so a fresh pop (new number, same tab) is
  // re-resolved, while in-flight/duplicate searchParams changes don't double-fire.
  const phoneLinkRef = useRef('')
  useEffect(() => {
    const phoneParam = searchParams.get('phoneNumber') || searchParams.get('phone')
    if (!phoneParam) { phoneLinkRef.current = ''; return }
    // Strip the phone params from the URL, preserving every other (possibly
    // concurrent) param. The functional updater reads the freshest params at apply
    // time — never the stale closure captured when this effect ran — so a filter
    // change during the async resolve can't be clobbered.
    const stripPhone = (mutate) => setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('phoneNumber'); next.delete('phone')
      if (mutate) mutate(next)
      return next
    }, { replace: true })
    // If a candidate is already pinned, that wins — just drop the phone param.
    if (searchParams.get('candidate')) { stripPhone(); return }
    // Resolve each distinct phone once. Sibling URL changes (filters, saved prefs)
    // re-run this effect on mount — they must NOT cancel an in-flight resolve, or
    // the deep-link gets silently dropped. So we key off the ref (not a per-run
    // cancel flag): the re-run short-circuits on the guard below, and the in-flight
    // resolve re-checks the ref at apply time so a NEWER phone supersedes an older
    // in-flight one without the older clobbering it.
    if (phoneLinkRef.current === phoneParam) return
    phoneLinkRef.current = phoneParam
    const thisPhone = phoneParam
    ;(async () => {
      try {
        const { candidate_id } = await resolveCandidateByPhone(thisPhone)
        if (phoneLinkRef.current !== thisPhone) return
        if (candidate_id) setSelectedId(candidate_id)
        stripPhone(candidate_id ? (p) => p.set('candidate', candidate_id) : undefined)
        if (!candidate_id) notify.error({ title: 'No candidate found', message: `No chat matches ${thisPhone}.` })
      } catch (err) {
        if (phoneLinkRef.current !== thisPhone) return
        stripPhone()
        const notFound = String(err?.message || '').startsWith('404')
        notify.error(notFound
          ? { title: 'No candidate found', message: `No chat matches ${thisPhone}.` }
          : { title: 'Could not open chat', message: 'Failed to look up that number.' })
      }
    })()
  }, [searchParams]) // eslint-disable-line react-hooks/exhaustive-deps

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
      // Literal wall-clock — the candidate must see the exact time the recruiter set.
      parts.push(`Your interview is scheduled for ${formatInterviewLong(interview.scheduled_datetime)}.`)
      if (interview.interview_job_title && interview.interview_job_title !== application?.job_title) {
        parts.push(`Role: ${interview.interview_job_title}.`)
      }
      if (interview.location) parts.push(`Location: ${interview.location}.`)
    }
    return parts.join('\n\n')
  }, [msgContext])

  // ── Fetch active chat list ─────────────────────────────────────────────────
  const { data: activeChatsData, isLoading: listLoading } = useQuery({
    queryKey: ['active-chats', search, statusBucket, projectId, pipelineStage, handoffState, sortBy, responseStatus, dateFrom, dateTo, disposition, contacted, claimed, claimedUserId, callStatus],
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
      claimedUserId,
      callStatus,
    }),
    // The full bucket can be thousands of rows; sockets carry real-time updates,
    // so this is only a safety-net poll. keepPreviousData (placeholderData) keeps
    // the LAST list rendered while a refilter/remount refetches — no blank panel
    // on every revisit. gcTime keeps the cache warm across navigation so coming
    // back to Messages shows instantly, then revalidates after staleTime.
    placeholderData: (prev) => prev,
    refetchInterval: 60000,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  })

  // Real aggregate counts for the header pills + per-tab badges (true totals,
  // not the capped list length). Status bucket is intentionally NOT in the key —
  // switching tabs doesn't refetch; the endpoint already returns all buckets.
  const { data: countsData } = useQuery({
    queryKey: ['active-chats-counts', search, projectId, pipelineStage, handoffState, responseStatus, dateFrom, dateTo, disposition, contacted, claimed, claimedUserId, callStatus],
    queryFn: () => getActiveChatsCounts({ search, projectId, pipelineStage, handoffState, responseStatus, dateFrom, dateTo, disposition, contacted, claimed, claimedUserId, callStatus }),
    placeholderData: (prev) => prev,
    refetchInterval: 60000,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  })
  const counts = countsData || {}
  // The list is no longer capped — it loads the full bucket and renders via the
  // virtualizer. The per-tab badges still come from the counts endpoint.

  // Admin-only: active users for the "Claimed by <user>" filter + transfer picker.
  const { data: activeUsersData } = useQuery({
    queryKey: ['active-users-for-claims'],
    queryFn: getActiveUsers,
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  })
  const activeUsers = Array.isArray(activeUsersData) ? activeUsersData : []

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

    // Lives for the socket's lifetime (the effect runs once): lets us tell the
    // first connect from a reconnect.
    let hasConnected = false
    socket.on('connect', () => {
      setConnected(true)
      // Re-join the CURRENTLY open candidate room after reconnect (selectedId is
      // captured at mount in this once-only effect, so read the live ref).
      const selId = selectedIdRef.current
      if (selId) socket.emit('join_candidate', selId)
      // On a RECONNECT (deploy, network blip, Cloud Run instance churn) any
      // events emitted while we were disconnected were missed. Resync: the chat
      // list and the open transcript. (The 30s poll heals the list eventually,
      // but the open transcript would otherwise stay stale until manual refresh.)
      if (hasConnected) {
        // Mark the (heavy) list stale WITHOUT forcing an immediate network refetch —
        // a network blip / Cloud Run churn no longer triggers the 20k-row mega-query
        // on every reconnect. Live socket events patch the list; the poll + staleTime
        // heal anything missed. The open transcript is cheap, so refetch it eagerly.
        queryClient.invalidateQueries({ queryKey: ['active-chats'], refetchType: 'none' })
        queryClient.invalidateQueries({ queryKey: ['active-chats-counts'], refetchType: 'none' })
        queryClient.invalidateQueries({ queryKey: ['transcript'] })
      }
      hasConnected = true
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

    // A candidate was "Rejected & removed" — drop them from every open list.
    socket.on('candidate_removed', ({ candidate_id }) => {
      setChatList((prev) => prev.filter((c) => c.candidate_id !== candidate_id))
      setSelectedId((cur) => (cur === candidate_id ? null : cur))
    })

    // A queued (out-of-window) message was flushed after the candidate replied:
    // upgrade the SAME bubble from "Queued" to ✓ sent (receipts then upgrade it
    // further via the transcript refetch / status-sync).
    socket.on('message_updated', (upd) => {
      setTranscript(prev => prev.map(m =>
        m.id === upd.id
          ? {
              ...m,
              whatsapp_message_id: upd.whatsapp_message_id || m.whatsapp_message_id,
              metadata: { ...(typeof m.metadata === 'object' && m.metadata ? m.metadata : {}), ...(upd.metadata || {}) },
            }
          : m
      ))
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
      // Re-derive the per-tab badge counts (status distribution changed).
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
    })

    // An application changed (created / advanced / rejected) — the candidate's
    // stage may have moved even when no candidate_stage_changed fired. Refetch
    // the list + counts so the Conversations badges stay in sync with Applications.
    socket.on('application_changed', () => {
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
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

    // A 3CX call was auto-logged for a candidate (PBX call-journaling webhook).
    // Refresh the open chat's call-log timeline + the list row's last-activity
    // and the engagement scorecards, reusing the same keys the manual flow uses.
    socket.on('call_logged', (d) => {
      if (!d?.candidate_id) return
      queryClient.invalidateQueries({ queryKey: ['call-logs', d.candidate_id] })
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['engagement'] })
    })

    // Inbound 3CX call ringing, routed to this agent — screen-pop: open the
    // candidate's chat and raise a transient banner.
    socket.on('incoming_call', (d) => {
      if (!d?.candidate_id) return
      setIncomingCall({ candidate_id: d.candidate_id, name: d.candidate_name, number: d.caller_number })
      setSelectedId(d.candidate_id)
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

  // Auto-dismiss the incoming-call banner after a short while.
  useEffect(() => {
    if (!incomingCall) return
    const t = setTimeout(() => setIncomingCall(null), 12000)
    return () => clearTimeout(t)
  }, [incomingCall])

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

  // In-chat stage control: move the candidate to any canonical stage (incl.
  // Future Pool) without leaving Messages. Optimistic patch + counts refresh.
  const stageMut = useMutation({
    mutationFn: ({ id, stage }) => setCandidateStageApi(id, stage),
    onSuccess: (_data, vars) => {
      setChatList(prev => prev.map(c => c.candidate_id === vars.id
        ? { ...c, candidate_status: vars.stage, conversation_stage: vars.stage }
        : c))
      selectedCandidateRef.current = selectedCandidateRef.current && selectedCandidateRef.current.candidate_id === vars.id
        ? { ...selectedCandidateRef.current, candidate_status: vars.stage, conversation_stage: vars.stage }
        : selectedCandidateRef.current
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
      queryClient.invalidateQueries({ queryKey: ['candidate-detail', vars.id] })
    },
    onError: (err) => { setSendError(err?.message || 'Could not change stage'); },
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
      // Claimed chats leave the default All/New lists — re-derive list + counts.
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
    },
  })
  const unclaimMut = useMutation({
    // Accepts a plain id, or { id, reason } so the release-after-interview
    // banner can record WHY the claim ended (claim_sessions.release_reason).
    mutationFn: (arg) => {
      const { id, reason } = typeof arg === 'object' && arg !== null ? arg : { id: arg }
      return unclaimCandidate(id, reason)
    },
    onSuccess: (_data, arg) => {
      const id = typeof arg === 'object' && arg !== null ? arg.id : arg
      setChatList(prev => prev.map(c => c.candidate_id === id
        ? { ...c, claimed_by: null, claimer_name: null }
        : c))
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
    },
    onError: (err) => toast.error(err?.message || 'Only an admin can release a claimed chat'),
  })
  // Admin-only: reassign a claimed chat to another agent.
  const transferMut = useMutation({
    mutationFn: ({ id, toUserId }) => transferCandidate(id, toUserId),
    onSuccess: (data, { id }) => {
      setChatList(prev => prev.map(c => c.candidate_id === id
        ? { ...c, claimed_by: data?.claimed_by, claimer_name: data?.claimer_name }
        : c))
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
      toast.success('Chat transferred')
    },
    onError: (err) => toast.error(err?.message || 'Transfer failed'),
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

      // Add sent message to transcript immediately (optimistic insert with real
      // server ID). Carry the delivery state so the bubble shows the right tick
      // (✓ sent / ⚠ not delivered) without waiting for a transcript refetch.
      const primaryCh = (result.channels && result.channels[0]) || 'whatsapp'
      const chRes = (result.channel_results && result.channel_results[primaryCh]) || {}
      const isQueued = chRes.delivery_status === 'queued'
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
        whatsapp_message_id: result.whatsapp_message_id || null,
        metadata: {
          delivery_status: isQueued ? 'queued' : (result.simulated ? 'failed' : 'sent'),
          delivery_reason: isQueued ? 'out_of_window_queued' : (result.simulated ? (chRes.reason || chRes.error || null) : null),
          reengage_sent: !!chRes.reengage_sent,
        },
        _optimistic: true,
      }
      setTranscript(prev => {
        // Avoid duplicate if WebSocket event already arrived
        if (prev.some(m => m.id === optimisticMsg.id)) return prev
        return [...prev, optimisticMsg]
      })

      // Out-of-window: the message is queued (re-engagement template sent when
      // configured) and auto-delivers on the candidate's next reply — an info
      // notice, NOT an error.
      if (isQueued) {
        toast(
          chRes.reengage_sent
            ? 'Candidate hasn\'t replied in 24h — a re-engagement template was sent and your message will deliver when they reply'
            : 'Candidate hasn\'t replied in 24h — your message is queued and will deliver when they reply',
          { icon: '⏳', duration: 6000 }
        )
      } else if (result.simulated) {
        // Warn user about any delivery failures per channel
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

      {/* Inbound 3CX call screen-pop banner */}
      {incomingCall && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-emerald-600 text-white shadow-lg ring-1 ring-emerald-700/40 animate-pulse">
          <Phone size={16} className="shrink-0" />
          <div className="text-sm">
            <span className="font-semibold">Incoming call</span>
            {incomingCall.name ? <> — {incomingCall.name}</> : null}
            {incomingCall.number ? <span className="opacity-80"> · {incomingCall.number}</span> : null}
          </div>
          <button
            type="button"
            onClick={() => setIncomingCall(null)}
            className="ml-1 rounded-full p-1 hover:bg-emerald-700/60"
            aria-label="Dismiss"
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      {/* ── Left: Chat list ─────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800/60">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-primary-700 to-indigo-600 dark:from-primary-300 dark:to-indigo-300 bg-clip-text text-transparent">
              Conversations
            </h1>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCompactFilters((v) => !v)}
                title={compactFilters ? 'Show all filters' : 'Compact filters — see more chats'}
                aria-pressed={compactFilters}
                className={clsx(
                  'inline-flex items-center justify-center rounded-lg p-1.5 transition-colors',
                  compactFilters
                    ? 'bg-primary-600 text-white hover:bg-primary-700'
                    : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                )}
              >
                {compactFilters ? <Maximize2 size={13} /> : <List size={13} />}
              </button>
              <button
                type="button"
                onClick={() => setAddCandidateOpen(true)}
                title="Add a candidate + send a welcome"
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold bg-primary-600 text-white hover:bg-primary-700 transition-colors"
              >
                <UserPlus size={12} /> Add
              </button>
              {canCampaign && (
                <button
                  type="button"
                  onClick={() => setCampaignOpen(true)}
                  title="Bulk WhatsApp campaign — message all candidates (minus excluded projects)"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                >
                  <Megaphone size={12} /> Campaign
                </button>
              )}
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
          </div>
          <AddCandidateDialog
            open={addCandidateOpen}
            onClose={() => setAddCandidateOpen(false)}
            onCreated={(cand) => { if (cand?.id) { setStatusBucket('new'); setSelectedId(cand.id) } }}
          />
          {canCampaign && (
            <CampaignDialog
              open={campaignOpen}
              onClose={() => setCampaignOpen(false)}
              projects={projectList}
            />
          )}
          {/* At-a-glance counts — TRUE aggregates from the counts endpoint (the
              old pills used chatList.length, which maxed out at the 500-row cap,
              so "500 chats / 500 bot" was just the ceiling, not the real total). */}
          {!compactFilters && (counts.total_chats > 0 || chatList.length > 0) && (() => {
            const total = counts.total_chats || 0
            const bot = counts.bot_controlled || 0
            const handoff = counts.human_controlled || 0
            const cv = counts.cv_uploaded || 0
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
            {CANDIDATE_STATUS_BUCKETS.map((b) => {
              const badge = b.value === '' ? (counts.total_chats || 0) : (counts.by_status ? (counts.by_status[b.value] || 0) : 0)
              const isActive = statusBucket === b.value
              return (
                <button
                  key={b.value || 'all'}
                  type="button"
                  onClick={() => setStatusBucket(b.value)}
                  className={clsx(
                    'px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors inline-flex items-center gap-1.5',
                    isActive
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  )}
                >
                  {b.label}
                  {badge > 0 && (
                    <span className={clsx(
                      'inline-flex items-center justify-center min-w-[18px] px-1 rounded-full text-[9px] font-bold',
                      isActive ? 'bg-white/25 text-white' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200'
                    )}>
                      {badge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {/* Project scope — server-side; one agent typically works one project. */}
          {!compactFilters && (
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
          )}
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
          {/* "Mine" — one-tap filter so an agent sees only the chats they hold.
              Admins also get a "Claimed by <user>" picker for any agent's chats.
              The two scopes are mutually exclusive. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => { setClaimedUserId(''); setClaimed(claimed === 'me' ? '' : 'me') }}
              className={clsx(
                'px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
                claimed === 'me'
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              )}
            >
              Mine
            </button>
            {isAdmin && (
              <select
                value={claimedUserId}
                onChange={(e) => { setClaimed(''); setClaimedUserId(e.target.value) }}
                className={clsx(
                  'px-2 py-1 rounded-full text-[11px] font-semibold border transition-colors',
                  claimedUserId
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700'
                )}
                title="Show chats claimed by a specific agent"
              >
                <option value="">Claimed by…</option>
                {activeUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                ))}
              </select>
            )}
          </div>
          {!compactFilters && (() => {
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
                      setClaimedUserId('')
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
          {!compactFilters && showFilters && (
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
        <div ref={listParentRef} className="flex-1 overflow-y-auto scrollbar-thin">
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
            <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const c = visibleChats[virtualRow.index]
                return (
                <div
                  key={c.candidate_id}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
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
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                  className={clsx(
                    'w-full px-4 py-3 flex items-start gap-3 text-left transition-colors cursor-pointer border-b border-zinc-100 dark:border-zinc-800/60',
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
                )
              })}
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
                    {/* Status changes live in the side profile panel (call-log
                        quick actions, which notify the candidate) — not here, to
                        avoid a silent change in the chat header. */}
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
                    {(selectedCandidate?.phone || selectedCandidate?.whatsapp_phone) && (
                      <ClickToCall phone={selectedCandidate?.phone || selectedCandidate?.whatsapp_phone} variant="icon" className="w-6 h-6" />
                    )}
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

              {/* 24h-window warning: free-form WhatsApp won't reach a candidate
                  who hasn't replied in 24h — Meta accepts then fails delivery. */}
              {outOfWindow && sendChannel !== 'email' && (
                <div className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-lg px-2.5 py-1.5 mb-2">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  <span>This candidate hasn’t replied in over 24h, so WhatsApp will <strong>not deliver</strong> a typed message (you’ll see “Not delivered”). Reaching them again needs an approved template, or wait for them to message first. Email still works if they have an address.</span>
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
                {/* Canned localized replies — appended to (never replacing) the
                    composer text, so an agent can stack a greeting + answer. */}
                <div className={clsx(!(msgContext && buildDefaultMessage()) && 'ml-auto')}>
                  <QuickReplyPicker
                    selectedCandidate={selectedCandidate}
                    onInsert={(text) => setMessage((m) => (m ? `${m}\n${text}` : text))}
                  />
                </div>
                {/* Manual sends that work in OR out of WhatsApp's 24h window
                    (out-of-window uses the approved template). Welcome = warm
                    intro / restart; Re-engage = nudge a dormant chat to reply. */}
                <button
                  type="button"
                  onClick={() => reengageMut.mutate()}
                  disabled={!selectedId || reengageMut.isPending}
                  className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300 hover:text-emerald-800 disabled:opacity-50"
                  title="Send the welcome message to this candidate (uses the approved dewan_welcome template when they're outside WhatsApp's 24h window)"
                >
                  {reengageMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  {reengageMut.isPending ? 'Sending…' : 'Send welcome'}
                </button>
                <button
                  type="button"
                  onClick={() => reengageNudgeMut.mutate()}
                  disabled={!selectedId || reengageNudgeMut.isPending}
                  className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300 hover:text-amber-800 disabled:opacity-50"
                  title="Send a re-engagement nudge to this candidate (uses the approved dewan_reengage template when they're outside WhatsApp's 24h window)"
                >
                  {reengageNudgeMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  {reengageNudgeMut.isPending ? 'Sending…' : 'Send re-engage'}
                </button>
              </div>

              {/* Job/interview context hint */}
              {msgContext?.application?.job_title && (
                <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-1.5 flex items-center gap-1">
                  <Briefcase size={10} />
                  {msgContext.application.job_title}
                  {msgContext.interview?.scheduled_datetime && (
                    <span className="ml-1 text-emerald-600">
                      · Interview {formatInterviewDateTime(msgContext.interview.scheduled_datetime, '')}
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
              {(selectedCandidate.phone || selectedCandidate.whatsapp_phone) && (
                <ClickToCall phone={selectedCandidate.phone || selectedCandidate.whatsapp_phone} variant="inline" className="ml-2" />
              )}
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
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-violet-700 dark:text-violet-300 inline-flex items-center gap-1 min-w-0">
                      <UserCheck size={12} className="shrink-0" />
                      <span className="truncate">{selectedCandidate.claimed_by === currentUser?.id ? 'Claimed by you' : `Claimed by ${selectedCandidate.claimer_name || 'an agent'}`}</span>
                    </span>
                    {/* Only admins can release a claimed chat (then transfer or release). */}
                    {isAdmin && (
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
                  {isAdmin && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-zinc-400 shrink-0">Transfer to</span>
                      <select
                        className="input text-[11px] py-1 flex-1"
                        value=""
                        onChange={(e) => { if (e.target.value) transferMut.mutate({ id: selectedId, toUserId: e.target.value }) }}
                        disabled={transferMut.isPending}
                      >
                        <option value="">Select agent…</option>
                        {activeUsers.filter((u) => u.id !== selectedCandidate.claimed_by).map((u) => (
                          <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                        ))}
                      </select>
                    </div>
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
            <CallRemarksPanel
              candidateId={selectedId}
              candidateStatus={selectedCandidate?.candidate_status}
              candidateName={selectedCandidate?.display_name || selectedCandidate?.name}
              defaultProjectId={selectedCandidate?.effective_project_id || ''}
              defaultJobId={selectedCandidate?.effective_job_id || ''}
              claimedByMe={selectedCandidate?.claimed_by === currentUser?.id}
              releasePending={unclaimMut.isPending}
              onReleaseClaim={isAdmin ? (() => unclaimMut.mutate({ id: selectedId, reason: 'interview_scheduled' })) : undefined}
              onRemoved={() => {
                // Candidate is hidden now — drop it from the list and close the chat.
                setChatList((prev) => prev.filter((c) => c.candidate_id !== selectedId))
                setSelectedId(null)
                toast.success('Candidate removed from the system')
              }}
            />
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
                ['Height', formatHeight(meta.height_cm)],
                ['Experience', (candidateDetail.experience_years || meta.experience_years) ? `${candidateDetail.experience_years || meta.experience_years} yrs` : null],
                ['Country', meta.destination_country || meta.country || null],
                ['Licenses', Array.isArray(meta.licenses) ? (meta.licenses.filter(Boolean).join(', ') || null) : (meta.licenses || null)],
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
                        <span className="text-zinc-700 dark:text-zinc-200 text-right break-words">{val && typeof val === 'object' ? (Array.isArray(val) ? val.filter(Boolean).join(', ') : JSON.stringify(val)) : val}</span>
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

          {/* Applied-role cheat-sheet — salary/country/requirements without leaving the chat (#3.2) */}
          {selectedCandidate?.effective_job_id && (
            <div className="px-3 pb-3">
              <JobDrawer jobId={selectedCandidate.effective_job_id} />
            </div>
          )}

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
