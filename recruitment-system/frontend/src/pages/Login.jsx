import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const login = useAuthStore((state) => state.login)
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      await login(email, password)
      toast.success('Login successful')
      navigate('/')
    } catch (error) {
      toast.error(error.response?.data?.error || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 p-4 animate-fade-in">
      <div className="card w-full max-w-md">
        <h1 className="text-3xl font-bold text-center mb-6 text-gray-900">
          Recruitment System
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Sign in to access your dashboard
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
          <Button
            type="submit"
            variant="primary"
            loading={loading}
            disabled={loading}
            className="w-full"
          >
            Sign In
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-gray-600">
          Need an admin account?{' '}
          <Link to="/register" className="text-primary-700 hover:text-primary-800 font-medium">
            Create one
          </Link>
        </p>
      </div>
    </div>
  )
}
