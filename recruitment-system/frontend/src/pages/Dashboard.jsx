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
  FunnelChart, Funnel, LabelList,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts'
import toast from 'react-hot-toast'

// â”€â”€â”€ AnimatedNumber â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ KPI Card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function KPICard({ name, value, icon, change, changeType, isLoading, suffix = '' }) {
  const isPositive = changeType === 'positive'
  const isWarning = changeType === 'warning'

  return (
    <div className="card hover:scale-[1.01] hover:shadow-lg transition-all duration-200">
      <div className="flex items-center justify-between mb-3">
        <div className="p-2.5 bg-blue-50 rounded-xl">{icon}</div>
        {change && (
          <span className={`flex items-center gap-0.5 text-xs font-medium px-2 py-1 rounded-full ${
            isPositive ? 'text-green-700 bg-green-50' :
            isWarning  ? 'text-orange-700 bg-orange-50' :
                         'text-gray-600 bg-gray-50'
          }`}>
            {isPositive && <ArrowUpRight size={12} />}
            {!isPositive && !isWarning && <ArrowDownRight size={12} />}
            {change}
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="h-8 w-20 animate-pulse rounded bg-gray-200 mb-1" />
      ) : (
        <p className="text-3xl font-bold text-gray-900">
          <AnimatedNumber value={typeof value === 'number' ? value : parseFloat(value) || 0} suffix={suffix} />
        </p>
      )}
      <p className="text-sm text-gray-500 mt-0.5">{name}</p>
    </div>
  )
}

// â”€â”€â”€ Custom Pipeline Visualization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CustomPipeline({ data }) {
  const max = Math.max(...data.map(d => d.value), 1)

  return (
    <div className="flex flex-col justify-center gap-3 h-[210px] w-full px-2 stagger">
      {data.map((step, idx) => {
        const percentage = Math.max((step.value / max) * 100, 1.5)
        return (
          <div key={step.name} className="relative group flex items-center w-full mt-1">
            {/* Step Label */}
            <div className="w-24 text-right pr-3 text-xs font-semibold text-gray-500 group-hover:text-blue-600 transition-colors">
              {step.name}
            </div>
            
            {/* Bar */}
            <div className="flex-1 flex items-center h-8 bg-gray-50 rounded-full overflow-hidden relative border border-gray-100 shadow-sm" style={{ backgroundColor: '#f8fafc' }}>
              <div 
                className="h-full rounded-full transition-all duration-1000 ease-out relative group-hover:brightness-110 shadow-md transform origin-left"
                style={{ width: `${percentage}%`, backgroundColor: step.fill, animation: `scaleX 1.5s ease-out forwards ${idx * 0.1}s` }}
              >
                {/* Gloss / highlight effect */}
                <div className="absolute inset-0 bg-gradient-to-b from-white/20 to-transparent" />
                <div className="absolute inset-0 opacity-0 group-hover:opacity-20 bg-white transition-opacity duration-300" />
              </div>
            </div>

            {/* Value Badge */}
            <div className="w-14 pl-3">
              <span className="inline-flex items-center justify-center px-2.5 py-1 text-xs font-bold bg-white text-gray-700 rounded-full border border-gray-200 shadow-sm group-hover:bg-blue-600 group-hover:text-white group-hover:border-blue-600 transition-all duration-300">
                {step.value}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// â”€â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function Dashboard() {
  const navigate = useNavigate()
  const [batchLoading, setBatchLoading] = useState(false)

  const { data: jobs, isLoading: jobsLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => getJobs({ status: 'active' })
  })
  const { data: candidatesData, isLoading: candidatesLoading } = useQuery({
    queryKey: ['candidates', { page: 1 }],
    queryFn: () => getCandidates({ page: 1, limit: 100 })
  })
  const { data: applications, isLoading: applicationsLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: getApplications
  })
  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ['projects', { limit: 10 }],
    queryFn: () => getProjects({ limit: 10 })
  })
  const { data: analyticsData } = useQuery({
    queryKey: ['analytics-overview', 30],
    queryFn: () => getAnalyticsOverview({ period: 30 })
  })
  const { data: upcomingInterviews = [] } = useQuery({
    queryKey: ['upcoming-interviews'],
    queryFn: getUpcomingInterviews
  })

  const isLoading = jobsLoading || candidatesLoading || applicationsLoading
  const jobsList = jobs?.data || []
  const candidatesList = candidatesData?.data || []
  const applicationsList = Array.isArray(applications) ? applications : []
  const projectsList = projectsData?.data || []

  const activeProjects = projectsList.filter(p => p.status === 'active' || p.status === 'planning')
  const urgentProjects = projectsList.filter(p => p.priority === 'urgent' || p.priority === 'high')
  const convRate = analyticsData?.conversion_rate?.value
  const appChange = analyticsData?.applications?.change_pct
  const candChange = analyticsData?.unique_candidates?.change_pct
  const fmtChange = (pct) => pct != null ? `${pct >= 0 ? '+' : ''}${pct}%` : null

  const todayStr = new Date().toDateString()
  const todayInterviews = upcomingInterviews.filter(i => new Date(i.scheduled_at).toDateString() === todayStr)

  // Pipeline funnel
  const funnelData = [
    { name: 'New',        value: applicationsList.filter(a => ['new','applied','auto_assigned'].includes(a.status)).length || candidatesList.filter(c => c.status==='new').length, fill: '#1e3a8a' },
    { name: 'Screening',  value: applicationsList.filter(a => ['screening','reviewing'].includes(a.status)).length, fill: '#1d4ed8' },
    { name: 'Certified',  value: applicationsList.filter(a => a.status==='certified').length, fill: '#2563eb' },
    { name: 'Interview',  value: applicationsList.filter(a => a.status==='interview_scheduled').length, fill: '#3b82f6' },
    { name: 'Selected',   value: applicationsList.filter(a => ['selected','hired'].includes(a.status)).length, fill: '#60a5fa' },
  ]

  // Source distribution
  const sourceCounts = candidatesList.reduce((acc, c) => { acc[c.source||'other'] = (acc[c.source||'other']||0)+1; return acc }, {})
  const sourceData = [
    { name: 'WhatsApp', value: sourceCounts.whatsapp||0, color: '#25D366' },
    { name: 'Email',    value: sourceCounts.email||0, color: '#3b82f6' },
    { name: 'Walk-in',  value: sourceCounts.walkin||0, color: '#8b5cf6' },
    { name: 'Web',      value: sourceCounts.web||0, color: '#f59e0b' },
    { name: 'Other',    value: sourceCounts.other||0, color: '#94a3b8' },
  ].filter(d => d.value > 0)

  // Hiring trend (last 6 months)
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - (5 - i))
    return { key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label: d.toLocaleDateString('en-US',{month:'short'}) }
  })
  const trendData = months.map(m => ({
    month: m.label,
    Applications: applicationsList.filter(a => (a.applied_at||a.created_at||'').startsWith(m.key)).length,
    Hired: applicationsList.filter(a => ['hired','selected'].includes(a.status) && (a.updated_at||'').startsWith(m.key)).length,
  }))

  // Top jobs by applications
  const jobAppCounts = applicationsList.reduce((acc,a) => { acc[a.job_id]=(acc[a.job_id]||0)+1; return acc }, {})
  const topJobs = jobsList
    .map(j => ({ name: j.title?.length > 22 ? j.title.slice(0,22)+'â€¦' : (j.title||''), apps: jobAppCounts[j.id]||0 }))
    .sort((a,b) => b.apps - a.apps).slice(0,5)

  const handleBatchAutoAssign = async () => {
    setBatchLoading(true)
    try {
      const data = await batchAutoAssign(50, 'new')
      toast.success(`Auto-assigned ${data.assigned} candidates, ${data.to_pool} to pool`)
    } catch {
      toast.error('Batch auto-assign failed')
    } finally {
      setBatchLoading(false)
    }
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 mt-1">Welcome back â€” here&apos;s your recruitment overview.</p>
      </div>

      {/* Row 1: KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-5 mb-8 stagger">
        <KPICard name="Active Projects" value={activeProjects.length} icon={<FolderKanban className="text-blue-600" size={20}/>} change={urgentProjects.length>0?`${urgentProjects.length} urgent`:null} changeType={urgentProjects.length>0?'warning':'neutral'} isLoading={projectsLoading} />
        <KPICard name="Active Jobs" value={jobsList.length} icon={<Briefcase className="text-blue-600" size={20}/>} change={fmtChange(appChange)||'+12%'} changeType="positive" isLoading={jobsLoading} />
        <KPICard name="Total Candidates" value={candidatesData?.pagination?.total||candidatesList.length} icon={<Users className="text-blue-600" size={20}/>} change={fmtChange(candChange)||'+8%'} changeType="positive" isLoading={candidatesLoading} />
        <KPICard name="Applications" value={applicationsList.length} icon={<FileText className="text-blue-600" size={20}/>} change={fmtChange(appChange)||'+23%'} changeType="positive" isLoading={applicationsLoading} />
        <KPICard name="Conversion Rate" value={convRate||0} suffix="%" icon={<TrendingUp className="text-blue-600" size={20}/>} change={fmtChange(analyticsData?.conversion_rate?.change_pct)} changeType="positive" />
      </div>

      {/* Row 2: Pipeline Funnel + Source Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-6">
        <div className="card lg:col-span-3 hover:shadow-lg transition-shadow duration-300">
          <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span className="w-1.5 h-6 bg-blue-600 rounded-full"></span>
            Recruitment Pipeline
          </h2>
          {isLoading ? <div className="h-48 animate-pulse rounded bg-gray-100" /> : (
            <CustomPipeline data={funnelData} />
          )}
        </div>
        <div className="card lg:col-span-2 hover:shadow-lg transition-shadow duration-300">
          <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span className="w-1.5 h-6 bg-purple-500 rounded-full"></span>
            Candidate Sources
          </h2>
          {sourceData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-gray-400">No source data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie data={sourceData} cx="50%" cy="50%" innerRadius={60} outerRadius={85} dataKey="value" paddingAngle={4} stroke="none">
                  {sourceData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)' }}
                  itemStyle={{ color: '#1f2937', fontWeight: 600 }}
                />
                <Legend iconType="circle" iconSize={10} wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Row 3: Hiring Trend */}
      <div className="card mb-6 hover:shadow-lg transition-shadow duration-300">
        <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-1.5 h-6 bg-green-500 rounded-full"></span>
          Hiring Trend â€” Last 6 Months
        </h2>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={trendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="gradApps" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="gradHired" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="month" tick={{fontSize:12,fill:'#64748b'}} axisLine={false} tickLine={false} dy={10} />
            <YAxis tick={{fontSize:12,fill:'#64748b'}} allowDecimals={false} axisLine={false} tickLine={false} />
            <Tooltip 
              contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)' }}
            />
            <Legend wrapperStyle={{ paddingTop: '20px', fontSize: '12px' }} iconType="circle" iconSize={8} />
            <Area type="monotone" dataKey="Applications" stroke="#3b82f6" strokeWidth={3} fill="url(#gradApps)" activeDot={{ r: 6, strokeWidth: 0 }} animationDuration={1500} />
            <Area type="monotone" dataKey="Hired" stroke="#22c55e" strokeWidth={3} fill="url(#gradHired)" activeDot={{ r: 6, strokeWidth: 0 }} animationDuration={1500} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Row 4: Top Jobs + Upcoming Interviews */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-6">
        <div className="card lg:col-span-3 hover:shadow-lg transition-shadow duration-300">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <span className="w-1.5 h-6 bg-orange-400 rounded-full"></span>
              Top Jobs by Applications
            </h2>
            <Link to="/jobs" className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-0.5 font-medium transition-transform hover:translate-x-1">View all <ChevronRight size={14}/></Link>
          </div>
          {isLoading ? <div className="h-48 animate-pulse rounded bg-gray-100"/> : topJobs.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-gray-400">No jobs data</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={topJobs} layout="vertical" margin={{left: 0, right: 20, top: 0, bottom: 0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:12,fill:'#64748b'}} allowDecimals={false} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{fontSize:11,fill:'#475569'}} width={130} axisLine={false} tickLine={false} />
                <Tooltip 
                  cursor={{fill: '#f8fafc'}}
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)' }}
                />
                <Bar dataKey="apps" name="Applications" fill="#3b82f6" radius={[0,6,6,0]} animationDuration={1500}>
                  {topJobs.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={index === 0 ? '#2563eb' : index === 1 ? '#3b82f6' : '#60a5fa'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="card lg:col-span-2 hover:shadow-lg transition-shadow duration-300">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <span className="w-1.5 h-6 bg-pink-500 rounded-full"></span>
              Today&apos;s Interviews
            </h2>
            <Link to="/interviews" className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-0.5 font-medium transition-transform hover:translate-x-1">All <ChevronRight size={14}/></Link>
          </div>
          {todayInterviews.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400">
              <CalendarDays size={32} className="mb-2 opacity-30"/>
              <p className="text-sm">No interviews today</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-52 overflow-y-auto">
              {todayInterviews.slice(0,6).map(iv => (
                <div key={iv.id} className="flex items-start gap-2 p-2.5 bg-blue-50/60 rounded-xl">
                  <div className="text-blue-600 mt-0.5"><CalendarDays size={13}/></div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 text-sm truncate">{iv.candidate_name}</p>
                    <p className="text-xs text-gray-500 truncate">{iv.job_title}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                      <span className="flex items-center gap-0.5"><Clock size={10}/>{new Date(iv.scheduled_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</span>
                      {iv.location && <span className="flex items-center gap-0.5"><MapPin size={10}/>{iv.location}</span>}
                    </div>
                  </div>
                  <Badge status={iv.status}/>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Row 5: Quick Actions */}
      <div className="card">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onClick={() => navigate('/candidates')} className="flex items-center gap-2">
            <Plus size={16}/> Add Candidate
          </Button>
          <Button variant="primary" onClick={() => navigate('/jobs')} className="flex items-center gap-2 bg-blue-700 hover:bg-blue-800">
            <Briefcase size={16}/> Add Job
          </Button>
          <Button variant="secondary" onClick={handleBatchAutoAssign} disabled={batchLoading} className="flex items-center gap-2">
            {batchLoading ? <><Loader2 size={16} className="animate-spin"/> Processing...</> : <><Zap size={16}/> Batch Auto-Assign</>}
          </Button>
          <Button variant="secondary" onClick={() => navigate('/analytics')} className="flex items-center gap-2">
            <BarChart3 size={16}/> View Analytics
          </Button>
        </div>
      </div>
    </div>
  )
}
