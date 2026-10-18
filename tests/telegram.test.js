import test from 'node:test'
import assert from 'node:assert/strict'
import { createReservationHandler } from '../supabase/functions/submit-reservation/handler.js'
import { formatTelegramMessage } from '../supabase/functions/submit-reservation/telegram.js'

const endpoint = 'https://example.supabase.co/functions/v1/submit-reservation'
const origin = 'http://localhost:5173'
const botToken = '123456:TEST_PRIVATE_TOKEN'
const chatId = '-100123456789'
const receivedAt = '2026-10-18T15:00:00Z'
const data = { submissionId: '01234567-89ab-4cde-8fab-0123456789ab', name: 'Ada <Guest>',
  email: 'ada@example.com', phone: '08031234567', attending: 'yes', guests: '2',
  additionalGuestName: 'Grace Guest', message: 'Hello *everyone* https://example.com', website: '' }
const request = (payload = data) => new Request(endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(payload),
})
const inserted = () => Response.json([{ submission_id: data.submissionId, received_at: receivedAt }], { status: 201 })
const isDatabase = url => new URL(url).hostname === 'example.supabase.co'
function makeHandler(options = {}) {
  return createReservationHandler({ databaseUrl: 'https://example.supabase.co', databaseKey: 'sb_secret_test',
    allowedOrigins: [origin], telegramBotToken: botToken, telegramChatId: chatId, logger() {}, ...options })
}
async function assertConfirmed(reply) {
  assert.equal(reply.status, 200)
  assert.equal(reply.headers.get('Access-Control-Allow-Origin'), origin)
  assert.deepEqual(await reply.json(), { ok: true, submissionId: data.submissionId })
}

test('new RSVP sends one plain-text alert after insertion, with Lagos time and private server credentials', async () => {
  const calls = []
  const logs = []
  const handler = makeHandler({ logger: code => logs.push(code), fetcher: async (url, options) => {
    calls.push(url)
    if (isDatabase(url)) {
      assert.equal(options.headers.Prefer, 'resolution=ignore-duplicates,return=representation')
      assert.equal(new URL(url).searchParams.get('select'), 'submission_id,received_at')
      return inserted()
    }
    assert.equal(calls.length, 2)
    assert.equal(url, `https://api.telegram.org/bot${botToken}/sendMessage`)
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.headers.apikey, undefined)
    const payload = JSON.parse(options.body)
    assert.equal(payload.chat_id, chatId)
    assert.equal(payload.parse_mode, undefined)
    assert.deepEqual(payload.link_preview_options, { is_disabled: true })
    for (const text of [data.name, data.additionalGuestName, data.email, data.phone, data.message,
      data.submissionId, 'Accepts', 'Party size: 2', '18 Oct 2026', '16:00:00 (Lagos)']) {
      assert.ok(payload.text.includes(text), `Missing message field: ${text}`)
    }
    assert.ok(payload.text.length < 4096)
    assert.ok(options.signal instanceof AbortSignal)
    return Response.json({ ok: true })
  } })
  await assertConfirmed(await handler(request()))
  assert.equal(calls.length, 2)
  assert.deepEqual(logs, [])
})

test('declines and single attendees omit additional name and empty optional fields from alerts', async () => {
  for (const changes of [{ attending: 'no', guests: '0' }, { guests: '1' }]) {
    const handler = makeHandler({ fetcher: async (url, options) => {
      if (isDatabase(url)) return inserted()
      const text = JSON.parse(options.body).text
      assert.equal(text.includes('Additional guest:'), false)
      assert.equal(text.includes('Phone:'), false)
      assert.equal(text.includes('Message:'), false)
      assert.ok(text.includes(changes.attending === 'no' ? 'Declines' : 'Accepts'))
      return Response.json({ ok: true })
    } })
    await assertConfirmed(await handler(request({ ...data, ...changes, phone: '', message: '' })))
  }
})

test('duplicate insert representations do not trigger alerts, including simultaneous retries', async () => {
  let saved = false
  let alerts = 0
  const handler = makeHandler({ fetcher: async url => {
    if (isDatabase(url)) {
      if (saved) return Response.json([])
      saved = true
      return inserted()
    }
    alerts++
    return Response.json({ ok: true })
  } })
  const replies = await Promise.all(Array.from({ length: 8 }, () => handler(request())))
  for (const reply of replies) await assertConfirmed(reply)
  assert.equal(alerts, 1)
  await assertConfirmed(await handler(request()))
  assert.equal(alerts, 1)
})

test('validation errors and database failures never call Telegram', async () => {
  let writes = 0
  const handler = makeHandler({ fetcher: async url => {
    assert.ok(isDatabase(url), 'Telegram must not be called')
    writes++
    return new Response('private database detail', { status: 400 })
  } })
  assert.equal((await handler(request({ ...data, name: '' }))).status, 422)
  assert.equal(writes, 0)
  assert.equal((await handler(request())).status, 500)
  assert.equal(writes, 1)
})

test('missing Telegram configuration skips notification without affecting the saved RSVP', async () => {
  for (const options of [{ telegramBotToken: undefined }, { telegramChatId: undefined }]) {
    const logs = []
    let calls = 0
    const handler = makeHandler({ ...options, logger: code => logs.push(code), fetcher: async url => {
      assert.ok(isDatabase(url))
      calls++
      return inserted()
    } })
    await assertConfirmed(await handler(request()))
    assert.equal(calls, 1)
    assert.deepEqual(logs, ['TELEGRAM_CONFIG_MISSING'])
  }
})

test('Telegram rejection, malformed JSON, and network errors preserve success and log only safe codes', async () => {
  for (const [send, code] of [
    [async () => new Response('private provider error', { status: 429 }), 'TELEGRAM_REJECTED'],
    [async () => Response.json({ ok: false, description: 'private provider error' }), 'TELEGRAM_UNCONFIRMED'],
    [async () => new Response('not JSON'), 'TELEGRAM_REQUEST_FAILED'],
    [async () => { throw new Error(`Token leaked in URL: ${botToken}`) }, 'TELEGRAM_REQUEST_FAILED'],
    [async () => { throw new DOMException('private timeout', 'TimeoutError') }, 'TELEGRAM_TIMEOUT'],
  ]) {
    const logs = []
    let alerts = 0
    const handler = makeHandler({ logger: code => logs.push(code), fetcher: async url => {
      if (isDatabase(url)) return inserted()
      alerts++
      return send()
    } })
    await assertConfirmed(await handler(request()))
    assert.equal(alerts, 1, 'Failed alerts must not be retried')
    assert.deepEqual(logs, [code])
  }
})

test('successful writes with unreadable or unrecognized representations skip notification and still confirm', async () => {
  for (const dbReply of [() => new Response('not JSON', { status: 201 }), () => Response.json(null),
    () => Response.json({}), () => Response.json([{ submission_id: 'wrong', received_at: receivedAt }]),
    () => Response.json([{ submission_id: data.submissionId, received_at: 'invalid' }]),
    () => Response.json([{ submission_id: data.submissionId, received_at: receivedAt }, {}])]) {
    const logs = []
    const handler = makeHandler({ logger: code => logs.push(code), fetcher: async url => {
      assert.ok(isDatabase(url), 'Unconfirmed inserts must not trigger an alert')
      return dbReply()
    } })
    await assertConfirmed(await handler(request()))
    assert.deepEqual(logs, ['NOTIFICATION_INSERT_UNCONFIRMED'])
  }
})

test('Telegram request is aborted after three seconds and the reservation still confirms', async () => {
  const logs = []
  const handler = makeHandler({ logger: code => logs.push(code), fetcher: async (url, options) => {
    if (isDatabase(url)) return inserted()
    return new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error('Request did not time out')), 4500)
      options.signal.addEventListener('abort', () => {
        clearTimeout(watchdog)
        reject(options.signal.reason)
      }, { once: true })
    })
  } })
  await assertConfirmed(await handler(request()))
  assert.deepEqual(logs, ['TELEGRAM_TIMEOUT'])
})

test('maximum accepted text fits in one Telegram message', () => {
  const text = formatTelegramMessage({ name: 'x'.repeat(100), additional_guest_name: 'x'.repeat(100),
    email: 'x'.repeat(254), phone: 'x'.repeat(32), message: 'x'.repeat(1000),
    attending: 'yes', guests: 2, submission_id: data.submissionId }, receivedAt)
  assert.ok(text.length < 4096)
})
