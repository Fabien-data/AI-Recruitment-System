import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { LayoutDashboard, Users, Briefcase, FileText, MessageSquare, LogOut, Menu, X, Bell, FileSearch, Database, FolderKanban, CalendarDays, BarChart2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { twMerge } from 'tailwind-merge'

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/candidates', label: 'Candidates', icon: Users },
  { to: '/cv-manager', label: 'CV Manager', icon: FileSearch },
  { to: '/jobs', label: 'Jobs', icon: Briefcase },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/applications', label: 'Applications', icon: FileText },
  { to: '/communications', label: 'Messages', icon: MessageSquare },
  { to: '/interviews', label: 'Interviews', icon: CalendarDays },
  { to: '/analytics', label: 'Analytics', icon: BarChart2 },
  { to: '/general-pool', label: 'General Pool', icon: Database },
]

function getPageTitle(pathname) {
  const match = NAV_ITEMS.find(item =>
    item.end ? pathname === item.to : pathname.startsWith(item.to)
  )
  return match?.label || 'RecruitPro'
}

export default function Layout() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const pageTitle = getPageTitle(location.pathname)

  // Ensure sidebar closes on route change on mobile
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-screen bg-[#FAFAFA] font-sans overflow-hidden selection:bg-zinc-900 selection:text-white">
      {/* Mobile overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 bg-zinc-900/20 backdrop-blur-sm lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Floating Sidebar */}
      <aside
        className={twMerge(
          "fixed lg:static inset-y-0 left-0 z-40 w-72 h-[calc(100vh-2rem)] my-4 ml-4 lg:my-4 lg:ml-4 flex flex-col bg-white rounded-3xl border border-zinc-200/50 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
          sidebarOpen ? 'translate-x-0' : '-translate-x-[120%] lg:translate-x-0'
        )}
      >
        {/* Workspace Switcher / Logo */}
        <div className="flex items-center justify-between px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 shadow-sm flex items-center justify-center">
               <svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                  <path d="M16 8C11.5817 8 8 11.5817 8 16C8 20.4183 11.5817 24 16 24C20.4183 24 24 20.4183 24 16C24 11.5817 20.4183 8 16 8ZM16 21C13.2386 21 11 18.7614 11 16C11 13.2386 13.2386 11 16 11C18.7614 11 21 13.2386 21 16C21 18.7614 18.7614 21 16 21Z" fill="white" opacity="0.9"/>
                  <path d="M20 16L15 11V21L20 16Z" fill="white"/>
               </svg>
            </div>
            <span className="font-bold text-lg text-zinc-900 tracking-tight">RecruitPro</span>
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1.5 text-zinc-400 hover:text-zinc-600 rounded-xl hover:bg-zinc-100 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-4 py-2 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                twMerge(
                  "flex items-center gap-3 px-3 py-2.5 rounded-2xl transition-all duration-200 group text-sm font-semibold tracking-tight",
                  isActive
                    ? "bg-zinc-100 text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={18} className={twMerge("flex-shrink-0 transition-transform duration-300", isActive ? "text-zinc-900" : "text-zinc-400 group-hover:scale-105 group-hover:text-zinc-900")} aria-hidden />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User Profile */}
        <div className="p-4 mx-4 mb-4 bg-zinc-50 rounded-3xl border border-zinc-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">
              {user?.full_name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0">
               <p className="font-semibold text-sm text-zinc-900 truncate tracking-tight">{user?.full_name}</p>
               <p className="text-xs text-zinc-500 capitalize">{user?.role}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-zinc-600 hover:text-zinc-900 rounded-xl hover:bg-zinc-200/50 transition-colors"
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
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2.5 text-zinc-600 bg-white border border-zinc-200/50 rounded-2xl shadow-sm hover:bg-zinc-50 transition-colors"
            >
              <Menu size={20} />
            </button>
            <h2 className="text-2xl font-bold text-zinc-900 tracking-tight">{pageTitle}</h2>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="relative p-2.5 bg-white border border-zinc-200/50 text-zinc-500 hover:text-zinc-900 rounded-2xl shadow-sm hover:shadow-md transition-all ease-out duration-300"
            >
              <Bell size={18} />
              <span className="absolute top-2 right-2.5 w-2 h-2 bg-indigo-500 rounded-full" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 lg:px-12 pb-12 w-full custom-scrollbar">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
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
