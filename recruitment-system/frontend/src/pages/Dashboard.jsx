import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import {
  getJobs, getCandidates, getApplications, getProjects,
  getAnalyticsOverview, getUpcomingInterviews, batchAutoAssign
} from '../api'
import {
  Users, Briefcase, FileText, TrendingUp, FolderKanban, CalendarDays,
  MapPin, Clock, Plus, Zap, BarChart3, ArrowUpRight, ArrowDownRight,
  Loader2, ChevronRight
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import toast from 'react-hot-toast'
import { motion } from 'framer-motion'
import { Card } from '../components/ui/Card'
import { twMerge } from 'tailwind-merge'

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

function KPICard({ name, value, icon, change, changeType, isLoading, suffix = '', bgClass = 'bg-white', iconColor = 'text-indigo-600' }) {
  const isPositive = changeType === 'positive'
  const isWarning = changeType === 'warning'

  return (
    <Card className={twMerge("p-6 flex flex-col justify-between h-40", bgClass)}>
      <div className="flex items-center justify-between mb-2">
        <div className={twMerge("p-2.5 rounded-2xl bg-zinc-100 shadow-sm", iconColor)}>
          {icon}
        </div>
        {change && (
          <span className={twMerge(
            "flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-xl shadow-sm border",
            isPositive ? "text-emerald-700 bg-emerald-50 border-emerald-100" :
            isWarning  ? "text-amber-700 bg-amber-50 border-amber-100" :
                         "text-zinc-600 bg-zinc-50 border-zinc-200"
          )}>
            {isPositive && <ArrowUpRight strokeWidth={3} size={12} />}
            {!isPositive && !isWarning && <ArrowDownRight strokeWidth={3} size={12} />}
            {change}
          </span>
        )}
      </div>
      <div>
        {isLoading ? (
          <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-200 mb-1" />
        ) : (
          <p className="text-3xl font-bold text-zinc-900 tracking-tight">
            <AnimatedNumber value={typeof value === 'number' ? value : parseFloat(value) || 0} suffix={suffix} />
          </p>
        )}
        <p className="text-sm font-medium text-zinc-500 mt-1">{name}</p>
      </div>
    </Card>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  
  const { data: analytics, isLoading: isAnalyticsLoading } = useQuery({
    queryKey: ['analytics-overview'],
    queryFn: async () => {
      const res = await getAnalyticsOverview()
      return res.data
    }
  })

  // Basic mock if no data to showcase Bento structure nicely
  const stats = analytics?.stats || {
    totalApplications: 1245,
    totalJobs: 12,
    activeInterviews: 24,
    totalCandidates: 8530
  }

  const { data: interviews, isLoading: isInterviewsLoading } = useQuery({
    queryKey: ['upcoming-interviews'],
    queryFn: async () => {
      const res = await getUpcomingInterviews()
      return res.data.slice(0, 4)
    }
  })

  const [isAssigning, setIsAssigning] = useState(false)
  const handleAutoAssign = async () => {
    setIsAssigning(true)
    try {
      const res = await batchAutoAssign()
      toast.custom(
        (t) => (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="bg-zinc-900 text-white p-4 rounded-2xl shadow-2xl flex items-center gap-3"
          >
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <Zap size={18} />
            </div>
            <div>
              <p className="font-semibold text-sm">Magic Assigned!</p>
              <p className="text-xs text-zinc-400">Matched {res.data.matches_found} candidates perfectly.</p>
            </div>
          </motion.div>
        ), { duration: 3000 }
      )
    } catch (err) {
      toast.error('Auto-assign failed')
    } finally {
      setIsAssigning(false)
    }
  }

  const COLORS = ['#6366f1', '#a855f7', '#ec4899', '#14b8a6', '#f59e0b']
  // Mock Pipeline
  const pipelineData = [
    { name: 'Applied', value: 400 },
    { name: 'Screening', value: 250 },
    { name: 'Interview', value: 120 },
    { name: 'Offer', value: 40 },
    { name: 'Hired', value: 25 }
  ]

  return (
    <motion.div 
      className="space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={itemVariants} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-2 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-zinc-900 tracking-tight">Recruitment Hub</h1>
          <p className="text-zinc-500 text-sm mt-1 font-medium">Your AI-powered overview of all active hiring pipelines.</p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={handleAutoAssign} loading={isAssigning} className="shadow-sm">
            {!isAssigning && <Zap size={16} className="text-amber-500" />}
            Auto-Match Candidates
          </Button>
          <Button onClick={() => navigate('/jobs/new')} className="shadow-md">
            <Plus size={16} /> New Job
          </Button>
        </div>
      </motion.div>

      {/* Primary KPI Bento Row */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard 
          name="Total Applications" 
          value={stats.totalApplications} 
          icon={<FileText size={20} />} 
          change="+18%" changeType="positive"
          isLoading={isAnalyticsLoading}
          iconColor="text-indigo-600 bg-indigo-50"
        />
        <KPICard 
          name="Active Candidates" 
          value={stats.totalCandidates} 
          icon={<Users size={20} />} 
          change="+5%" changeType="positive"
          isLoading={isAnalyticsLoading}
          iconColor="text-emerald-600 bg-emerald-50"
        />
        <KPICard 
          name="Open Roles" 
          value={stats.totalJobs} 
          icon={<Briefcase size={20} />} 
          change="-2" changeType="warning"
          isLoading={isAnalyticsLoading}
          iconColor="text-amber-600 bg-amber-50"
        />
        <KPICard 
          name="Interviews Today" 
          value={stats.activeInterviews} 
          icon={<CalendarDays size={20} />} 
          change="Urgent" changeType="neutral"
          isLoading={isAnalyticsLoading}
          iconColor="text-purple-600 bg-purple-50"
        />
      </motion.div>

      {/* Main Bento Grid */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Pipeline Chart - Takes up 2 cols */}
        <Card className="p-6 lg:col-span-2 flex flex-col relative overflow-hidden bg-white">
          <div className="flex justify-between items-center mb-6 z-10">
            <div>
              <h2 className="text-lg font-bold text-zinc-900">Pipeline Conversion</h2>
              <p className="text-sm font-medium text-zinc-500">Candidate drop-off across stages</p>
            </div>
            <Button variant="ghost" size="sm">Report <ChevronRight size={14} /></Button>
          </div>
          <div className="flex-1 min-h-[250px] z-10">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pipelineData} margin={{ top: 20, right: 0, left: -20, bottom: 0 }} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#E4E4E7" />
                <XAxis type="number" hide />
                <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{fill: '#71717A', fontSize: 13, fontWeight: 500}} />
                <Tooltip cursor={{fill: '#F4F4F5'}} contentStyle={{borderRadius: '16px', border: 'none', boxShadow: '0 8px 30px rgba(0,0,0,0.08)'}} />
                <Bar dataKey="value" radius={[0, 12, 12, 0]} barSize={28}>
                  {pipelineData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Subtle decoration */}
          <div className="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 bg-indigo-50 rounded-full blur-3xl opacity-50 pointer-events-none" />
        </Card>

        {/* Upcoming Interviews - 1 col */}
        <Card className="p-6 flex flex-col bg-white">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-bold text-zinc-900">Upcoming</h2>
            <Badge variant="interview" className="bg-purple-100 text-purple-700 pointer-events-none">Today</Badge>
          </div>
          
          <div className="flex-1 flex flex-col gap-3">
            {isInterviewsLoading ? (
              [...Array(4)].map((_, i) => (
                <div key={i} className="animate-pulse bg-zinc-100 h-16 rounded-2xl w-full" />
              ))
            ) : (!interviews || interviews.length === 0) ? (
               <div className="flex-1 flex flex-col items-center justify-center text-zinc-400">
                 <CalendarDays size={32} className="mb-2 opacity-50" />
                 <p className="text-sm font-medium">No upcoming interviews</p>
               </div>
            ) : (
              interviews.map((intv) => (
                <div key={intv.id} className="group p-3 border border-zinc-100 rounded-2xl hover:bg-zinc-50 transition-colors cursor-pointer flex gap-3 items-center">
                  <div className="w-10 h-10 rounded-xl bg-zinc-900 text-white flex items-center justify-center flex-shrink-0 font-bold shadow-sm">
                    {intv.candidate?.name?.charAt(0) || 'C'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-zinc-900 truncate tracking-tight">{intv.candidate?.name}</p>
                    <p className="text-xs text-zinc-500 truncate flex items-center gap-1 mt-0.5">
                      <Clock size={12} />
                      {new Date(intv.scheduled_time).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' })}
                    </p>
                  </div>
                  <ChevronRight size={16} className="text-zinc-300 group-hover:text-zinc-900 transition-colors" />
                </div>
              ))
            )}
          </div>
        </Card>

      </motion.div>
    </motion.div>
  )
}
