import { NavLink } from 'react-router-dom'
import { useEffect, useRef, useCallback, useState } from 'react'
import {
  LayoutDashboard, Building2, FileText,
  CalendarDays, Layers, Settings, ChevronLeft,
  ChevronRight, Scissors, BookOpen, ExternalLink, BookMarked, HelpCircle,
  ShieldAlert, TrendingUp, ClipboardList, Bug,
} from 'lucide-react'
import pkLogo from '../../assets/pk-logo-light.png'
import bobLogo from '../../assets/bob.png'
import { useUIStore }      from '../../store/ui.store'
import { useAuthStore }    from '../../store/auth.store'
import { useServicesStore } from '../../store/services.store'
import { initials } from '../../lib/utils'
import { fsApi } from '../../lib/ipc'
import type { QuickLink } from '../../lib/ipc'

interface NavItem {
  to:     string
  icon:   React.ComponentType<{ size?: number; strokeWidth?: number }>
  label:  string
  sub?:   string
  help?:  string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard',     help: 'Your overview: upcoming calls, recent activity, and key company stats at a glance.' },
  { to: '/companies',   icon: Building2,       label: 'Companies',     sub: 'CRM',              help: 'Your full book of business. Search, filter, and click any company to see its profile, calls, and calendar events.' },
  { to: '/transcripts', icon: FileText,        label: 'Transcripts',   sub: 'Gong',             help: 'Run the 3-step Gong scraper to import call transcripts into your Google Drive and link them to companies.' },
  { to: '/calendar',    icon: CalendarDays,    label: 'Calendar',      help: 'Your upcoming Google Calendar events. Events are automatically matched to companies by name.' },
  { to: '/flyer',       icon: Layers,          label: 'Flyer Creator', help: 'Generate branded flyers with your company logo, QR codes, and location-specific phone numbers.' },
  { to: '/scrub',       icon: Scissors,        label: 'Scrub & Split', sub: 'CSV PII removal',  help: 'Upload a CSV file to automatically remove PII (SSNs, credit cards, etc.) and split it into clean chunks.' },
  { to: '/risk',        icon: ShieldAlert,     label: 'Risk',          sub: 'Account health',   help: 'Risk analysis based on the last Blueprint Messages CSV run through Scrub & Split. Shows risk flags, branch health, volume trends, and response time.' },
  { to: '/expansion',   icon: TrendingUp,      label: 'Expansion',     sub: 'Growth signals',   help: 'Expansion opportunity analysis based on the last Blueprint Messages CSV. Shows quote facilitation, location gaps, BTM opportunities, and best-practice benchmarks.' },
  { to: '/followups',   icon: ClipboardList,   label: 'Follow Ups',    sub: 'Action items',     help: 'Track follow-up commitments from calls and manual entries. Parse transcripts to auto-extract action items.' },
  { to: '/prompts',     icon: BookMarked,      label: 'Prompt Library',sub: 'Claude prompts',   help: 'Save and reuse your favorite Claude AI prompts. Use [ACCOUNT NAME] as a placeholder that auto-fills from Scrub & Split.' },
  { to: '/assistant',   icon: BookOpen,        label: 'Knowledge',     sub: 'Prokeep Assistant',help: 'Search Prokeep internal and customer-facing knowledge base articles to quickly find answers.' },
]

// ─── Section label height (collapsed section shows only this) ─────────────────
const SECTION_LABEL_H = 28

export function Sidebar() {
  const collapsed      = useUIStore(s => s.sidebarCollapsed)
  const toggle         = useUIStore(s => s.toggleSidebar)
  const setSidebar     = useUIStore(s => s.setSidebar)
  const auth           = useAuthStore(s => s.status)
  const extLinks       = useUIStore(s => s.quickLinks)
  const loadQuickLinks = useUIStore(s => s.loadQuickLinks)
  const services       = useServicesStore(s => s.status)
  const helpMode               = useUIStore(s => s.helpMode)
  const toggleHelpMode         = useUIStore(s => s.toggleHelpMode)
  const feedbackLoggerMode     = useUIStore(s => s.feedbackLoggerMode)
  const toggleFeedbackLoggerMode = useUIStore(s => s.toggleFeedbackLoggerMode)

  // Which section is currently expanded (hover-based, persists after mouse leaves)
  const [activeSection, setActiveSection] = useState<'modules' | 'quicklinks' | 'admin'>('modules')
  // Remembers which section was active when the sidebar was collapsed
  const [preCollapseSection, setPreCollapseSection] = useState<'modules' | 'quicklinks' | 'admin'>('modules')

  // Captures active section before collapsing so collapsed icons reflect the right section
  function handleToggle() {
    if (!collapsed) setPreCollapseSection(activeSection)
    toggle()
  }

  useEffect(() => {
    loadQuickLinks()
  }, [])

  // ── Resize handle with auto-collapse ──────────────────────────────────────
  const COLLAPSE_THRESHOLD = 180

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX     = e.clientX
    const startWidth = collapsed
      ? 64
      : parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width') || '240', 10)

    let hasCaptured = false
    const onMouseMove = (ev: MouseEvent) => {
      const rawWidth = startWidth + (ev.clientX - startX)
      if (rawWidth < COLLAPSE_THRESHOLD) {
        if (!hasCaptured) { hasCaptured = true; setPreCollapseSection(activeSection) }
        setSidebar(true)
      } else {
        setSidebar(false)
        const clamped = Math.min(380, Math.max(COLLAPSE_THRESHOLD, rawWidth))
        document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`)
      }
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor    = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor    = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [collapsed, setSidebar, activeSection])

  // ── Section flex helper ───────────────────────────────────────────────────
  const sectionStyle = (section: 'modules' | 'quicklinks' | 'admin'): React.CSSProperties => {
    if (collapsed) return { display: 'flex', flexDirection: 'column' }
    const isActive = activeSection === section
    return {
      flex:           isActive ? '1 1 0' : `0 0 ${SECTION_LABEL_H}px`,
      minHeight:      SECTION_LABEL_H,
      overflow:       'hidden',
      display:        'flex',
      flexDirection:  'column',
      transition:     'flex 240ms ease-in-out',
    }
  }

  return (
    <nav style={styles.nav}>
      {/* Resize handle — right edge, always visible */}
      <div
        onMouseDown={handleResizeMouseDown}
        style={{ position: 'absolute', top: 0, right: 0, width: 4, height: '100%', cursor: 'col-resize', zIndex: 10 }}
      />

      {/* ── Brand / Logo — always fixed at top ─────────────────────────── */}
      <div style={styles.brand}>
        {!collapsed ? (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <img src={pkLogo} alt="Prokeep" style={{ height: 28, maxWidth: '100%', objectFit: 'contain', objectPosition: 'left', flexShrink: 0 }} />
            <img src={bobLogo} alt="B.O.B."  style={{ height: 40, objectFit: 'contain', objectPosition: 'left', flexShrink: 0 }} />
          </div>
        ) : (
          <img src={pkLogo} alt="Prokeep" style={{ height: 22, width: 22, objectFit: 'contain' }} />
        )}
      </div>

      {collapsed ? (
        /* ══ COLLAPSED STATE ════════════════════════════════════════════════ */
        /* Show icons for whichever section was active before collapsing.
           Expand arrow is always visible at the bottom. */
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

          {/* Modules icons */}
          {preCollapseSection === 'modules' && (
            <div style={{ ...styles.navItems, flex: '1 1 0', minHeight: 0 }}>
              {NAV_ITEMS.map(item => (
                <SidebarLink key={item.to} item={item} collapsed={true} />
              ))}
            </div>
          )}

          {/* Quick links icons */}
          {preCollapseSection === 'quicklinks' && (
            <div style={{ flex: '1 1 0', overflowY: 'auto', padding: '4px var(--space-2)' }}>
              {extLinks.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, opacity: 0.4 }}>
                  <ExternalLink size={13} color="var(--color-text-muted)" />
                </div>
              ) : extLinks.map(link => (
                <button key={link.url} title={link.label}
                  onClick={() => fsApi.openExternal(link.url)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 28, border: 'none', borderRadius: 'var(--radius-md)', background: 'transparent', cursor: 'pointer', marginBottom: 2 }}>
                  <ExternalLink size={13} color={link.color} />
                </button>
              ))}
            </div>
          )}

          {/* Admin icons */}
          {preCollapseSection === 'admin' && (
            <div style={{ flex: '1 1 0', overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '4px var(--space-2)', gap: 'var(--space-1)' }}>
              <button
                onClick={toggleFeedbackLoggerMode}
                title={feedbackLoggerMode ? 'Exit Feedback Logger' : 'Feedback Logger Mode'}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 32, border: 'none', borderRadius: 'var(--radius-md)', background: feedbackLoggerMode ? 'rgba(218,80,57,0.15)' : 'transparent', color: feedbackLoggerMode ? '#DA5039' : 'var(--color-text-muted)', cursor: 'pointer', position: 'relative' }}
              >
                <Bug size={17} strokeWidth={feedbackLoggerMode ? 2.2 : 1.8} />
                {feedbackLoggerMode && (
                  <span style={{ position: 'absolute', right: 4, top: 4, width: 6, height: 6, borderRadius: '50%', background: '#DA5039' }} />
                )}
              </button>
              <button
                onClick={toggleHelpMode}
                title={helpMode ? 'Exit How-To Mode' : 'How-To Mode'}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 32, border: 'none', borderRadius: 'var(--radius-md)', background: helpMode ? 'rgba(155,109,255,0.15)' : 'transparent', color: helpMode ? '#9B6DFF' : 'var(--color-text-muted)', cursor: 'pointer', position: 'relative' }}
              >
                <HelpCircle size={17} strokeWidth={helpMode ? 2.2 : 1.8} />
                {helpMode && (
                  <span style={{ position: 'absolute', right: 4, top: 4, width: 6, height: 6, borderRadius: '50%', background: '#9B6DFF' }} />
                )}
              </button>
              <SidebarLink item={{ to: '/settings', icon: Settings, label: 'Settings' }} collapsed={true} />
              {auth?.isAuthenticated && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 0' }}>
                  <ServiceDotOnly color="var(--color-teal-500)" connected={true} title="Google Connected" />
                  <ServiceDotOnly color="#FF7A00" connected={services.hubspot.connected} title={services.hubspot.connected ? 'HubSpot Connected' : 'HubSpot — not connected'} />
                  <ServiceDotOnly color="#9B6DFF" connected={services.gong.connected} title={services.gong.connected ? 'Gong Connected' : 'Gong — not connected'} />
                </div>
              )}
            </div>
          )}

          {/* Always-visible expand arrow */}
          <button style={{ ...styles.collapseBtn, marginTop: 'auto', borderTop: '1px solid var(--color-border)' }} onClick={handleToggle} title="Expand">
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <>
          {/* ══ SECTION 1: MODULES ════════════════════════════════════════════ */}
          <div
            style={sectionStyle('modules')}
            onMouseEnter={() => setActiveSection('modules')}
          >
            <SectionLabel label="Modules" isActive={activeSection === 'modules'} />
            <div style={{ ...styles.navItems, flex: '1 1 0', minHeight: 0 }}>
              {NAV_ITEMS.map(item => (
                <SidebarLink key={item.to} item={item} collapsed={false} />
              ))}
            </div>
          </div>

          {/* ══ SECTION 2: QUICK LINKS ════════════════════════════════════════ */}
          <div
            style={sectionStyle('quicklinks')}
            onMouseEnter={() => setActiveSection('quicklinks')}
          >
            <SectionLabel label="Quick Links" isActive={activeSection === 'quicklinks'} />
            <div style={{ flex: '1 1 0', overflowY: 'auto', padding: '2px var(--space-2) 4px' }}>
              {extLinks.length === 0 ? (
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', padding: '6px var(--space-1)', opacity: 0.6 }}>
                  No links — add in Settings
                </div>
              ) : (
                extLinks.map(link => <ExtLinkButton key={link.url} link={link} />)
              )}
            </div>
          </div>

          {/* ══ SECTION 3: ADMIN ══════════════════════════════════════════════ */}
          <div
            style={{ ...sectionStyle('admin'), borderTop: '1px solid var(--color-border)' }}
            onMouseEnter={() => setActiveSection('admin')}
          >
            <SectionLabel label="Admin" isActive={activeSection === 'admin'} noBorderTop />
            <div style={{ display: 'flex', flexDirection: 'column', padding: '0 var(--space-2)', gap: 'var(--space-1)', paddingTop: 4, flex: '1 1 0', overflowY: 'auto' }}>
              <button
                onClick={toggleFeedbackLoggerMode}
                title={feedbackLoggerMode ? 'Exit Feedback Logger' : 'Feedback Logger Mode'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                  padding: '9px var(--space-3)', width: '100%',
                  borderRadius: 'var(--radius-md)', border: 'none',
                  background: feedbackLoggerMode ? 'rgba(218,80,57,0.15)' : 'transparent',
                  color: feedbackLoggerMode ? '#DA5039' : 'var(--color-text-muted)',
                  cursor: 'pointer', textAlign: 'left',
                  transition: 'background var(--transition-fast), color var(--transition-fast)',
                  flexShrink: 0,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 20, height: 20 }}>
                  <Bug size={17} strokeWidth={feedbackLoggerMode ? 2.2 : 1.8} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' as never }}>Feedback Logger</span>
                  {feedbackLoggerMode && <span style={{ fontSize: 'var(--text-xs)', color: '#DA5039', opacity: 0.8 }}>Active — click to log</span>}
                </span>
              </button>

              <button
                onClick={toggleHelpMode}
                title={helpMode ? 'Exit How-To Mode' : 'How-To Mode'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                  padding: '9px var(--space-3)', width: '100%',
                  borderRadius: 'var(--radius-md)', border: 'none',
                  background: helpMode ? 'rgba(155,109,255,0.15)' : 'transparent',
                  color: helpMode ? '#9B6DFF' : 'var(--color-text-muted)',
                  cursor: 'pointer', textAlign: 'left',
                  transition: 'background var(--transition-fast), color var(--transition-fast)',
                  flexShrink: 0,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 20, height: 20 }}>
                  <HelpCircle size={17} strokeWidth={helpMode ? 2.2 : 1.8} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' as never }}>How-To Mode</span>
                  {helpMode && <span style={{ fontSize: 'var(--text-xs)', color: '#9B6DFF', opacity: 0.8 }}>Active — hover anything</span>}
                </span>
              </button>

              <SidebarLink item={{ to: '/settings', icon: Settings, label: 'Settings' }} collapsed={false} />

              {auth?.isAuthenticated && (
                <div style={styles.userRow}>
                  <div style={styles.avatar}>{initials(auth.email ?? 'U')}</div>
                  <div style={styles.userInfo}>
                    <span style={styles.userEmail}>{auth.email}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 3 }}>
                      <ServiceDot color="var(--color-teal-500)" label="Google" connected={true} />
                      <ServiceDot color="#FF7A00" label="HubSpot" connected={services.hubspot.connected} />
                      <ServiceDot color="#9B6DFF" label="Gong" connected={services.gong.connected} />
                    </div>
                  </div>
                </div>
              )}

              {/* Collapse button */}
              <button style={styles.collapseBtn} onClick={handleToggle} title="Collapse">
                <ChevronLeft size={14} strokeWidth={2} />
              </button>
            </div>
          </div>
        </>
      )}
    </nav>
  )
}

// ─── Section label bar ────────────────────────────────────────────────────────

function SectionLabel({ label, isActive, noBorderTop }: { label: string; isActive: boolean; noBorderTop?: boolean }) {
  return (
    <div style={{
      height:          SECTION_LABEL_H,
      display:         'flex',
      alignItems:      'center',
      padding:         '0 12px',
      borderTop:       noBorderTop ? 'none' : '1px solid var(--color-border)',
      fontSize:        9,
      fontWeight:      700,
      color:           isActive ? 'var(--color-teal-400)' : 'var(--color-text-muted)',
      letterSpacing:   '0.1em',
      textTransform:   'uppercase' as const,
      opacity:         isActive ? 1 : 0.7,
      flexShrink:      0,
      transition:      'color 200ms ease, opacity 200ms ease',
      userSelect:      'none',
    }}>
      {label}
    </div>
  )
}

// ─── Nav link ─────────────────────────────────────────────────────────────────

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      data-help={item.help}
      style={({ isActive }) => ({
        ...styles.navLink,
        ...(isActive ? styles.navLinkActive : {}),
      })}
    >
      {({ isActive }) => (
        <>
          <span style={{ ...styles.navIcon, ...(isActive ? styles.navIconActive : {}) }}>
            <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} />
          </span>
          {!collapsed && (
            <span style={styles.navLabel}>
              <span style={styles.navLabelMain}>{item.label}</span>
              {item.sub && <span style={styles.navLabelSub}>{item.sub}</span>}
            </span>
          )}
          {isActive && <span style={styles.activeBar} />}
        </>
      )}
    </NavLink>
  )
}

// ─── External link button ─────────────────────────────────────────────────────

function ExtLinkButton({ link }: { link: QuickLink }) {
  return (
    <button
      onClick={() => fsApi.openExternal(link.url)}
      title={link.url}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px var(--space-3)', border: 'none', borderRadius: 'var(--radius-md)', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
    >
      <ExternalLink size={12} color={link.color} style={{ flexShrink: 0 }} />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, overflow: 'hidden' }}>
        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)' as never, color: link.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.label}</span>
        {link.sub && <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{link.sub}</span>}
      </span>
    </button>
  )
}

// ─── Service indicators ───────────────────────────────────────────────────────

function ServiceDot({ color, label, connected }: { color: string; label: string; connected: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        background: connected ? color : 'var(--color-text-muted)',
        boxShadow: connected ? `0 0 4px ${color}88` : 'none',
        opacity: connected ? 1 : 0.5,
      }} />
      <span style={{ fontSize: 10, color: connected ? color : 'var(--color-text-muted)', fontWeight: 500, opacity: connected ? 1 : 0.6 }}>
        {label} {connected ? 'Connected' : '—'}
      </span>
    </div>
  )
}

function ServiceDotOnly({ color, connected, title }: { color: string; connected: boolean; title: string }) {
  return (
    <span title={title} style={{
      display: 'block', width: 8, height: 8, borderRadius: '50%',
      background: connected ? color : 'var(--color-text-muted)',
      boxShadow: connected ? `0 0 5px ${color}99` : 'none',
      opacity: connected ? 1 : 0.4,
    }} />
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  nav: {
    display:       'flex',
    flexDirection: 'column',
    height:        '100%',
    background:    'var(--color-bg-sidebar)',
    borderRight:   '1px solid var(--color-border)',
    padding:       '0 0 var(--space-3)',
    overflow:      'hidden',
    position:      'relative',
  },
  brand: {
    display:         'flex',
    alignItems:      'center',
    gap:             'var(--space-3)',
    padding:         '0 var(--space-4) 10px',
    paddingTop:      42,
    marginBottom:    'var(--space-1)',
    WebkitAppRegion: 'drag' as never,
    flexShrink:      0,
  },
  navItems: {
    display:       'flex',
    flexDirection: 'column',
    padding:       '0 var(--space-2)',
    gap:           2,
    overflowY:     'auto' as never,
  },
  navLink: {
    display:        'flex',
    alignItems:     'center',
    gap:            'var(--space-3)',
    padding:        '8px var(--space-3)',
    borderRadius:   'var(--radius-md)',
    color:          'var(--color-text-muted)',
    textDecoration: 'none',
    position:       'relative',
    transition:     'background var(--transition-fast), color var(--transition-fast)',
    minWidth:       0,
  },
  navLinkActive: {
    background: 'var(--color-bg-active)',
    color:      'var(--color-teal-500)',
  },
  navIcon: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
    width:          20,
    height:         20,
  },
  navIconActive: {
    color: 'var(--color-teal-500)',
  },
  navLabel: {
    display:       'flex',
    flexDirection: 'column',
    lineHeight:    1.25,
    minWidth:      0,
    flex:          1,
  },
  navLabelMain: {
    fontSize:  'var(--text-sm)',
    fontWeight:'var(--weight-medium)' as never,
    wordBreak: 'break-word' as never,
  },
  navLabelSub: {
    fontSize:  'var(--text-xs)',
    color:     'var(--color-text-muted)',
    wordBreak: 'break-word' as never,
  },
  activeBar: {
    position:     'absolute',
    right:        0,
    top:          '20%',
    bottom:       '20%',
    width:        3,
    borderRadius: 'var(--radius-full)',
    background:   'var(--color-teal-500)',
  },
  userRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        'var(--space-3)',
    padding:    'var(--space-2) var(--space-3)',
    overflow:   'hidden',
    flexShrink: 0,
  },
  avatar: {
    width:          30,
    height:         30,
    borderRadius:   'var(--radius-full)',
    background:     'var(--color-teal-900)',
    color:          'var(--color-teal-400)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    fontSize:       'var(--text-xs)',
    fontWeight:     'var(--weight-bold)' as never,
    flexShrink:     0,
    border:         '1px solid var(--color-teal-700)',
  },
  userInfo: {
    display:       'flex',
    flexDirection: 'column',
    overflow:      'hidden',
  },
  userEmail: {
    fontSize:     'var(--text-xs)',
    color:        'var(--color-text-secondary)',
    whiteSpace:   'nowrap',
    overflow:     'hidden',
    textOverflow: 'ellipsis',
  },
  collapseBtn: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    width:          '100%',
    padding:        'var(--space-2)',
    background:     'transparent',
    border:         'none',
    borderRadius:   'var(--radius-md)',
    color:          'var(--color-text-muted)',
    cursor:         'pointer',
    transition:     'background var(--transition-fast), color var(--transition-fast)',
    flexShrink:     0,
  },
}
