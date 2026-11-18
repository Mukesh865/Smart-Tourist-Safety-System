import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import AppShell from '../components/AppShell'
import Auth, { passwordStrength } from '../pages/Auth'
import { useAuth, type Role } from '../store'
import { a11yViolations } from '../test-utils'
import { Badge, Button, ConfirmDialog, EmptyState, ErrorBoundary, Modal, StatCard, Tabs, TextInput, ThemeProvider, ToastProvider, useTheme, useToast } from '.'

const setUser = (role: Role) => useAuth.setState({ loading: false, user: { id: 1, email: 'x@x.com', full_name: 'Xena', role, language: 'en' } })

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  useAuth.setState({ user: null, loading: false })
})

describe('Button / Field', () => {
  test('loading disables the button and marks it busy', () => {
    const onClick = vi.fn()
    render(<Button loading onClick={onClick}>Save</Button>)
    const b = screen.getByRole('button', { name: /save/i })
    expect(b).toBeDisabled()
    expect(b).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(b)
    expect(onClick).not.toHaveBeenCalled()
  })

  test('TextInput links label, hint and error for assistive tech', () => {
    const { rerender } = render(<TextInput label="Email" hint="We never share it" />)
    const input = screen.getByLabelText('Email')
    expect(input).toHaveAccessibleDescription('We never share it')
    rerender(<TextInput label="Email" error="Invalid email" />)
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email')
  })
})

describe('Modal / ConfirmDialog', () => {
  test('Escape closes, focus moves into the dialog and returns to the trigger', async () => {
    const onClose = vi.fn()
    function Harness() {
      return <><button>trigger</button><Modal open title="Edit" onClose={onClose}>body</Modal></>
    }
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus()
    const { unmount } = render(<Harness />)
    expect(screen.getByRole('dialog', { name: 'Edit' })).toHaveFocus()
    await userEvent.setup().keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  test('ConfirmDialog confirm and cancel', async () => {
    const ok = vi.fn(), no = vi.fn()
    render(<ConfirmDialog open title="Revoke ID?" message="This cannot be undone" confirmLabel="Revoke" danger onConfirm={ok} onCancel={no} />)
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: 'Revoke' }))
    await u.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(ok).toHaveBeenCalledTimes(1)
    expect(no).toHaveBeenCalledTimes(1)
  })

  test('typing in a dialog input keeps focus even when the parent re-renders with a new onClose each time', async () => {
    function Parent() {
      const [v, setV] = useState('')
      return <Modal open title="Reason" onClose={() => setV('')}><input aria-label="Reason text" value={v} onChange={(e) => setV(e.target.value)} /></Modal>
    }
    render(<Parent />)
    const input = screen.getByLabelText('Reason text')
    await userEvent.setup().click(input)
    await userEvent.setup().keyboard('abc')
    expect(input).toHaveValue('abc')            // regression: used to stop after the first character
    expect(input).toHaveFocus()
  })

  test('closed modal renders nothing', () => {
    render(<Modal open={false} title="x" onClose={() => {}}>hidden</Modal>)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Toast', () => {
  function Trigger({ kind }: { kind?: 'error' | 'success' }) {
    const toast = useToast()
    return <button onClick={() => toast('Saved it', { kind, ms: 1000 })}>go</button>
  }

  test('shows, announces by kind, and auto-dismisses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<ToastProvider><Trigger kind="error" /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    expect(screen.getByRole('alert')).toHaveTextContent('Saved it')    // errors are role=alert
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.queryByText('Saved it')).toBeNull()
    fireEvent.click(screen.getByText('go'))
    vi.useRealTimers()
  })

  test('manual dismiss and non-error kind uses role=status', () => {
    render(<ToastProvider><Trigger kind="success" /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    expect(screen.getByRole('status')).toHaveTextContent('Saved it')
    fireEvent.click(screen.getByLabelText('Dismiss notification'))
    expect(screen.queryByText('Saved it')).toBeNull()
  })
})

describe('Theme', () => {
  function Probe() {
    const { theme, pref, toggle, setPref } = useTheme()
    return <><span data-testid="t">{theme}/{pref}</span><button onClick={toggle}>toggle</button><button onClick={() => setPref('system')}>system</button></>
  }

  test('toggle switches the html class and persists the choice', async () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    await userEvent.setup().click(screen.getByText('toggle'))
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('ts_theme')).toBe('dark')
    expect(screen.getByTestId('t')).toHaveTextContent('dark/dark')
  })

  test('a stored preference is applied on load', () => {
    localStorage.setItem('ts_theme', 'dark')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(document.documentElement).toHaveClass('dark')
  })

  test('system preference follows the OS when nothing is stored', () => {
    const mq = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const original = window.matchMedia
    window.matchMedia = vi.fn().mockReturnValue(mq) as any     // jsdom does not implement matchMedia
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('t')).toHaveTextContent('dark/system')
    window.matchMedia = original
  })

  test('broken storage does not crash', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('t')).toBeInTheDocument()
    vi.restoreAllMocks()
  })
})

describe('AppShell', () => {
  const renderShell = () => render(<ThemeProvider><MemoryRouter><AppShell title="Page"><p>content</p></AppShell></MemoryRouter></ThemeProvider>)

  test.each([
    ['police', ['Dashboard', 'Risk zones', 'Evaluation', 'Verify ID'], ['Issue ID']],
    ['officer', ['Issue ID', 'Verify ID'], ['Dashboard', 'Risk zones', 'Evaluation']],
    ['admin', ['Dashboard', 'Risk zones', 'Issue ID', 'Evaluation', 'Verify ID'], []],
  ] as [Role, string[], string[]][])('%s sees only their navigation', (role, shown, hidden) => {
    setUser(role)
    renderShell()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    for (const l of shown) expect(nav).toHaveTextContent(l)
    for (const l of hidden) expect(nav).not.toHaveTextContent(new RegExp(`\\b${l}\\b`))
    expect(screen.getByRole('heading', { level: 1, name: 'Page' })).toBeInTheDocument()
  })

  test('tourist gets a bottom tab bar instead of a sidebar', () => {
    setUser('tourist')
    renderShell()
    expect(screen.getByRole('navigation', { name: 'Tabs' })).toHaveTextContent('Home')
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
  })

  test('theme toggle and logout work from the header', async () => {
    setUser('police')
    renderShell()
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: /switch to dark theme/i }))
    expect(screen.getByRole('button', { name: /switch to light theme/i })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: /log out/i }))
    expect(useAuth.getState().user).toBeNull()
  })

  test('mobile menu opens the drawer', async () => {
    setUser('police')
    renderShell()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open menu' }))
    expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBe(2)   // desktop sidebar + drawer copy
  })

  test('has a skip link and no accessibility violations', async () => {
    setUser('police')
    const { container } = renderShell()
    expect(screen.getByText('Skip to content')).toHaveAttribute('href', '#content')
    expect(await a11yViolations(container)).toEqual([])
  })
})

describe('Auth page', () => {
  const renderAuth = (mode: 'login' | 'register') => render(<MemoryRouter><Auth mode={mode} /></MemoryRouter>)

  test('password strength helper', () => {
    expect(passwordStrength('').score).toBe(0)
    expect(passwordStrength('abc').label).toBe('Too short')
    expect(passwordStrength('abcdefgh').score).toBe(1)
    expect(passwordStrength('Abcdefgh1!').score).toBe(3)
  })

  test('show/hide toggles the password field type', async () => {
    renderAuth('login')
    const pw = screen.getByLabelText('Password')
    expect(pw).toHaveAttribute('type', 'password')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show or hide characters' }))
    expect(pw).toHaveAttribute('type', 'text')
  })

  test('register shows a live strength meter', async () => {
    renderAuth('register')
    await userEvent.setup().type(screen.getByLabelText('Password'), 'Abcdefgh1!')
    expect(screen.getByText('Strength: Strong')).toBeInTheDocument()
  })

  test('rate-limit response gets a friendly message', async () => {
    const { api } = await import('../api')
    vi.spyOn(api, 'post').mockRejectedValue({ response: { status: 429, data: { detail: 'Too many requests. Try again later.' } } })
    renderAuth('login')
    const u = userEvent.setup()
    await u.type(screen.getByLabelText('Email'), 'a@x.com')
    await u.type(screen.getByLabelText('Password'), 'password123')
    await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/wait a minute/i))
    vi.restoreAllMocks()
  })

  test.each(['login', 'register'] as const)('%s page has no accessibility violations', async (mode) => {
    const { container } = renderAuth(mode)
    expect(await a11yViolations(container)).toEqual([])
  })
})

describe('small components', () => {
  test('Tabs report selection', async () => {
    const onChange = vi.fn()
    render(<Tabs label="Views" value="a" onChange={onChange} tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} />)
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.setup().click(screen.getByRole('tab', { name: 'B' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  test('Badge, StatCard and EmptyState render their content', () => {
    render(<><Badge tone="danger">Open</Badge><StatCard label="Active" value={7} hint="now" /><EmptyState title="Nothing here" hint="Try later" /></>)
    for (const t of ['Open', 'Active', '7', 'now', 'Nothing here', 'Try later']) expect(screen.getByText(t)).toBeInTheDocument()
  })

  test('ErrorBoundary shows a recovery message instead of a blank page', () => {
    const Boom = () => { throw new Error('boom') }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    vi.restoreAllMocks()
  })
})
