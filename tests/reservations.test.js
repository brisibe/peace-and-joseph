import test from 'node:test'
import assert from 'node:assert/strict'
import { contactErrors, isReservationEndpoint, reservationErrorMessage, submitReservation } from '../src/modules/reservations.js'
import { createReservationHandler, validateReservation } from '../supabase/functions/submit-reservation/handler.js'

const endpoint = 'https://example.supabase.co/functions/v1/submit-reservation'
const origin = 'http://localhost:5173'
const reservation = {
  submissionId: '01234567-89ab-4cde-8fab-0123456789ab',
  name: 'Ada Guest', attending: 'yes', guests: '2', message: 'Hello!', website: '',
  email: 'ada@example.com', phone: '', additionalGuestName: 'Grace Guest',
}
const request = (data = reservation, options = {}) => new Request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify(data), ...options,
})
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
function handler(options = {}) {
  return createReservationHandler({ databaseUrl: 'https://example.supabase.co', databaseKey: 'sb_secret_test',
    allowedOrigins: [origin], logger() {}, fetcher: async () => new Response(null, { status: 201 }), ...options })
}

test('only hosted Supabase submission URLs or explicitly allowed local development URLs are accepted', () => {
  assert.equal(isReservationEndpoint(endpoint), true)
  const local = 'http://127.0.0.1:54321/functions/v1/submit-reservation'
  assert.equal(isReservationEndpoint(local), false)
  assert.equal(isReservationEndpoint(local, true), true)
  for (const url of [undefined, '', endpoint + '?secret=x', endpoint + '#hash', endpoint + '/',
    endpoint.replace('https:', 'http:'), endpoint.replace('example.supabase.co', 'evil.example'),
    endpoint.replace('example.', 'example.supabase.co.evil.'), endpoint.replace('/submit-reservation', '/other'),
    endpoint.replace('example.', 'user:pass@example.'), endpoint.replace('example.', 'YOUR_PROJECT_REF.'),
    'https://script.google.com/macros/s/id/exec']) assert.equal(isReservationEndpoint(url), false)
})

test('client sends JSON without credentials and requires HTTP success plus matching confirmation', async () => {
  const result = await submitReservation(endpoint, reservation, async (url, options) => {
    assert.equal(url, endpoint)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), reservation)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    return response({ ok: true, submissionId: reservation.submissionId })
  })
  assert.equal(result.ok, true)
  for (const [reply, code] of [
    [response({ ok: true, submissionId: reservation.submissionId }, 500), 'HTTP_ERROR'],
    [response({ ok: true, submissionId: 'wrong' }), 'CONFIRMATION_MISMATCH'],
    [response(null), 'UNCONFIRMED'],
    [new Response('HTML'), 'INVALID_RESPONSE'],
    [new Response('HTML', { status: 502 }), 'HTTP_ERROR'],
    [response({ ok: false, code: 'INVALID_RESERVATION', error: 'private details' }, 422), 'INVALID_RESERVATION'],
    [response({ ok: false, code: 'private details' }, 500), 'HTTP_ERROR'],
  ]) await assert.rejects(submitReservation(endpoint, reservation, async () => reply), error =>
    error.code === code && !error.message.includes('private'))
  await assert.rejects(submitReservation(endpoint, reservation, async () => { throw new TypeError('Network') }))
})

test('receiver normalizes data and uses atomic ignore-duplicate insert without returning contacts', async () => {
  const handle = handler({ fetcher: async (url, options) => {
    assert.equal(url, 'https://example.supabase.co/rest/v1/reservations?on_conflict=submission_id&select=submission_id,received_at')
    assert.equal(options.headers.Prefer, 'resolution=ignore-duplicates,return=representation')
    assert.equal(options.headers.apikey, 'sb_secret_test')
    assert.equal(options.headers.Authorization, undefined)
    const row = JSON.parse(options.body)
    assert.equal(row.submission_id, reservation.submissionId)
    assert.equal(row.phone, '08031234567')
    assert.equal(row.name, '=Guest')
    assert.equal(row.additional_guest_name, 'Grace Guest')
    assert.equal(row.website, undefined)
    assert.equal(row.received_at, undefined)
    return new Response(null, { status: 201 })
  } })
  const reply = await handle(request({ ...reservation, name: ' =Guest ', phone: ' 08031234567 ', additionalGuestName: ' Grace Guest ' }))
  assert.equal(reply.status, 200)
  assert.deepEqual(await reply.json(), { ok: true, submissionId: reservation.submissionId })
})

test('receiver rejects invalid fields, types, and honeypot before database access', async () => {
  const handle = handler({ fetcher: () => assert.fail('Must not write') })
  for (const changes of [
    { name: ' ' }, { name: 'x'.repeat(101) }, { name: {} }, { message: 'x'.repeat(1001) },
    { attending: 'maybe' }, { guests: '3' }, { guests: '4' }, { guests: '5' }, { guests: '2.5' }, { guests: '' }, { guests: 2 },
    { attending: 'no', guests: '2' }, { submissionId: '=bad' }, { website: 'spam' },
    { email: '' }, { email: 'a@@example.com' }, { email: 'a\n@example.com' },
    { email: 'x'.repeat(255) + '@example.com' }, { phone: '123' }, { phone: '+1234567890123456' },
    { phone: '=1234567890' }, { phone: null },
  ]) {
    const reply = await handle(request({ ...reservation, ...changes }))
    assert.equal(reply.status, 422, JSON.stringify(changes))
    assert.equal((await reply.json()).code, 'INVALID_RESERVATION')
  }
  for (const data of [null, [], 'text']) assert.equal((await handle(request(data))).status, 422)
})

test('browser and server agree on contact validation, including optional phone and declines', async () => {
  for (const [email, phone, valid] of [
    ['ada@example.com', '', true], ['ada@example.com', '+234 (803) 123-4567', true],
    ['ada@example.com', '08031234567', true], ['+ada@example.com', '', true],
    ['', '', false], ['ada@example', '', false], ['ada@example.com', '+abc', false],
    ['ada@example.com', '123', false], ['ada@example.com', '1234567890123456', false],
  ]) {
    const errors = contactErrors(email, phone)
    assert.equal(!errors.email && !errors.phone, valid)
    assert.equal(Boolean(validateReservation({ ...reservation, email, phone })), valid)
  }
  const row = validateReservation({ ...reservation, attending: 'no', guests: '0' })
  assert.equal(row.guests, 0)
  assert.equal((await handler()(request({ ...reservation, attending: 'no', guests: '0' }))).status, 200)
})

test('receiver handles CORS preflight and adds CORS headers to failures', async () => {
  const handle = handler()
  const preflight = await handle(new Request(endpoint, { method: 'OPTIONS', headers: { origin } }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type')
  assert.equal(preflight.headers.get('vary'), 'Origin')
  const blocked = await handle(request(reservation, { headers: { origin: 'https://evil.example' } }))
  assert.equal(blocked.status, 403)
  assert.equal(blocked.headers.get('access-control-allow-origin'), null)
  const invalid = await handle(request({ ...reservation, name: '' }))
  assert.equal(invalid.headers.get('access-control-allow-origin'), origin)
  assert.equal((await handle(new Request(endpoint))).status, 405)
})

test('receiver rejects malformed, wrong-content-type and oversized streamed JSON', async () => {
  const handle = handler({ fetcher: () => assert.fail('Must not write') })
  assert.equal((await handle(request(null, { body: '{' }))).status, 400)
  assert.equal((await handle(request(null, { headers: { 'content-type': 'text/plain', origin } }))).status, 415)
  assert.equal((await handle(request(null, { body: 'x'.repeat(12001) }))).status, 413)
  assert.equal((await handle(request(null, { body: '{}', headers: { 'content-type': 'application/json', 'content-length': '12001', origin } }))).status, 413)
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('é'.repeat(6001))); controller.close()
  } })
  assert.equal((await handle(request(null, { body: stream, duplex: 'half' }))).status, 413)
})

test('receiver reports only safe codes for missing config, database rejection, and network failure', async () => {
  for (const [options, status, code] of [
    [{ databaseKey: '' }, 503, 'CONFIG_MISSING'],
    [{ allowedOrigins: [] }, 503, 'CONFIG_MISSING'],
    [{ fetcher: async () => new Response('private database detail', { status: 400 }) }, 500, 'SAVE_FAILED'],
    [{ fetcher: async () => new Response('private database detail', { status: 503 }) }, 503, 'SERVICE_UNAVAILABLE'],
    [{ fetcher: async () => new Response('private database detail', { status: 429 }) }, 503, 'SERVICE_BUSY'],
    [{ fetcher: async () => { throw new Error('private database detail') } }, 503, 'SERVICE_UNAVAILABLE'],
  ]) {
    const logs = []
    const reply = await handler({ ...options, logger: code => logs.push(code) })(request())
    assert.equal(reply.status, status)
    assert.deepEqual(await reply.json(), { ok: false, code })
    assert.deepEqual(logs, [code])
  }
  assert.match(reservationErrorMessage({ code: 'SERVICE_UNAVAILABLE' }), /contact the couple/)
  assert.match(reservationErrorMessage({ code: 'SERVICE_BUSY' }), /busy/)
  assert.match(reservationErrorMessage({ name: 'TimeoutError' }), /too long/)
})

test('local service-role JWT is used only by the server database request', async () => {
  await handler({ databaseKey: 'local-jwt', fetcher: async (_, options) => {
    assert.equal(options.headers.Authorization, 'Bearer local-jwt')
    return new Response(null, { status: 201 })
  } })(request())
})

test('additional guest name is required for two attendees and stored as null otherwise', async () => {
  for (const additionalGuestName of [undefined, '', '   ', 'x'.repeat(101), null, 123, {}]) {
    assert.equal(validateReservation({ ...reservation, additionalGuestName }), null)
    const reply = await handler()(request({ ...reservation, additionalGuestName }))
    assert.equal(reply.status, 422)
  }
  for (const name of ['Grace', 'Grace Guest', 'x'.repeat(100)]) {
    assert.equal(validateReservation({ ...reservation, additionalGuestName: name }).additional_guest_name, name)
  }
  for (const changes of [{ guests: '1' }, { attending: 'no', guests: '0' }]) {
    for (const name of [undefined, '', 'Stale Guest']) {
      const row = validateReservation({ ...reservation, ...changes, additionalGuestName: name })
      assert.equal(row.additional_guest_name, null)
    }
    const reply = await handler({ fetcher: async (_, options) => {
      assert.equal(JSON.parse(options.body).additional_guest_name, null)
      return new Response(null, { status: 201 })
    } })(request({ ...reservation, ...changes }))
    assert.equal(reply.status, 200)
  }
})
