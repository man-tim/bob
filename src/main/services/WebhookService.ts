/* WebhookService — proxies all Apps Script webhook calls with the user's Google OAuth token.
 * Mirrors the background.js `apiCall()` function exactly.
 */

import { AuthService } from '../auth/AuthService'

const WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbwf4axqToemuIkm3WMbHezzlnzPM9QWNscn3b3-k2BJzIJLV2ewM9UNzCIEu3Kp_rI5/exec'

export const WebhookService = {
  async call(action: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = await AuthService.getAuthClient()
    const token  = client.credentials.access_token
    if (!token) throw new Error('No access token — please connect to Google first.')

    const payload = { ...action, accessToken: token }
    const res  = await fetch(WEBHOOK_URL, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify(payload),
      redirect: 'follow',
    })
    const text = await res.text()
    try { return JSON.parse(text) as Record<string, unknown> }
    catch { return { status: 'error', raw: text.slice(0, 300) } }
  },
}
