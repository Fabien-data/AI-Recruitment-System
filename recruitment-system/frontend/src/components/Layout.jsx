import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore, useRole } from '../stores/authStore'
import {
  LayoutDashboard, Users, Briefcase, FileText, MessageSquare, LogOut, Menu, X, Bell,
  FileSearch, Database, FolderKanban, CalendarDays, BarChart2, BookOpen, ShieldCheck, Megaphone,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { twMerge } from 'tailwind-merge'
import { ThemeToggle } from './ui/ThemeToggle'
import { TopProgressBar } from './ui/TopProgressBar'
import { Logo } from './ui/Logo'

const BASE_NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/candidates', label: 'Candidates', icon: Users },
  { to: '/jobs', label: 'Jobs', icon: Briefcase },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/applications', label: 'Applications', icon: FileText },
  { to: '/interviews', label: 'Interviews', icon: CalendarDays },
]

const FULL_NAV_EXTRAS = [
  { to: '/cv-manager', label: 'CV Manager', icon: FileSearch },
  { to: '/communications', label: 'Messages', icon: MessageSquare },
  { to: '/analytics', label: 'Analytics', icon: BarChart2 },
  { to: '/knowledge-base', label: 'Knowledge Base', icon: BookOpen },
  { to: '/general-pool', label: 'General Pool', icon: Database },
]

function buildNav(role) {
  if (role === 'marketing_agent') {
    return [
      { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/marketing-hub', label: 'Marketing Hub', icon: Megaphone },
    ]
  }

  const items = [...BASE_NAV]

  if (role === 'admin' || role === 'sourcing_department') {
    items.push(...FULL_NAV_EXTRAS)
    items.push({ to: '/marketing-hub', label: 'Marketing Hub', icon: Megaphone })
  } else {
    items.push({ to: '/communications', label: 'Messages', icon: MessageSquare })
    items.push({ to: '/analytics', label: 'Analytics', icon: BarChart2 })
  }

  if (role === 'admin') {
    items.unshift({ to: '/admin', label: 'Admin Dashboard', icon: ShieldCheck })
  }

  return items
}

function getPageTitle(pathname, navItems) {
  const match = navItems.find((item) =>
    item.end ? pathname === item.to : pathname.startsWith(item.to)
  )
  if (match) return match.label
  if (pathname.startsWith('/admin')) return 'Admin Dashboard'
  return 'RecruitPro'
}

export default function Layout() {
  const { user, logout } = useAuthStore()
  const { role } = useRole()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const navItems = buildNav(role)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const pageTitle = getPageTitle(location.pathname, navItems)

  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950 font-sans overflow-hidden selection:bg-primary-600 selection:text-white transition-colors">
      <TopProgressBar />

      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 bg-primary-950/40 backdrop-blur-sm lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Floating Sidebar */}
      <aside
        className={twMerge(
          'fixed lg:static inset-y-0 left-0 z-40 w-72 h-[calc(100vh-2rem)] my-4 ml-4 lg:my-4 lg:ml-4 flex flex-col bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800/70 shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
          'before:content-[""] before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-brand-gradient before:rounded-l-3xl',
          sidebarOpen ? 'translate-x-0' : '-translate-x-[120%] lg:translate-x-0'
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-6 py-6">
          <Logo size={36} />
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-4 py-2 space-y-1 overflow-y-auto custom-scrollbar">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                twMerge(
                  'relative flex items-center gap-3 px-3 py-2.5 rounded-2xl transition-all duration-200 group text-sm font-semibold tracking-tight',
                  isActive
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-950/50 dark:text-primary-300 shadow-sm before:content-[""] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-accent-gradient before:shadow-glow-red'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={18}
                    className={twMerge(
                      'flex-shrink-0 transition-transform duration-300',
                      isActive
                        ? 'text-primary-600 dark:text-primary-400'
                        : 'text-zinc-400 dark:text-zinc-500 group-hover:scale-110 group-hover:text-primary-600 dark:group-hover:text-primary-400'
                    )}
                    aria-hidden
                  />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User Profile */}
        <div className="p-4 mx-4 mb-4 bg-zinc-50 dark:bg-zinc-800/60 rounded-3xl border border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-brand-gradient shadow-glow-blue flex items-center justify-center text-white font-bold text-sm ring-2 ring-white dark:ring-zinc-900">
              {user?.full_name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate tracking-tight">
                {user?.full_name}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 capitalize">
                {role === 'project_handler'
                  ? 'Project Handler'
                  : role === 'sourcing_department'
                  ? 'Sourcing Dept.'
                  : role === 'admin'
                  ? 'Administrator'
                  : role === 'marketing_agent'
                  ? 'Marketing Agent'
                  : role}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:text-white hover:bg-accent-gradient hover:shadow-glow-red rounded-xl transition-all"
          >
            <LogOut size={14} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Top Header */}
        <header className="flex items-center justify-between px-8 pt-8 pb-4 lg:px-12 bg-transparent z-10 w-full relative backdrop-blur-sm">
          <div className="flex items-center gap-4 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2.5 text-zinc-600 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-700/60 rounded-2xl shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <Menu size={20} />
            </button>
            <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50 tracking-tight truncate">
              {pageTitle}
            </h2>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <ThemeToggle />
            <button
              type="button"
              aria-label="Notifications"
              className="relative p-2.5 bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-700/60 text-zinc-600 dark:text-zinc-300 hover:text-primary-600 dark:hover:text-primary-400 rounded-2xl shadow-sm hover:shadow-md transition-all ease-out duration-300"
            >
              <Bell size={18} />
              <span className="absolute top-2 right-2.5 flex h-2.5 w-2.5">
                <span className="animate-ping-soft absolute inline-flex h-full w-full rounded-full bg-accent-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent-gradient shadow-glow-red" />
              </span>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 lg:px-12 pb-12 w-full custom-scrollbar">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 14, scale: 0.995 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.998 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="max-w-[1400px] mx-auto w-full h-full"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
