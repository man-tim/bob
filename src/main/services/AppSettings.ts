import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

export interface QuickLink {
  url:    string
  label:  string
  sub?:   string
  color:  string
}

export interface SavedPrompt {
  id:    string
  title: string
  text:  string
}

interface AppSettingsData {
  quickLinks?:    QuickLink[]
  savedPrompts?:  SavedPrompt[]
}

const SETTINGS_FILE = join(app.getPath('userData'), 'app-settings.json')

function load(): AppSettingsData {
  try {
    if (!existsSync(SETTINGS_FILE)) return {}
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) as AppSettingsData
  } catch { return {} }
}

function save(data: AppSettingsData): void {
  writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

const DEFAULT_QUICK_LINKS: QuickLink[] = [
  { url: 'https://app.hubspot.com/contacts/8787210/objects/0-2/views/40948819/list?prefetch=', label: 'HubSpot',        color: '#E8671C' },
  { url: 'https://us-57015.app.gong.io/home',                                                  label: 'Gong',           color: '#7C3AED' },
  { url: 'https://ws.planhat.com/login',                                                        label: 'Planhat',        color: '#E2E8F0' },
  { url: 'https://metabase.bi.prokeep.com/dashboard/29-account-engagement-dashboard?account_id=&account_internal_name=&account_name=&csm=&group%252Flocation_name=&group_id=&tab=85-account-portfolio', label: 'CSM Dash (MB)', sub: 'Metabase', color: '#64748B' },
  { url: 'https://metabase.bi.prokeep.com/question#eyJkYXRhc2V0X3F1ZXJ5Ijp7ImRhdGFiYXNlIjo1LCJ0eXBlIjoicXVlcnkiLCJxdWVyeSI6eyJzb3VyY2UtdGFibGUiOjQ1MH19LCJkaXNwbGF5IjoidGFibGUiLCJ2aXN1YWxpemF0aW9uX3NldHRpbmdzIjp7fX0=', label: 'Blueprint (MB)', sub: 'Messages', color: '#64748B' },
  { url: 'https://www.loom.com/home',                                                           label: 'Loom',           color: '#5B5BD6' },
  { url: 'https://share.hsforms.com/2DvfL5wQnSDGSKaPu3NnKMQ58c96?hsCtaAttrib=188879018261',    label: 'Support Ticket', color: '#DC2626' },
]

export const AppSettings = {
  getQuickLinks(): QuickLink[] {
    const data = load()
    return data.quickLinks ?? DEFAULT_QUICK_LINKS
  },

  setQuickLinks(links: QuickLink[]): void {
    save({ ...load(), quickLinks: links })
  },

  getSavedPrompts(): SavedPrompt[] {
    return load().savedPrompts ?? []
  },

  setSavedPrompts(prompts: SavedPrompt[]): void {
    save({ ...load(), savedPrompts: prompts })
  },
}
