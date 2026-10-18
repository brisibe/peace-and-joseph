import { createTelegramNotifier } from './telegram.js'

const MAX_BYTES = 12000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function validateReservation(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  for (const field of ['name', 'email', 'attending', 'guests', 'submissionId']) {
    if (typeof data[field] !== 'string') return null
  }
  for (const field of ['phone', 'message', 'website', 'additionalGuestName']) {
    if (data[field] !== undefined && typeof data[field] !== 'string') return null
  }
  const name = data.name.trim()
  const email = data.email.trim()
  const phone = (data.phone ?? '').trim()
  const message = (data.message ?? '').trim()
  const guests = Number(data.guests)
  const needsGuestName = data.attending === 'yes' && guests === 2
  const additionalGuestName = (data.additionalGuestName ?? '').trim()
  const digits = phone.replace(/\D/g, '').length
  if (data.website || !name || name.length > 100 || message.length > 1000
    || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || (phone && (phone.length > 32 || !/^\+?[\d ()-]+$/.test(phone) || digits < 7 || digits > 15))
    || !['yes', 'no'].includes(data.attending) || !/^\d$/.test(data.guests)
    || (data.attending === 'yes' ? guests < 1 || guests > 2 : guests !== 0)
    || (needsGuestName && (!additionalGuestName || additionalGuestName.length > 100))
    || !uuid.test(data.submissionId)) return null
  return { submission_id: data.submissionId, name, email, phone, message, attending: data.attending, guests,
    additional_guest_name: needsGuestName ? additionalGuestName : null }
}

// Read a bounded stream rather than trusting Content-Length supplied by the caller.
async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new Error('TOO_LARGE')
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

/**
 * @param {{ databaseUrl?: string, databaseKey?: string, allowedOrigins?: string[],
 *   telegramBotToken?: string, telegramChatId?: string,
 *   fetcher?: typeof fetch, logger?: (code: string) => void }} [options]
 */
export function createReservationHandler({ databaseUrl, databaseKey, allowedOrigins = [],
  telegramBotToken, telegramChatId, fetcher = fetch,
  logger = (code) => console.warn('RSVP submission failed:', code) } = {}) {
  const notify = createTelegramNotifier({ botToken: telegramBotToken, chatId: telegramChatId, fetcher, logger })
  return async function handleReservation(request) {
    const origin = request.headers.get('origin')
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    if (origin && allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
      headers['Access-Control-Allow-Headers'] = 'content-type'
    }
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers })
    const fail = (status, code) => { logger(code); return reply(status, { ok: false, code }) }
    if (!databaseUrl || !databaseKey || !allowedOrigins.length) return fail(503, 'CONFIG_MISSING')
    // CORS limits browser origins, not non-browser callers or spam.
    if (origin && !allowedOrigins.includes(origin)) return fail(403, 'INVALID_REQUEST')
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return fail(405, 'INVALID_REQUEST')
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return fail(415, 'INVALID_REQUEST')
    }
    let data
    try { data = JSON.parse(await readBody(request)) } catch (error) {
      return fail(error.message === 'TOO_LARGE' ? 413 : 400, 'INVALID_REQUEST')
    }
    const row = validateReservation(data)
    if (!row) return fail(422, 'INVALID_RESERVATION')
    let response
    try {
      // PostgREST translates ignore-duplicates into INSERT ... ON CONFLICT DO NOTHING.
      // The primary key makes retries safe even across concurrent function instances.
      const dbHeaders = { apikey: databaseKey, 'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation' }
      // Local Supabase uses a legacy service-role JWT; hosted secret keys use apikey only.
      if (!databaseKey.startsWith('sb_secret_')) dbHeaders.Authorization = `Bearer ${databaseKey}`
      response = await fetcher(`${databaseUrl.replace(/\/$/, '')}/rest/v1/reservations?on_conflict=submission_id&select=submission_id,received_at`, {
        method: 'POST', headers: dbHeaders, body: JSON.stringify(row), signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) {
        return fail(response.status === 429 ? 503 : response.status >= 500 ? 503 : 500,
          response.status === 429 ? 'SERVICE_BUSY' : response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'SAVE_FAILED')
      }
    } catch {
      return fail(503, 'SERVICE_UNAVAILABLE')
    }
    // The write has succeeded. Representation/Telegram failures must never turn
    // a saved RSVP into an error or cause the browser to resubmit guest details.
    try {
      const inserted = await response.json()
      if (!Array.isArray(inserted)) throw new Error('Invalid insert representation')
      if (inserted.length !== 0) {
        if (inserted.length !== 1
          || typeof inserted[0]?.submission_id !== 'string'
          || inserted[0].submission_id.toLowerCase() !== data.submissionId.toLowerCase()
          || typeof inserted[0].received_at !== 'string'
          || !Number.isFinite(Date.parse(inserted[0].received_at))) {
          throw new Error('Invalid insert representation')
        }
        await notify(row, inserted[0].received_at)
      }
      // An empty representation is a duplicate: confirm without another alert.
    } catch {
      logger('NOTIFICATION_INSERT_UNCONFIRMED')
    }
    return reply(200, { ok: true, submissionId: data.submissionId })
  }
}
