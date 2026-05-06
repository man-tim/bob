import { useEffect, useState } from 'react'
import { RefreshCw, Video, CalendarDays } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button, TierBadge, HealthBadge } from '../../components/ui'
import { calendarApi, fsApi } from '../../lib/ipc'
import { formatDayHeading, formatTime, groupByDay } from '../../lib/utils'
import type { CalendarEvent } from '@shared/types'

function ChromeColorIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 12 L12 2 A10 10 0 0 1 20.66 17 Z" fill="#EA4335"/>
      <path d="M12 12 L20.66 17 A10 10 0 0 1 3.34 17 Z" fill="#FBBC05"/>
      <path d="M12 12 L3.34 17 A10 10 0 0 1 12 2 Z" fill="#34A853"/>
      <circle cx="12" cy="12" r="5.5" fill="white"/>
      <circle cx="12" cy="12" r="4" fill="#4285F4"/>
    </svg>
  )
}

export function CalendarPage() {
  const navigate   = useNavigate()
  const [events,   setEvents]   = useState<CalendarEvent[]>([])
  const [loading,  setLoading]  = useState(false)
  const [syncing,  setSyncing]  = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const r = await calendarApi.events()
    if (r.ok) setEvents(r.data)
    setLoading(false)
  }

  async function handleSync() {
    setSyncing(true)
    const syncResult = await calendarApi.sync()
    if (syncResult.ok) {
      // Fetch events immediately after sync resolves so a single click populates the calendar
      const eventsResult = await calendarApi.events()
      if (eventsResult.ok) setEvents(eventsResult.data)
      setLastSync(new Date().toLocaleTimeString())
    }
    setSyncing(false)
  }

  const grouped = groupByDay(events, e => e.start_at)
  const days    = Array.from(grouped.entries())

  return (
    <div className="page animate-fade-in">
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Calendar</h1>
          <p className="page-subtitle">
            Week at a Glance — next 7 days
            {lastSync && <span style={{ marginLeft: 8, color: 'var(--color-text-muted)' }}>· synced {lastSync}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => fsApi.openExternal('https://chromewebstore.google.com/detail/kkdhmffbhhmgaacdegkpfabhlplnkpil?utm_source=item-share-cb')}
            title="Install Week at a Glance Chrome Extension"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px',
              background: 'transparent',
              border: '1.5px solid #4285F4',
              borderRadius: 'var(--radius-md)',
              color: '#4285F4',
              fontSize: 'var(--text-sm)', fontWeight: 600,
              cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(66,133,244,0.1)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          >
            <ChromeColorIcon size={18} />
            Install Extension
          </button>
          <Button
            data-help="Sync Calendar: pulls your upcoming Google Calendar events and matches each one to a company in your book of business. Matched events also appear on each company's profile page."
            variant="secondary" size="sm"
            icon={<RefreshCw size={13} />}
            loading={syncing}
            onClick={handleSync}
          >
            Sync Calendar
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">
          <div className="animate-spin" style={{ width: 24, height: 24, border: '2px solid var(--color-teal-700)', borderTopColor: 'var(--color-teal-500)', borderRadius: '50%' }} />
          <p>Loading events…</p>
        </div>
      ) : days.length === 0 ? (
        <div className="empty-state">
          <CalendarDays size={40} />
          <h3>No upcoming calls</h3>
          <p>Sync your calendar to see upcoming customer calls.</p>
          <Button variant="primary" icon={<RefreshCw size={14} />} onClick={handleSync} loading={syncing}>
            Sync Now
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {days.map(([day, dayEvents]) => (
            <DayGroup key={day} day={day} events={dayEvents} />
          ))}
        </div>
      )}
    </div>
  )
}

function DayGroup({ day, events }: { day: string; events: CalendarEvent[] }) {
  const date    = new Date(day)
  const isToday = new Date().toDateString() === date.toDateString()

  return (
    <div>
      {/* Day heading */}
      <div style={styles.dayHeading}>
        <span style={{ color: isToday ? 'var(--color-teal-400)' : 'var(--color-text-secondary)' }}>
          {isToday ? 'Today — ' : ''}{formatDayHeading(date.toISOString())}
        </span>
        <span style={styles.eventCount}>{events.length} call{events.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Events */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {events
          .sort((a, b) => a.start_at.localeCompare(b.start_at))
          .map(ev => <EventCard key={ev.id} event={ev} />)
        }
      </div>
    </div>
  )
}

function EventCard({ event: ev }: { event: CalendarEvent }) {
  const navigate = useNavigate()
  const durationMin = Math.round(
    (new Date(ev.end_at).getTime() - new Date(ev.start_at).getTime()) / 60_000
  )

  return (
    <div style={styles.eventCard} data-help="Calendar event: shows the meeting title, time, duration, and the matched company. Click the Gong or Meet link to open the call. The company name links to that company's profile.">
      {/* Time column */}
      <div style={styles.timeCol}>
        <span style={styles.timeDate}>{new Date(ev.start_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        <span style={styles.timeStart}>{formatTime(ev.start_at)}</span>
        <span style={styles.timeDur}>{durationMin}m</span>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={styles.eventTitle}>{ev.title}</div>

        {ev.company && (
          <div style={styles.companyRow}>
            <span
              style={{ ...styles.companyName, ...(ev.company_id ? { cursor: 'pointer', color: 'var(--color-teal-400)', textDecoration: 'underline', textDecorationColor: 'transparent' } : {}) }}
              onClick={() => ev.company_id && navigate(`/companies/${ev.company_id}`)}
              onMouseEnter={e => { if (ev.company_id) (e.currentTarget as HTMLSpanElement).style.textDecorationColor = 'var(--color-teal-400)' }}
              onMouseLeave={e => { if (ev.company_id) (e.currentTarget as HTMLSpanElement).style.textDecorationColor = 'transparent' }}
            >
              {ev.company.name}
            </span>
            <TierBadge tier={ev.company.tier as never} />
            <HealthBadge score={ev.company.health_score ?? null} />
          </div>
        )}

        {ev.attendees.length > 0 && (
          <div style={styles.attendees}>
            {ev.attendees.slice(0, 3).map(a => (
              <span key={a.email} style={styles.attendeePill}>{a.name ?? a.email}</span>
            ))}
            {ev.attendees.length > 3 && (
              <span style={styles.attendeePill}>+{ev.attendees.length - 3} more</span>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={styles.actions}>
        {ev.meet_link && (
          <Button
            variant="primary" size="sm"
            icon={<Video size={13} />}
            onClick={() => window.open(ev.meet_link!, '_blank')}
          >
            Join
          </Button>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  dayHeading: {
    display:       'flex',
    alignItems:    'center',
    justifyContent:'space-between',
    fontSize:      'var(--text-sm)',
    fontWeight:    'var(--weight-semibold)' as never,
    color:         'var(--color-text-secondary)',
    marginBottom:  'var(--space-2)',
    paddingBottom: 'var(--space-2)',
    borderBottom:  '1px solid var(--color-border)',
  },
  eventCount: {
    fontSize:   'var(--text-xs)',
    color:      'var(--color-text-muted)',
    fontWeight: 'var(--weight-regular)' as never,
  },
  eventCard: {
    display:      'flex',
    gap:          'var(--space-4)',
    alignItems:   'flex-start',
    padding:      'var(--space-4)',
    background:   'var(--color-bg-surface)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-lg)',
    transition:   'border-color var(--transition-fast)',
  },
  timeCol: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'flex-end',
    width:         68,
    flexShrink:    0,
    gap:           1,
    paddingTop:    2,
  },
  timeDate: {
    fontSize:   'var(--text-xs)',
    fontWeight: 'var(--weight-medium)' as never,
    color:      'var(--color-text-secondary)',
    fontFamily: 'var(--font-mono)',
  },
  timeStart: {
    fontSize:   'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-teal-400)',
    fontFamily: 'var(--font-mono)',
  },
  timeDur: {
    fontSize: 'var(--text-xs)',
    color:    'var(--color-text-muted)',
  },
  eventTitle: {
    fontSize:   'var(--text-base)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-text-primary)',
    marginBottom:'var(--space-1)',
  },
  companyRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        'var(--space-2)',
    marginBottom:'var(--space-2)',
  },
  companyName: {
    fontSize:   'var(--text-sm)',
    color:      'var(--color-text-secondary)',
    fontWeight: 'var(--weight-medium)' as never,
  },
  attendees: {
    display:  'flex',
    flexWrap: 'wrap',
    gap:      4,
  },
  attendeePill: {
    padding:      '2px 8px',
    borderRadius: 'var(--radius-full)',
    background:   'var(--color-bg-elevated)',
    border:       '1px solid var(--color-border)',
    fontSize:     'var(--text-xs)',
    color:        'var(--color-text-secondary)',
  },
  actions: {
    display:    'flex',
    gap:        'var(--space-2)',
    flexShrink: 0,
    paddingTop: 2,
  },
}
