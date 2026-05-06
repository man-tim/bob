import { useState, useEffect } from 'react'
import { Plus, Copy, Trash2, Save, Check, ExternalLink } from 'lucide-react'
import { Button, Card } from '../../components/ui'
import { promptsApi, fsApi, type SavedPrompt } from '../../lib/ipc'
import { useUIStore } from '../../store/ui.store'
import { ulid } from 'ulid'

// ─── Built-in prompts (from ScrubAndSplit.html) ───────────────────────────────

const BUILTIN_PROMPTS = [
  {
    title: 'Full Account Analysis',
    text: `Comprehensively analyze [ACCOUNT NAME]'s messaging data, then give me total volume, sent/received split, branch-by-branch volume, top reps, themes, attachment rate, BTM usage, trend direction, and any risk or engagement flags - then combine that data into a single Usage and Trend Report document representing the whole account. Within that same report, also include how much money in quotes has been facilitated through all of the messages in the account. When gathering quote data, ignore spam, only focus on real quotes where a dollar amount was suggested to a customer or brought up somewhere within the conversation. Doesn't have to be an approved quote, just facilitated in some way through Prokeep.`,
  },
  {
    title: 'Executive Summary',
    text: `Review [ACCOUNT NAME]'s Prokeep messaging data and write a tight executive summary - one page, narrative format, suitable for leadership. Lead with the headline number, tell the story of how this account is using Prokeep, whether they are healthy or at risk, and what the single most important takeaway is. Keep it direct and avoid bullet-point lists - this should read like a concise business brief.`,
  },
  {
    title: 'Rep Performance Breakdown',
    text: `Analyze the rep-level activity in [ACCOUNT NAME]'s Prokeep messaging data. For each rep, show total message volume, outbound vs. inbound breakdown, average response patterns, and thread activity. Identify who is most active, who has gone quiet or shows declining engagement, and flag any reps worth recognizing for strong performance or flagging for coaching conversations. Present findings as a ranked breakdown by activity level.`,
  },
  {
    title: 'BTM Usage Report',
    text: `Focus exclusively on broadcast text messaging activity in [ACCOUNT NAME]'s Prokeep data. Identify how many BTM messages were sent, which branches sent them, estimated recipient reach where inferable, and any patterns in timing or content type. Assess whether BTM is being used consistently or sporadically, and note whether there are branches not using it at all. Summarize with a recommendation on where BTM adoption could be strengthened.`,
  },
  {
    title: 'Upsell & Expansion Opportunities',
    text: `Review [ACCOUNT NAME]'s Prokeep usage data and identify upsell and expansion opportunities. Look for features with low or no adoption, branches with high message volume that may benefit from additional seats or capabilities, and usage patterns that suggest readiness for Growth Hub, integrations, or other add-ons. Frame each opportunity with the supporting data and a recommended conversation angle for the account team.`,
  },
  {
    title: 'CSAT & Sentiment Signals',
    text: `Analyze [ACCOUNT NAME]'s Prokeep messaging data for customer satisfaction and sentiment signals. Look at response time patterns, thread length and resolution patterns, message tone where readable, and any recurring friction points or complaints visible in the conversations. Flag any red flags - unanswered threads, escalating language, or high-volume complaint patterns. Summarize with an overall sentiment assessment and any specific areas to address.`,
  },
  {
    title: 'QBR Talking Points',
    text: `Pull the 5 to 7 most compelling data points from [ACCOUNT NAME]'s Prokeep messaging data to use in a quarterly business review. For each talking point, state the metric or finding, explain why it matters, and frame it as either a win to celebrate, a trend to highlight, or a forward-looking recommendation. Output should be structured as ready-to-use QBR talking points that a Prokeep employee could bring directly into a customer conversation.`,
  },
  {
    title: 'Mid-Year Review + Deck',
    text: `You are going to do two things with the [ACCOUNT NAME] Prokeep data I am uploading.\n\nFirst, conduct a full mid-year review analysis. Cover total message volume, sent/received split, branch-by-branch performance, top and lowest-activity reps, thread and response trends, BTM usage, attachment rate, quotes facilitated, any risk flags, and a half-year trend direction assessment. Write this up as a structured Mid-Year Review report with clear sections.\n\nSecond, using that analysis, build a complete PowerPoint presentation deck for the mid-year review.`,
  },
  {
    title: 'Risk Assessment',
    text: `Analyze [ACCOUNT NAME]'s messaging data with the sole objective of identifying at-risk companies, branches, and locations within the book of business.\nProduce a Risk Assessment Report that:\n\n1. Identifies At-Risk Entities\n• List all companies, branches, and locations considered at risk\n• Assign a risk level (High / Medium / Low) to each\n• Clearly include the location/branch name for every flagged item\n\n2. Explains Risk Drivers\nFor each at-risk entity, specify the exact reasons, such as:\n• Declining or low message volume\n• Poor response/engagement rates\n• Rep inactivity or inconsistency\n• Low or absent quote activity\n• Sudden drops or abnormal usage patterns\n\n3. Quote-Based Risk Signals\n• Identify entities with low, declining, or no quote activity\n• Include total $ value of legitimate quotes discussed (ignore spam)\n• Highlight where messaging is not translating into revenue conversations\n\n4. Rep-Level Risk Contribution\n• Identify reps contributing to risk (low activity, poor engagement, missed opportunities)\n• Map reps to the specific branches/locations they impact\n\n5. Prioritized Risk Summary\n• Rank the top at-risk companies and locations\n• Call out the most urgent risks requiring action\n• Briefly note potential causes (adoption issue, behavior issue, or business decline)\n\nDo not include general usage summaries or trend reports unless they directly support a risk conclusion. Focus only on actionable risk identification and explanation.`,
  },
  {
    title: 'Expansion Assessment',
    text: `Analyze [ACCOUNT NAME]'s messaging data with the sole objective of identifying expansion opportunities within the book of business, including companies that are strong candidates for adding branches, increasing adoption, or upgrading their plan.\nProduce an Expansion Opportunity Report that includes:\n\n1. High-Potential Companies for Expansion\n• Identify companies that show strong engagement and are candidates to:\n  ○ Add additional branches/locations\n  ○ Expand usage across more teams or users\n  ○ Upgrade to a higher-tier plan\n• Include the company name and associated locations/branches\n• Assign an expansion potential level (High / Medium / Low)\n\n2. Expansion Signals & Justification\nFor each company, explain why it is a strong expansion candidate using signals such as:\n• High or consistently growing message volume\n• Strong engagement (active conversations, responsiveness)\n• High attachment usage or workflow adoption\n• Consistent quote activity and dollar volume\n• Concentrated usage in one branch that could be replicated elsewhere\n• Evidence of unmet demand (e.g., heavy usage by a few reps, overflow patterns)\n\n3. Branch & Location Expansion Opportunities\n• Identify companies where:\n  ○ Only some locations are active while others are underutilized or inactive\n  ○ A single high-performing branch indicates potential rollout to additional locations\n• Call out specific locations that could be added or activated\n\n4. Plan Upgrade Opportunities\n• Highlight companies likely to benefit from a plan upgrade based on:\n  ○ Usage nearing limits or scaling rapidly\n  ○ Advanced feature adoption (attachments, BTM, etc.)\n  ○ High volume of revenue-generating conversations (quotes)\n\n5. Revenue Expansion Signals\n• Estimate total $ value of quotes facilitated through messaging (ignore spam)\n• Identify companies where messaging is clearly driving revenue and could justify deeper investment\n\n6. Prioritized Expansion Targets\n• Rank the top companies and locations for expansion\n• For each, recommend a specific action:\n  ○ Add X branches\n  ○ Roll out to additional teams\n  ○ Upgrade plan tier\n• Focus on the highest-impact opportunities first\n\nDo not include general usage summaries unless they directly support an expansion recommendation. Focus only on identifying and justifying growth opportunities.`,
  },
]

// ─── Shared panel (used standalone and embedded in ScrubSplit) ───────────────

export function PromptLibraryPanel({ initialAccountName = '' }: { initialAccountName?: string } = {}) {
  const addToast  = useUIStore(s => s.addToast)
  const [saved,     setSaved]     = useState<SavedPrompt[]>([])
  const [accountName, setAccountName] = useState(initialAccountName)

  // If the parent updates initialAccountName (e.g. after a scrub completes), sync it in
  useEffect(() => {
    if (initialAccountName) setAccountName(initialAccountName)
  }, [initialAccountName])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [copied,    setCopied]    = useState(false)
  const [newTitle,  setNewTitle]  = useState('')
  const [newText,   setNewText]   = useState('')
  const [adding,    setAdding]    = useState(false)
  const [saving,    setSaving]    = useState(false)

  useEffect(() => {
    promptsApi.get().then(r => { if (r.ok) setSaved(r.data) })
  }, [])

  // Combine built-in + saved into one flat list for the dropdown
  const allPrompts = [
    ...BUILTIN_PROMPTS.map(p => ({ ...p, isBuiltin: true,  id: '' })),
    ...saved.map(p          => ({ ...p,  isBuiltin: false, id: p.id })),
  ]

  const safeIdx   = Math.min(selectedIdx, allPrompts.length - 1)
  const current   = allPrompts[safeIdx]
  const resolved  = current
    ? (accountName ? current.text.replace(/\[ACCOUNT NAME\]/g, accountName) : current.text)
    : ''

  function handleCopy() {
    navigator.clipboard.writeText(resolved)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleSave() {
    if (!newTitle.trim() || !newText.trim()) return
    setSaving(true)
    const updated = [...saved, { id: ulid(), title: newTitle.trim(), text: newText.trim() }]
    await promptsApi.set(updated)
    setSaved(updated)
    setNewTitle('')
    setNewText('')
    setAdding(false)
    setSaving(false)
    addToast({ title: 'Prompt saved', level: 'ok' })
  }

  async function handleDelete(id: string) {
    const updated = saved.filter(p => p.id !== id)
    await promptsApi.set(updated)
    setSaved(updated)
    setSelectedIdx(0)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
    color: 'var(--color-text-primary)', fontSize: 'var(--text-sm)',
    padding: '7px 10px', outline: 'none', boxSizing: 'border-box',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>

      {/* Account name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>Account name:</span>
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 120 }}
          placeholder="e.g. Westwater Supply"
          value={accountName}
          onChange={e => setAccountName(e.target.value)}
        />
        {accountName && (
          <button onClick={() => setAccountName('')} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
            Clear
          </button>
        )}
      </div>

      {/* Prompt selector dropdown */}
      <select
        value={safeIdx}
        onChange={e => setSelectedIdx(+e.target.value)}
        style={{ ...inputStyle, cursor: 'pointer' }}
      >
        {allPrompts.map((p, i) => (
          <option key={i} value={i}>
            {p.isBuiltin ? '' : '★ '}{p.title}
          </option>
        ))}
      </select>

      {/* Prompt preview textarea */}
      <textarea
        readOnly
        value={resolved}
        style={{
          ...inputStyle,
          height: 160,
          resize: 'vertical',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          color: 'var(--color-text-secondary)',
        }}
      />

      {/* Actions row */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Button variant="primary" size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={handleCopy} style={{ flex: 1, minWidth: 100 }}>
          {copied ? 'Copied!' : 'Copy Prompt'}
        </Button>
        <Button variant="ghost" size="sm" icon={<ExternalLink size={13} />} onClick={() => fsApi.openExternal('https://claude.ai/')}>
          Open Claude
        </Button>
        {current && !current.isBuiltin && (
          <button
            onClick={() => handleDelete(current.id)}
            title="Delete this saved prompt"
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 12 }}
          >
            <Trash2 size={12} /> Delete
          </button>
        )}
      </div>

      {/* Save custom prompt */}
      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
        {!adding ? (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)} icon={<Plus size={13} />}>
            Save Custom Prompt
          </Button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>New Prompt</div>
            <input
              style={inputStyle}
              placeholder="Prompt title"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
            />
            <textarea
              style={{ ...inputStyle, height: 120, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Prompt text… use [ACCOUNT NAME] as a placeholder"
              value={newText}
              onChange={e => setNewText(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="primary" size="sm" loading={saving} onClick={handleSave} icon={<Save size={13} />}>Save</Button>
              <Button variant="secondary" size="sm" onClick={() => { setAdding(false); setNewTitle(''); setNewText('') }}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function PromptLibrary() {
  return (
    <div className="page animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Prompt Library</h1>
          <p className="page-subtitle">Claude prompts for Prokeep account analysis — replace [ACCOUNT NAME] with the company</p>
        </div>
      </div>
      <PromptLibraryPanel />
    </div>
  )
}
