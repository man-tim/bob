/* Transcripts — exact replica of the Gong Transcript Exporter extension popup.
 * UI mirrors popup.html / popup.js v13 + background.js v15 behavior.
 */

import { useEffect, useState, useRef } from 'react'
import { gongScraperApi, push, fsApi, companiesApi, localAiApi } from '../../lib/ipc'
import { useUIStore } from '../../store/ui.store'
import { useNavigate } from 'react-router-dom'
import { Mail, X, Copy, Check } from 'lucide-react'
import type { Company } from '@shared/types'
// Company type import kept for future use

type StatusKey = 'idle' | 'running' | 'step1Done' | 'step2Done' | 'step3Done' | 'allDone' | 'stopped' | 'prompting'

interface GongStatus {
  status:        StatusKey
  extracted?:    number
  unfiledCount?: number
  sheetUrl?:     string
}

interface LogEntry { msg: string; cls: string; ts: string }

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
function fmtH(h: number): string {
  if (h === 0)  return '12 AM'
  if (h < 12)  return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

function LogPanel({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [logs])
  const CLS: Record<string,string> = { 'log-step':'#57A7B9','log-ok':'#84CFA4','log-err':'#FF7E69','log-warn':'#F4B74E','log-data':'#86D1C3' }
  return (
    <div ref={ref} style={{ marginTop:12, padding:'10px 12px', background:'#132C41', borderRadius:8, fontFamily:'monospace', fontSize:11, lineHeight:1.6, maxHeight:220, overflowY:'auto', wordBreak:'break-word', color:'#9CD4D6' }}>
      {logs.length === 0 && <span style={{opacity:0.6}}>Ready. Click "Run All" or run individual steps.</span>}
      {logs.map((l,i) => (
        <div key={i} style={{display:'flex',justifyContent:'space-between',gap:8}}>
          <span style={{flex:1,minWidth:0,wordBreak:'break-word',color:CLS[l.cls]||'#9CD4D6'}}>{l.msg}</span>
          {l.ts && l.msg.length > 0 && <span style={{color:'#57A7B9',fontSize:9,flexShrink:0,opacity:0.7,whiteSpace:'nowrap'}}>{l.ts}</span>}
        </div>
      ))}
    </div>
  )
}

export function Transcripts() {
  const navigate     = useNavigate()
  const logs                = useUIStore(s => s.gongLogs)
  const setReconnectService = useUIStore(s => s.setReconnectService)
  const [uiStatus,   setUiStatus]   = useState<GongStatus>({ status: 'idle' })
  const [schedule,   setSchedule]   = useState<{ active:boolean; mode:'daily'|'weekly'|'custom'; days:number[]; hour:number; nextRun:number } | null>(null)
  const [sheetUrl,   setSheetUrl]   = useState<string | null>(null)
  const [unfiled,    setUnfiled]    = useState<Array<{id:string; name:string}>>([])
  const [unfiledIdx, setUnfiledIdx] = useState(0)
  const [assignVal,  setAssignVal]  = useState('')
  const [loginService, setLoginService] = useState<'hubspot' | 'gong' | null>(null)
  const [schedMode,  setSchedMode]  = useState<'daily'|'weekly'|'custom'>('weekly')
  const [schedDays,  setSchedDays]  = useState<number[]>([1])   // default: Monday
  const [schedHour,  setSchedHour]  = useState(10)
  const [mainFolderUrl,      setMainFolderUrl]      = useState<string | null>(null)
  const [recentTranscripts,  setRecentTranscripts]  = useState<Array<{title:string;driveFileId:string;driveUrl:string;callDate:string;companyName:string;callUrl?:string}>>([])
  const [companiesByName,    setCompaniesByName]    = useState<Record<string, string>>({}) // name → id
  const [localRunning,       setLocalRunning]       = useState(false)  // immediate feedback on step click
  // Email drafter state: keyed by SORTED array index (not driveFileId, which can
  // be empty-string for many transcripts — causing ALL cards to show the panel).
  const [draftingFor,    setDraftingFor]    = useState<number | null>(null)
  const [draftText,      setDraftText]      = useState('')
  const [draftRunning,   setDraftRunning]   = useState(false)
  const [draftCopied,    setDraftCopied]    = useState(false)
  const draftRawRef    = useRef('')
  const draftUnsubRef  = useRef<(() => void) | null>(null)
  const draftCounterRef = useRef(0)
  const draftTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const status    = uiStatus.status
  const isRunning = status === 'running'
  // showStop stays true for the full Run-All sequence (across all inter-step status changes)
  const showStop  = isRunning || localRunning

  useEffect(() => {
    // Build company name→id map for clickable links
    companiesApi.list({ pageSize: 500 }).then(r => {
      if (r.ok) {
        const map: Record<string, string> = {}
        for (const c of r.data.items) map[c.name.toLowerCase()] = c.id
        setCompaniesByName(map)
      }
    })
  }, [])

  useEffect(() => {
    // Only clear localRunning when the process is fully finished or stopped —
    // NOT between steps (step1Done → running → step2Done → ...) so that
    // the Stop button stays visible throughout a full Run All sequence.
    if (['idle', 'stopped', 'allDone'].includes(status)) setLocalRunning(false)
  }, [status])

  useEffect(() => {
    gongScraperApi.getState().then(r => {
      if (!r.ok) return
      const s = r.data
      if (s.sheetUrl) setSheetUrl(s.sheetUrl)
      if (s.unfiled && s.unfiled.length > 0) setUnfiled(s.unfiled)
      if (s.schedule) {
        // Migrate old format (day: number) → new format (days: number[], mode)
        const sched = s.schedule as Record<string, unknown>
        if (!Array.isArray(sched['days'])) {
          sched['days'] = [sched['day'] as number ?? 1]
          sched['mode'] = 'weekly'
        }
        setSchedule(sched as typeof schedule)
      }
      if (s.mainFolderUrl) setMainFolderUrl(s.mainFolderUrl)
      // Load persisted transcripts immediately for fast display
      if (s.recentTranscripts) setRecentTranscripts(s.recentTranscripts)
      // Then refresh from Drive (includes subfolders) in the background.
      // Merge with persisted state to preserve callUrl (Drive metadata doesn't carry it).
      gongScraperApi.fetchRecent().then(r2 => {
        if (r2.ok && r2.data) {
          setRecentTranscripts(prev => r2.data.map(fresh => {
            const existing = prev.find(p => p.driveFileId === fresh.driveFileId)
            return { ...fresh, callUrl: fresh.callUrl || existing?.callUrl }
          }))
        }
      }).catch(() => { /* best-effort */ })
    })
  }, [])

  useEffect(() => {
    // Note: push.onGongLog is handled globally in App.tsx so logs survive navigation
    const u2 = push.onGongStatus(st => {
      setUiStatus(st as GongStatus)
      if (st.sheetUrl) setSheetUrl(st.sheetUrl)
      // Re-fetch state to get latest recentTranscripts and mainFolderUrl
      gongScraperApi.getState().then(r => {
        if (!r.ok) return
        if (r.data.mainFolderUrl) setMainFolderUrl(r.data.mainFolderUrl)
        if (r.data.recentTranscripts) setRecentTranscripts(r.data.recentTranscripts)
      })
      if (st.status === 'prompting') {
        gongScraperApi.getState().then(r => {
          if (r.ok && r.data.unfiled) { setUnfiled(r.data.unfiled); setUnfiledIdx(0) }
        })
      }
    })
    const u3 = push.onGongMove(() => setUnfiledIdx(i => i + 1))
    const u4 = push.onLoginNeeded(e => {
      setLoginService(e.service)
      setReconnectService(e.service)   // flag for Settings page highlight
      navigate('/settings')            // take user straight to reconnect
    })
    const u5 = push.onLoginDone(()  => setLoginService(null))
    const u6 = push.onAppReset(() => {
      setUiStatus({ status: 'idle' })
      setSheetUrl(null)
      setUnfiled([])
      setUnfiledIdx(0)
      setSchedule(null)
      setMainFolderUrl(null)
      setRecentTranscripts([])
    })
    return () => { u2(); u3(); u4(); u5(); u6() }
  }, [])

  useEffect(() => {
    if (unfiledIdx >= unfiled.length && unfiled.length > 0) {
      setUnfiled([]); setUnfiledIdx(0); setUiStatus({ status: 'step3Done' })
    }
  }, [unfiledIdx, unfiled.length])

  function calcNextRun(days: number[], hour: number): number {
    if (days.length === 0) return Date.now() + 7 * 24 * 60 * 60 * 1000
    const now = new Date(); let minMs = Infinity
    for (const day of days) {
      const t = new Date(now); t.setHours(hour, 0, 0, 0)
      let du = day - now.getDay()
      if (du < 0) du += 7; if (du === 0 && now.getHours() >= hour) du = 7
      t.setDate(t.getDate() + du)
      if (t.getTime() < minMs) minMs = t.getTime()
    }
    return minMs
  }

  const showStep1Check = ['step1Done','step2Done','step3Done','allDone'].includes(status)
  const showStep2Check = ['step2Done','step3Done','allDone'].includes(status)
  const showStep3Check = ['step3Done','allDone'].includes(status)
  const showUnfiled    = status === 'prompting' && unfiled.length > 0 && unfiledIdx < unfiled.length
  const curUnfiled     = unfiled[unfiledIdx]

  return (
    <div className="page animate-fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>

      {/* 2-column body */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>

        {/* LEFT: existing scrubber UI */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-5)', borderRight: '1px solid var(--color-border)' }}>

          {/* Header */}
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,paddingBottom:12,borderBottom:'2px solid #9CD4D6'}}>
            <div style={{width:32,height:32,borderRadius:6,background:'#132C41',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
              <svg viewBox="0 0 18 18" fill="none" width={18} height={18}>
                <rect x="1" y="2"  width="12" height="2.5" rx="1.25" fill="#9CD4D6"/>
                <rect x="3" y="6"  width="10" height="2.5" rx="1.25" fill="#57A7B9"/>
                <rect x="1" y="10" width="14" height="2.5" rx="1.25" fill="#2A7991"/>
                <rect x="4" y="14" width="8"  height="2.5" rx="1.25" fill="#9CD4D6"/>
              </svg>
            </div>
            <div>
              <div style={{fontSize:17,fontWeight:800,color:'var(--color-text-primary)'}}>Gong Transcript Exporter</div>
              <div style={{fontSize:11,fontWeight:500,color:'#2A7991'}}>Prokeep CSM Tool</div>
            </div>
          </div>

          {/* Status badge */}
          {(isRunning || status==='stopped' || status==='prompting') && (
            <div style={{marginBottom:10,padding:'10px 12px',borderRadius:8,fontSize:12,fontWeight:600,background:'var(--color-bg-card)',border:`1px solid ${isRunning?'#2A7991':status==='stopped'?'#DA5039':'#F4B74E'}`,color:'var(--color-text-primary)'}}>
              {isRunning            && 'Working in the background...'}
              {status==='stopped'   && `Stopped. ${uiStatus.extracted||0} sent.`}
              {status==='prompting' && `${uiStatus.unfiledCount||unfiled.length} file(s) need a company name.`}
            </div>
          )}

          {/* Run All */}
          {status !== 'allDone' && (
            <button disabled={showStop} onClick={() => { setLocalRunning(true); gongScraperApi.runAll() }}
              data-help="Run All: runs all 3 steps automatically — creates the Google Sheet, scrapes Gong transcripts, and sorts them into company folders in Google Drive."
              style={{display:'block',width:'100%',padding:14,marginBottom:12,border:'none',borderRadius:8,background:isRunning?'#9CD4D6':'linear-gradient(135deg,#132C41,#2A7991)',color:'#FFFBF5',fontWeight:700,fontSize:15,cursor:isRunning?'not-allowed':'pointer',textAlign:'center',fontFamily:'inherit'}}>
              Run All Processes in Background
              <span style={{display:'block',fontSize:10.5,fontWeight:400,opacity:0.7,marginTop:3}}>Creates spreadsheet, imports companies from HubSpot, scrapes Gong calls, and organizes into folders.</span>
            </button>
          )}

          {/* Step check badges */}
          {showStep1Check && (
            <div style={{display:'block',marginBottom:8,padding:'10px 12px',borderRadius:8,background:'var(--color-bg-card)',border:'1px solid #469C6C',fontSize:12,color:'#469C6C',fontWeight:600}}>
              <span style={{marginRight:6,fontSize:16}}>✓</span>Spreadsheet created and companies imported.
              {sheetUrl && <a href="#" onClick={e=>{e.preventDefault();window.open(sheetUrl,'_blank')}} style={{color:'#2A7991',fontSize:11,display:'block',marginTop:2,wordBreak:'break-all'}}>Open spreadsheet</a>}
            </div>
          )}
          {showStep2Check && (
            <div style={{display:'block',marginBottom:8,padding:'10px 12px',borderRadius:8,background:'var(--color-bg-card)',border:'1px solid #469C6C',fontSize:12,color:'#469C6C',fontWeight:600}}>
              <span style={{marginRight:6,fontSize:16}}>✓</span>{uiStatus.extracted||0} transcript(s) scraped and sent to Drive.
            </div>
          )}
          {showStep3Check && (
            <div style={{display:'block',marginBottom:8,padding:'10px 12px',borderRadius:8,background:'var(--color-bg-card)',border:'1px solid #469C6C',fontSize:12,color:'#469C6C',fontWeight:600}}>
              <span style={{marginRight:6,fontSize:16}}>✓</span>Files organized into company folders.
            </div>
          )}

          {/* Step buttons */}
          {!showStep1Check && !showStop && (
            <StepBtn n={1} color="#2A7991" help="Step 1: Opens HubSpot in the background, scrapes your company list, and creates a Master Account Spreadsheet in Google Drive." onClick={() => { setLocalRunning(true); gongScraperApi.step1() }}>
              Create Spreadsheet and Import Companies
              <Sub>Creates your Google Sheet and imports your company list from HubSpot.</Sub>
            </StepBtn>
          )}
          {!showStep2Check && !showStop && (
            <StepBtn n={2} color="#132C41" help="Step 2: Opens Gong in the background, finds your recent calls, and uploads each transcript as a file in your Google Drive Gong Uploads folder." onClick={() => { setLocalRunning(true); gongScraperApi.step2() }}>
              Scrape Transcripts and Send to Drive
              <Sub>Scrapes your recent Gong meetings and sends transcripts to your Drive.</Sub>
            </StepBtn>
          )}
          {!showStep3Check && !showStop && (
            <StepBtn n={3} color="#469C6C" help="Step 3: Reads your spreadsheet to match each transcript file to a company, then moves it into that company's folder in Google Drive. If a folder doesn't exist it gets created." disabled={status==='prompting'} onClick={() => { setLocalRunning(true); gongScraperApi.step3() }}>
              Organize Files into Company Folders
              <Sub>Sorts transcripts into company folders based on your spreadsheet.</Sub>
            </StepBtn>
          )}

          {showStop && (
            <button onClick={() => { gongScraperApi.stop(); setLocalRunning(false) }}
              style={{display:'block',width:'100%',padding:'12px 14px',marginBottom:8,border:'none',borderRadius:8,background:'#DA5039',color:'#FFFBF5',fontWeight:700,fontSize:14,cursor:'pointer',fontFamily:'inherit'}}>
              Stop All Processes
            </button>
          )}

          {/* Unfiled prompt */}
          {showUnfiled && curUnfiled && (
            <div style={{marginBottom:10,padding:12,background:'var(--color-bg-card)',border:'1px solid #F4B74E',borderRadius:8}}>
              <div style={{fontSize:12,fontWeight:700,color:'var(--color-text-primary)',marginBottom:6}}>What company is this call for?</div>
              <div style={{fontSize:11,color:'#2A7991',marginBottom:8,wordBreak:'break-word'}}>{curUnfiled.name}</div>
              <input autoFocus type="text" placeholder="Enter company name" value={assignVal}
                onChange={e => setAssignVal(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAssign()}
                style={{width:'100%',padding:'7px 10px',fontFamily:'inherit',fontSize:12,color:'var(--color-text-primary)',background:'var(--color-bg-surface)',border:'1px solid #57A7B9',borderRadius:6,outline:'none',marginBottom:6,boxSizing:'border-box'}} />
              <div style={{display:'flex',gap:6}}>
                <button onClick={handleAssign} style={{flex:1,padding:'8px 12px',border:'none',borderRadius:6,background:'#2A7991',color:'#FFFBF5',fontWeight:700,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Assign</button>
                <button onClick={handleSkip}  style={{padding:'8px 12px',border:'none',borderRadius:6,background:'#9CD4D6',color:'#132C41',fontWeight:700,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Skip</button>
              </div>
              <div style={{fontSize:10,color:'#2A7991',marginTop:6}}>{unfiledIdx+1} of {unfiled.length}</div>
            </div>
          )}

          <div style={{height:1,background:'#9CD4D6',margin:'12px 0',opacity:0.5}} />

          {/* Schedule */}
          {!schedule?.active ? (
            <div data-help="Recurring Schedule: set Step 2 (transcript scraping) to run automatically on a schedule. Choose Daily, a specific day of the week, or multiple custom days with a time." style={{marginBottom:10,padding:12,background:'var(--color-bg-card)',border:'1px solid #9CD4D6',borderRadius:8}}>
              <div style={{fontSize:12,fontWeight:700,color:'var(--color-text-primary)',display:'block',marginBottom:8}}>Recurring Schedule</div>

              {/* Mode tabs */}
              <div style={{display:'flex',gap:4,marginBottom:10}}>
                {(['daily','weekly','custom'] as const).map(m => (
                  <button key={m} onClick={() => {
                    setSchedMode(m)
                    if (m === 'daily')  setSchedDays([0,1,2,3,4,5,6])
                    if (m === 'weekly') setSchedDays([1])
                    if (m === 'custom') setSchedDays([1])
                  }} style={{flex:1,padding:'5px 0',border:'none',borderRadius:5,fontFamily:'inherit',fontSize:11,fontWeight:700,cursor:'pointer',
                    background: schedMode===m ? '#2A7991' : 'var(--color-bg-surface)',
                    color:      schedMode===m ? '#FFFBF5' : 'var(--color-text-muted)'}}>
                    {m.charAt(0).toUpperCase()+m.slice(1)}
                  </button>
                ))}
              </div>

              {/* Weekly: single day picker */}
              {schedMode === 'weekly' && (
                <select value={schedDays[0] ?? 1} onChange={e => setSchedDays([+e.target.value])} style={{...sel, width:'100%', marginBottom:8}}>
                  {DAY_NAMES.map((d,i)=><option key={i} value={i}>{d}</option>)}
                </select>
              )}

              {/* Custom: multi-day checkboxes */}
              {schedMode === 'custom' && (
                <div style={{display:'flex',flexWrap:'wrap',gap:'4px 8px',marginBottom:8}}>
                  {DAY_NAMES.map((d,i)=>(
                    <label key={i} style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:'var(--color-text-primary)',cursor:'pointer'}}>
                      <input type="checkbox" checked={schedDays.includes(i)}
                        onChange={e => setSchedDays(prev => e.target.checked ? [...prev,i].sort() : prev.filter(x=>x!==i))}
                        style={{accentColor:'#2A7991'}} />
                      {d.slice(0,3)}
                    </label>
                  ))}
                </div>
              )}

              {/* Time picker (all modes) */}
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
                <span style={{fontSize:11,color:'#2A7991',flexShrink:0}}>At</span>
                <select value={schedHour} onChange={e => setSchedHour(+e.target.value)} style={{...sel, flex:1}}>
                  {[6,7,8,9,10,11,12,13,14,15,16,17,18].map(h=><option key={h} value={h}>{fmtH(h)}</option>)}
                </select>
              </div>

              <button onClick={() => {
                const effectiveDays = schedMode === 'daily' ? [0,1,2,3,4,5,6] : schedDays
                gongScraperApi.setSchedule(schedMode, effectiveDays, schedHour)
                setSchedule({active:true, mode:schedMode, days:effectiveDays, hour:schedHour, nextRun:calcNextRun(effectiveDays,schedHour)})
              }}
                style={{display:'block',width:'100%',padding:'8px 10px',border:'none',borderRadius:6,background:'#469C6C',color:'#FFFBF5',fontWeight:700,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                Set Recurring Schedule
              </button>
            </div>
          ) : (
            <div style={{padding:'8px 12px',background:'var(--color-bg-card)',border:'1px solid #469C6C',borderRadius:8,marginBottom:10,fontSize:12}}>
              <div style={{display:'flex',alignItems:'center',gap:6,color:'#469C6C',fontWeight:600}}>
                <span style={{width:8,height:8,borderRadius:'50%',background:'#469C6C',display:'inline-block'}} />
                {schedule.mode === 'daily'
                  ? `Daily at ${fmtH(schedule.hour)}`
                  : schedule.mode === 'weekly'
                  ? `${DAY_NAMES[schedule.days[0] ?? 1]}s at ${fmtH(schedule.hour)}`
                  : `${schedule.days.map(d=>DAY_NAMES[d].slice(0,3)).join(', ')} at ${fmtH(schedule.hour)}`}
              </div>
              <div style={{fontSize:11,color:'#2A7991',marginTop:4}}>
                Next: {new Date(schedule.nextRun).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
              </div>
              <div style={{marginTop:8}}>
                <button onClick={() => { gongScraperApi.clearSchedule(); setSchedule(null) }}
                  style={{display:'block',width:'100%',padding:'8px 10px',border:'none',borderRadius:6,background:'#DA5039',color:'#FFFBF5',fontWeight:700,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                  Reset Schedule
                </button>
              </div>
            </div>
          )}

          {/* Login popup */}
          {loginService && (
            <div style={{marginBottom:10,padding:12,background:'#0D2137',border:'2px solid #F4B74E',borderRadius:8}}>
              <div style={{fontSize:13,fontWeight:700,color:'#F4B74E',marginBottom:6}}>
                {loginService === 'hubspot' ? 'HubSpot' : 'Gong'} Login Required
              </div>
              <div style={{fontSize:11,color:'#9CD4D6',marginBottom:10}}>
                Please log into {loginService === 'hubspot' ? 'HubSpot' : 'Gong'} in the background window. The scraper will continue automatically once you're logged in.
              </div>
              <button
                onClick={() => gongScraperApi.focusLoginWin()}
                style={{display:'block',width:'100%',padding:'9px 12px',border:'none',borderRadius:6,background:'#F4B74E',color:'#0D1525',fontWeight:700,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>
                Bring Login Window to Front
              </button>
            </div>
          )}

          <div data-help="Activity Log: shows real-time output from the scraper as it runs. All messages from the current session are kept here — they reset when you close the app or use Master Reset in the top bar.">
            <LogPanel logs={logs} />
          </div>
        </div>

        {/* RIGHT: links + recent transcripts */}
        <div style={{ width: 380, flexShrink: 0, padding: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', overflowY: 'auto' }}>

          {/* Master Spreadsheet button */}
          {sheetUrl ? (
            <button
              data-help="Master Spreadsheet: opens your Google Sheet that lists all companies imported from HubSpot. This sheet is also used by Step 3 to sort transcripts into company folders."
              onClick={() => fsApi.openExternal(sheetUrl)}
              style={{ border: '2px solid var(--color-teal-500)', background: 'rgba(86,183,163,0.08)', color: 'var(--color-teal-400)', cursor: 'pointer', borderRadius: 'var(--radius-lg)', padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '100%', textAlign: 'center' }}
            >
              <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="3" y1="15" x2="21" y2="15"/>
                <line x1="9" y1="9" x2="9" y2="21"/>
              </svg>
              <span style={{ fontSize: 'var(--text-md)', fontWeight: 700 }}>Master Spreadsheet</span>
              <span style={{ fontSize: 'var(--text-xs)', opacity: 0.7 }}>Open in Google Sheets</span>
            </button>
          ) : (
            <div style={{ border: '2px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', borderRadius: 'var(--radius-lg)', padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'default', width: '100%', textAlign: 'center' }}>
              <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="3" y1="15" x2="21" y2="15"/>
                <line x1="9" y1="9" x2="9" y2="21"/>
              </svg>
              <span style={{ fontSize: 'var(--text-md)', fontWeight: 700 }}>Master Spreadsheet</span>
              <span style={{ fontSize: 'var(--text-xs)', opacity: 0.7 }}>Run Step 1 to create</span>
            </div>
          )}

          {/* Transcripts Folder button */}
          {mainFolderUrl ? (
            <button
              onClick={() => fsApi.openExternal(mainFolderUrl)}
              style={{ border: '2px solid var(--color-teal-500)', background: 'rgba(86,183,163,0.08)', color: 'var(--color-teal-400)', cursor: 'pointer', borderRadius: 'var(--radius-lg)', padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '100%', textAlign: 'center' }}
            >
              <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span style={{ fontSize: 'var(--text-md)', fontWeight: 700 }}>Transcripts Folder</span>
              <span style={{ fontSize: 'var(--text-xs)', opacity: 0.7 }}>Open in Google Drive</span>
            </button>
          ) : (
            <div style={{ border: '2px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', borderRadius: 'var(--radius-lg)', padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'default', width: '100%', textAlign: 'center' }}>
              <svg viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span style={{ fontSize: 'var(--text-md)', fontWeight: 700 }}>Transcripts Folder</span>
              <span style={{ fontSize: 'var(--text-xs)', opacity: 0.7 }}>Run Step 1 to create</span>
            </div>
          )}

          {/* Recent Transcripts */}
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              Recent Transcripts
            </div>
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {recentTranscripts.length === 0 ? (
                <div style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                  No transcripts scraped yet.
                </div>
              ) : (() => {
                // Sort once, outside .map() so the index is stable and matches draftingFor
                const sorted = [...recentTranscripts].sort((a, b) => {
                  const da = new Date(a.callDate).getTime() || 0
                  const db = new Date(b.callDate).getTime() || 0
                  return db - da
                })
                return sorted.map((t, i) => (
                <div key={`${t.driveFileId || i}_${t.callDate}`} style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.3 }}>{t.title}</div>
                  {t.companyName && (() => {
                    const coId = companiesByName[t.companyName.toLowerCase()]
                    return coId
                      ? <button onClick={() => navigate(`/companies/${coId}`)} style={{ fontSize: 'var(--text-xs)', color: 'var(--color-teal-400)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', textDecoration: 'underline' }}>{t.companyName}</button>
                      : <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-teal-400)' }}>{t.companyName}</div>
                  })()}
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{t.callDate}</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                    {t.callUrl && (
                      <button onClick={() => fsApi.openExternal(t.callUrl!)} style={{ fontSize: 10, color: '#9B6DFF', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                        Open in Gong →
                      </button>
                    )}
                    <button
                      onClick={() => fsApi.openExternal(
                        t.driveUrl && t.driveUrl.length > 0
                          ? t.driveUrl
                          : `https://drive.google.com/drive/search?q=${encodeURIComponent(t.title)}`
                      )}
                      style={{ fontSize: 10, color: '#469C6C', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                    >
                      Open Transcript →
                    </button>
                    <button
                      onClick={() => draftingFor === i ? setDraftingFor(null) : draftFollowUp(t, i)}
                      disabled={draftRunning && draftingFor !== i}
                      style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: draftingFor === i ? '#56B7A3' : 'var(--color-text-muted)', background: 'none', border: `1px solid ${draftingFor === i ? 'rgba(86,183,163,0.5)' : 'var(--color-border)'}`, borderRadius: 4, cursor: draftRunning && draftingFor !== i ? 'not-allowed' : 'pointer', padding: '2px 7px', opacity: draftRunning && draftingFor !== i ? 0.4 : 1 }}
                    >
                      <Mail size={9} /> {draftingFor === i && draftRunning ? 'Drafting…' : 'Draft Follow-Up Email'}
                    </button>
                  </div>
                  {/* Inline email draft panel — only renders for the clicked card (keyed by index) */}
                  {draftingFor === i && (
                    <div style={{ marginTop: 8, padding: '10px 12px', background: 'rgba(86,183,163,0.06)', border: '1px solid rgba(86,183,163,0.2)', borderRadius: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#56B7A3', textTransform: 'uppercase', letterSpacing: '0.06em' }}>B.O.B. Follow-Up Draft</span>
                        <button onClick={() => { setDraftingFor(null); setDraftText(''); if (draftTimeoutRef.current) clearTimeout(draftTimeoutRef.current) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 2 }}>
                          <X size={12} />
                        </button>
                      </div>
                      {draftRunning && !draftText && (
                        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#56B7A3', animation: 'pulse 1s infinite' }} />
                          Drafting email…
                        </div>
                      )}
                      {draftText && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--color-text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {draftText}
                            {draftRunning && <span style={{ display: 'inline-block', width: 6, height: 11, background: '#56B7A3', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'pulse 1s infinite' }} />}
                          </div>
                          {!draftRunning && (
                            <button
                              onClick={() => { navigator.clipboard.writeText(draftText).then(() => { setDraftCopied(true); setTimeout(() => setDraftCopied(false), 1800) }) }}
                              style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, padding: '3px 9px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', fontSize: 10, cursor: 'pointer' }}
                            >
                              {draftCopied ? <><Check size={10} style={{ color: '#34A853' }} /> Copied!</> : <><Copy size={10} /> Copy Email</>}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))
              })()}
            </div>
          </div>

          {/* Clear Recent Calls */}
          {recentTranscripts.length > 0 && (
            <button
              onClick={() => {
                gongScraperApi.clearTranscripts()
                setRecentTranscripts([])
              }}
              style={{ width: '100%', padding: '9px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center' }}
            >
              Clear Recent Calls
            </button>
          )}

        </div>
      </div>
    </div>
  )

  function handleAssign() {
    if (!assignVal.trim() || !curUnfiled) return
    gongScraperApi.moveFile(curUnfiled.id, assignVal.trim())
    setAssignVal('')
  }
  function handleSkip() { setUnfiledIdx(i => i + 1) }

  async function draftFollowUp(
    t: { title: string; companyName: string; callDate: string; driveFileId: string },
    idx: number,
  ) {
    if (draftRunning) return
    setDraftingFor(idx)   // key by index, never by driveFileId (which may be '' for many cards)
    setDraftText('')
    setDraftRunning(true)
    setDraftCopied(false)
    draftRawRef.current = ''

    if (draftUnsubRef.current) { draftUnsubRef.current(); draftUnsubRef.current = null }
    if (draftTimeoutRef.current) { clearTimeout(draftTimeoutRef.current); draftTimeoutRef.current = null }

    // ── 1. Check AI model ────────────────────────────────────────────────────
    const statusRes = await localAiApi.getStatus().catch(() => null)
    if (!statusRes?.ok || !statusRes.data?.downloaded) {
      setDraftText('AI model not downloaded. Go to Settings → Local AI Model to download it first.')
      setDraftRunning(false)
      return
    }
    if (statusRes.data.loadState !== 'ready') {
      setDraftText('Loading model…')
      await localAiApi.load().catch(() => {})
      const after = await localAiApi.getStatus().catch(() => null)
      if (!after?.ok || after.data?.loadState !== 'ready') {
        setDraftText('Model failed to load. Check Settings → Local AI.')
        setDraftRunning(false)
        return
      }
      setDraftText('')
    }

    // ── 2. Fetch actual transcript text from Drive ────────────────────────────
    setDraftText('Reading transcript…')
    let transcriptBody = ''
    if (t.driveFileId) {
      const fileRes = await gongScraperApi.readFile(t.driveFileId).catch(() => null)
      if (fileRes?.ok && fileRes.data?.text) {
        // Cap at 1 500 chars ≈ 375 tokens — leaves plenty of room in the 8k window
        // for the system prompt, user message, thinking, and full response.
        transcriptBody = fileRes.data.text.slice(0, 1500)
      }
    }
    setDraftText('')

    // ── 3. Build prompt ───────────────────────────────────────────────────────
    // Keep it tight: system prompt + this prompt + transcript must stay well under 8192 tokens.
    const transcriptSection = transcriptBody
      ? `\n\nTranscript:\n${transcriptBody}`
      : ''

    const requestId = `draft-email-${++draftCounterRef.current}`

    // 90s hard timeout in case the model deadlocks on context overflow
    draftTimeoutRef.current = setTimeout(() => {
      if (draftUnsubRef.current) { draftUnsubRef.current(); draftUnsubRef.current = null }
      draftTimeoutRef.current = null
      const partial = draftRawRef.current.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      setDraftText(partial || 'The model took too long. Try again.')
      setDraftRunning(false)
    }, 90_000)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    draftUnsubRef.current = (push as any).onAiChunk((payload: { requestId: string; chunk: string; done: boolean }) => {
      if (payload.requestId !== requestId) return
      if (payload.done) {
        if (draftTimeoutRef.current) { clearTimeout(draftTimeoutRef.current); draftTimeoutRef.current = null }
        const final = draftRawRef.current.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        setDraftText(final || draftRawRef.current.trim())
        setDraftRunning(false)
        if (draftUnsubRef.current) { draftUnsubRef.current(); draftUnsubRef.current = null }
        return
      }
      draftRawRef.current += payload.chunk
      const stripped = draftRawRef.current.replace(/<think>[\s\S]*?<\/think>/gi, '')
      const hasOpenThink = stripped.lastIndexOf('<think>') > stripped.lastIndexOf('</think>')
      setDraftText(hasOpenThink ? stripped.slice(0, stripped.lastIndexOf('<think>')) : stripped)
    })

    await localAiApi.complete({
      requestId,
      prompt: `Write a follow-up email after a call with ${t.companyName || 'the customer'} on ${t.callDate || 'today'} titled "${t.title}".${transcriptSection}\n\nWrite a short, warm follow-up email (3-5 sentences). Reference specific topics or action items from the transcript. Sign off as their Prokeep CSM.`,
      systemPrompt: 'You are a B2B customer success manager at Prokeep. Write brief, specific follow-up emails. Plain text only, no subject line, no markdown.',
    }).catch(err => {
      if (draftTimeoutRef.current) { clearTimeout(draftTimeoutRef.current); draftTimeoutRef.current = null }
      setDraftText('Error: ' + (err instanceof Error ? err.message : 'Request failed.'))
      setDraftRunning(false)
      if (draftUnsubRef.current) { draftUnsubRef.current(); draftUnsubRef.current = null }
    })
  }
}

function Sub({ children }: { children: React.ReactNode }) {
  return <span style={{display:'block',fontSize:10.5,fontWeight:400,opacity:0.7,marginTop:3,lineHeight:1.4}}>{children}</span>
}

function StepBtn({ n, color, disabled, onClick, help, children }: { n:number; color:string; disabled?:boolean; onClick:()=>void; help?:string; children:React.ReactNode }) {
  return (
    <button disabled={disabled} onClick={onClick} data-help={help}
      style={{display:'block',width:'100%',padding:'12px 14px 12px 40px',marginBottom:8,border:'none',borderRadius:8,background:disabled?'#9CD4D6':color,color:'#FFFBF5',fontWeight:700,fontSize:14,cursor:disabled?'not-allowed':'pointer',textAlign:'left',position:'relative',fontFamily:'inherit'}}>
      <span style={{position:'absolute',left:12,top:'50%',transform:'translateY(-50%)',width:22,height:22,borderRadius:'50%',background:'rgba(255,255,255,0.2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:800,lineHeight:'1'}}>{n}</span>
      {children}
    </button>
  )
}

const sel: React.CSSProperties = { flex:1,minWidth:0,padding:'7px 6px',fontFamily:'inherit',fontSize:12,color:'var(--color-text-primary)',background:'var(--color-bg-surface)',border:'1px solid #57A7B9',borderRadius:6,outline:'none',cursor:'pointer' }
