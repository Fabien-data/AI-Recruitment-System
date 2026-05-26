import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import {
  getAnalyticsOverview, getUpcomingInterviews, batchAutoAssign
} from '../api'
import {
  Users, Briefcase, FileText, FolderKanban, CalendarDays, LayoutDashboard,
  MapPin, Clock, Plus, Zap, ArrowUpRight, ArrowDownRight, ChevronRight
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import {
  BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import { motion } from 'framer-motion'
import { Card } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { twMerge } from 'tailwind-merge'
import { notify } from '../components/ui/Toast'
import InterventionAlerts from '../components/InterventionAlerts'

function AnimatedNumber({ value, duration = 800, suffix = '' }) {
  const [display, setDisplay] = useState(0)
  const startRef = useRef(null)
  const numVal = typeof value === 'string' ? parseFloat(value) : (value || 0)

  useEffect(() => {
    startRef.current = performance.now()
    const diff = numVal
    const step = (ts) => {
      const elapsed = ts - startRef.current
      const progress = Math.min(elapsed / duration, 1)
      const ease = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(diff * ease))
      if (progress < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [numVal, duration])

  return <>{display.toLocaleString()}{suffix}</>
}

// Staggered Container
const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 }
  }
}

const itemVariants = {
  hidden: { opacity: 0, y: 15 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } }
}

const KPI_TONES = {
  blue:    { tile: 'bg-brand-gradient text-white shadow-glow-blue', glow: 'hover:shadow-glow-blue' },
  red:     { tile: 'bg-accent-gradient text-white shadow-glow-red', glow: 'hover:shadow-glow-red' },
  amber:   { tile: 'bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-md', glow: '' },
  emerald: { tile: 'bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-md', glow: '' },
  purple:  { tile: 'bg-gradient-to-br from-violet-500 to-purple-700 text-white shadow-md', glow: '' },
}

function KPICard({ name, value, icon, change, changeType, isLoading, suffix = '', tone = 'blue' }) {
  const isPositive = changeType === 'positive'
  const isWarning = changeType === 'warning'
  const t = KPI_TONES[tone] || KPI_TONES.blue

  return (
    <Card className={twMerge('group p-6 flex min-h-[10rem] flex-col justify-between gap-4 transition-shadow', t.glow)}>
      <div className="flex items-center justify-between mb-2">
        <div className={twMerge('p-2.5 rounded-2xl transition-transform group-hover:scale-105', t.tile)}>
          {icon}
        </div>
        {change && (
          <span className={twMerge(
            'flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-xl shadow-sm border',
            isPositive ? 'text-emerald-700 bg-emerald-50 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50' :
            isWarning  ? 'text-amber-700 bg-amber-50 border-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50' :
                         'text-zinc-600 bg-zinc-50 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700'
          )}>
            {isPositive && <ArrowUpRight strokeWidth={3} size={12} />}
            {!isPositive && !isWarning && <ArrowDownRight strokeWidth={3} size={12} />}
            {change}
          </span>
        )}
      </div>
      <div>
        {isLoading ? (
          <div className="skeleton h-8 w-24 mb-1" />
        ) : (
          <p className="text-3xl font-bold text-zinc-900 dark:text-zinc-50 tracking-tight">
            <AnimatedNumber value={typeof value === 'number' ? value : parseFloat(value) || 0} suffix={suffix} />
          </p>
        )}
        <p className="mt-1 text-sm font-medium leading-snug text-zinc-500 dark:text-zinc-400">{name}</p>
      </div>
    </Card>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()

  const formatChangeTag = (value) => {
    if (value == null) return null
    const num = Number(value)
    if (Number.isNaN(num)) return null
    return `${num >= 0 ? '+' : ''}${num}%`
  }
  
  const { data: analytics, isLoading: isAnalyticsLoading } = useQuery({
    queryKey: ['analytics-overview'],
    queryFn: () => getAnalyticsOverview({ period: 30 })
  })

  const stats = analytics?.stats || {
    totalApplications: 0,
    totalJobs: 0,
    activeInterviews: 0,
    totalCandidates: 0
  }

  const { data: interviews, isLoading: isInterviewsLoading } = useQuery({
    queryKey: ['upcoming-interviews'],
    queryFn: async () => (await getUpcomingInterviews()).slice(0, 4)
  })

  const urgentProjects = analytics?.urgent_projects || []
  const interviewCalendar = analytics?.interview_calendar || []

  const [isAssigning, setIsAssigning] = useState(false)
  const handleAutoAssign = async () => {
    setIsAssigning(true)
    try {
      const res = await batchAutoAssign()
      notify.success({
        title: 'Magic Assigned!',
        message: `Matched ${res.data.matches_found} candidates perfectly.`,
      })
    } catch (err) {
      notify.error('Auto-assign failed')
    } finally {
      setIsAssigning(false)
    }
  }

  const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']
  const pipelineData = (analytics?.pipeline || []).map(stage => ({
    name: stage.name,
    value: Number(stage.count) || 0,
    status: stage.status
  }))

  return (
    <motion.div 
      className="space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={itemVariants}>
        <PageHeader
          icon={LayoutDashboard}
          tone="blue"
          title="Recruitment Hub"
          subtitle="Your AI-powered overview of all active hiring pipelines."
          actions={
            <>
              <Button variant="secondary" onClick={handleAutoAssign} loading={isAssigning}>
                {!isAssigning && <Zap size={16} className="text-amber-500" />}
                Auto-Match Candidates
              </Button>
              <Button onClick={() => navigate('/jobs/new')}>
                <Plus size={16} /> New Job
              </Button>
            </>
          }
        />
      </motion.div>

      <motion.div variants={itemVariants}>
        <InterventionAlerts />
      </motion.div>

      {/* Primary KPI Bento Row */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          name="Total Applications"
          value={stats.totalApplications}
          icon={<FileText size={20} />}
          change={formatChangeTag(analytics?.applications?.change_pct)}
          changeType={(analytics?.applications?.change_pct || 0) >= 0 ? 'positive' : 'neutral'}
          isLoading={isAnalyticsLoading}
          tone="blue"
        />
        <KPICard
          name="Active Candidates"
          value={stats.totalCandidates}
          icon={<Users size={20} />}
          change={formatChangeTag(analytics?.unique_candidates?.change_pct)}
          changeType={(analytics?.unique_candidates?.change_pct || 0) >= 0 ? 'positive' : 'neutral'}
          isLoading={isAnalyticsLoading}
          tone="emerald"
        />
        <KPICard
          name="Open Roles"
          value={stats.totalJobs}
          icon={<Briefcase size={20} />}
          change={null}
          changeType="neutral"
          isLoading={isAnalyticsLoading}
          tone="red"
        />
        <KPICard
          name="Interviews Today"
          value={stats.activeInterviews}
          icon={<CalendarDays size={20} />}
          change={formatChangeTag(analytics?.conversion_rate?.change_pct)}
          changeType={(analytics?.conversion_rate?.change_pct || 0) >= 0 ? 'positive' : 'neutral'}
          isLoading={isAnalyticsLoading}
          tone="purple"
        />
      </motion.div>

      {/* Main Bento Grid */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Pipeline Chart - Takes up 2 cols */}
        <Card accent="blue" className="relative flex flex-col p-6 lg:col-span-2 overflow-hidden">
          <div className="flex justify-between items-center mb-6 z-10">
            <div>
              <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-50">Pipeline Conversion</h2>
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Candidate drop-off across stages</p>
            </div>
            <Button variant="ghost" size="sm">Report <ChevronRight size={14} /></Button>
          </div>
          <div className="z-10 min-h-[280px] flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pipelineData} margin={{ top: 12, right: 16, left: 12, bottom: 0 }} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--chart-grid)" />
                <XAxis type="number" hide />
                <YAxis
                  dataKey="name"
                  type="category"
                  width={112}
                  tickMargin={10}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'var(--chart-text)', fontSize: 13, fontWeight: 500 }}
                />
                <Tooltip
                  cursor={{ fill: 'var(--chart-grid)', fillOpacity: 0.5 }}
                  contentStyle={{
                    borderRadius: '16px',
                    border: 'none',
                    boxShadow: 'var(--chart-tooltip-shadow)',
                    background: 'var(--chart-tooltip-bg)',
                    color: 'var(--chart-text)',
                  }}
                />
                <Bar dataKey="value" radius={[0, 12, 12, 0]} barSize={28}>
                  {pipelineData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 bg-primary-200/40 dark:bg-primary-900/20 rounded-full blur-3xl opacity-60 pointer-events-none" />
        </Card>

        {/* Upcoming Interviews - 1 col */}
        <Card accent="red" className="p-6 flex flex-col">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-50">Upcoming</h2>
            <Badge status="interview" className="pointer-events-none">Today</Badge>
          </div>

          <div className="flex-1 flex flex-col gap-3">
            {isInterviewsLoading ? (
              [...Array(4)].map((_, i) => (
                <div key={i} className="skeleton h-16 rounded-2xl w-full" />
              ))
            ) : (!interviews || interviews.length === 0) ? (
              <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500">
                <CalendarDays size={32} className="mb-2 opacity-50" />
                <p className="text-sm font-medium">No upcoming interviews</p>
              </div>
            ) : (
              interviews.map((intv) => (
                <div key={intv.id} className="group p-3 border border-zinc-100 dark:border-zinc-800 rounded-2xl hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors cursor-pointer flex gap-3 items-center">
                  <div className="w-10 h-10 rounded-xl bg-brand-gradient text-white flex items-center justify-center flex-shrink-0 font-bold shadow-glow-blue">
                    {intv.candidate_name?.charAt(0) || 'C'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate tracking-tight">{intv.candidate_name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate flex items-center gap-1 mt-0.5">
                      <Clock size={12} />
                      {new Date(intv.scheduled_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <ChevronRight size={16} className="text-zinc-300 dark:text-zinc-600 group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors" />
                </div>
              ))
            )}
          </div>
        </Card>

      </motion.div>

      <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card accent="red" className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-50">Urgent Projects</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate('/projects')}>Open <ChevronRight size={14} /></Button>
          </div>
          <div className="space-y-3">
            {urgentProjects.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No urgent projects right now.</p>
            ) : (
              urgentProjects.map((project) => (
                <div key={project.id} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3 hover:border-accent-200 dark:hover:border-accent-800 transition-colors">
                  <p className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">{project.title}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{project.client_name}</p>
                  <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400 flex items-center gap-3">
                    <span>{project.total_jobs || 0} jobs</span>
                    <span>{project.total_applications || 0} applications</span>
                    {project.interview_date && <span>Interview: {new Date(project.interview_date).toLocaleDateString()}</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card accent="blue" className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-50">Interview Calendar</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate('/interviews')}>Open <ChevronRight size={14} /></Button>
          </div>
          <div className="space-y-3 max-h-72 overflow-auto pr-1 custom-scrollbar">
            {interviewCalendar.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No interview events in the next 30 days.</p>
            ) : (
              interviewCalendar.slice(0, 8).map((event) => (
                <div key={event.id} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3 hover:border-primary-200 dark:hover:border-primary-800 transition-colors">
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{event.candidate_name} • {event.job_title}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{event.project_title || 'Unassigned project'}</p>
                  <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400 flex flex-wrap items-center gap-3">
                    <span className="flex items-center gap-1"><Clock size={12} />{new Date(event.scheduled_datetime).toLocaleString()}</span>
                    <span className="flex items-center gap-1"><MapPin size={12} />{event.location || 'TBD'}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </motion.div>
    </motion.div>
  )
}
