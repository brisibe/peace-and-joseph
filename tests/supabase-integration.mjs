// Explicit local-only integration suite; never loads frontend .env files.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createReservationHandler } from '../supabase/functions/submit-reservation/handler.js'

const url = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321'
const serverKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const anonKey = process.env.SUPABASE_TEST_ANON_KEY
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Integration checks are restricted to local Supabase')
}
if (!serverKey || !anonKey) throw new Error('Set SUPABASE_TEST_SERVICE_ROLE_KEY and SUPABASE_TEST_ANON_KEY from supabase status')
const origin = 'http://localhost:5173'
const id = randomUUID()
const email = `integration-${id}@example.com`
const password = randomUUID() + 'aA1!'
const adminHeaders = { apikey: serverKey, Authorization: `Bearer ${serverKey}`, 'Content-Type': 'application/json' }
const rowUrl = `${url}/rest/v1/reservations?submission_id=eq.${id}`
let userId
const cleanupIds = [id]
async function post(data) {
  const reply = await fetch(`${url}/functions/v1/submit-reservation`, {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  assert.equal(reply.status, 200, 'Function should confirm the write')
  assert.equal(reply.headers.get('access-control-allow-origin'), origin)
  assert.deepEqual(await reply.json(), { ok: true, submissionId: id })
}
try {
  const data = { submissionId: id, name: 'Integration Guest', email, phone: '08031234567',
    attending: 'yes', guests: '2', additionalGuestName: 'Integration Companion', message: '=literal text', website: '' }
  await Promise.all(Array.from({ length: 8 }, () => post(data)))
  const saved = await fetch(rowUrl, { headers: adminHeaders })
  assert.equal(saved.status, 200)
  const rows = await saved.json()
  assert.equal(rows.length, 1, 'Concurrent retries must store exactly one row')
  assert.equal(rows[0].phone, data.phone)
  assert.equal(rows[0].additional_guest_name, data.additionalGuestName)
  assert.equal(rows[0].message, data.message)
  assert.ok(Number.isFinite(Date.parse(rows[0].received_at)))
  await post({ ...data, name: 'Must not overwrite', phone: '', attending: 'no', guests: '0' })
  const retried = await fetch(rowUrl, { headers: adminHeaders })
  assert.deepEqual(await retried.json(), rows, 'Duplicate IDs must leave the entire original row unchanged')

  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ email, password, email_confirm: true }),
  })
  assert.equal(created.status, 200, 'Create a temporary authenticated visitor')
  userId = (await created.json()).id
  assert.ok(userId)
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  assert.equal(login.status, 200)
  const token = (await login.json()).access_token
  assert.ok(token)
  for (const credential of [anonKey, token]) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const reply = await fetch(rowUrl, {
        method, headers: { apikey: anonKey, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(rows[0]) } : method === 'PATCH' ? { body: JSON.stringify({ name: 'Forbidden' }) } : {}),
      })
      assert.ok([401, 403].includes(reply.status), `Visitor ${method} access must be denied`)
    }
  }
  for (const invalid of [{ attending: 'no', guests: 2 }, { email: 'invalid' }, { phone: '123' }, { guests: 5 }, { additional_guest_name: '   ' }, { additional_guest_name: 'x'.repeat(101) }]) {
    const invalidId = randomUUID()
    cleanupIds.push(invalidId)
    const reply = await fetch(`${url}/rest/v1/reservations`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...rows[0], submission_id: invalidId, ...invalid }),
    })
    assert.equal(reply.status, 400, 'Database constraints must independently reject invalid reservations')
  }
  // A distinct decline saves zero guests.
  const removed = await fetch(rowUrl, { method: 'DELETE', headers: adminHeaders })
  assert.ok(removed.ok)
  await post({ ...data, attending: 'no', guests: '0' })
  const decline = await fetch(rowUrl, { headers: adminHeaders })
  const declinedRow = (await decline.json())[0]
  assert.equal(declinedRow.guests, 0)
  assert.equal(declinedRow.additional_guest_name, null)
  assert.ok((await fetch(rowUrl, { method: 'DELETE', headers: adminHeaders })).ok)
  await post({ ...data, guests: '1' })
  const single = await fetch(rowUrl, { headers: adminHeaders })
  assert.equal((await single.json())[0].additional_guest_name, null)
  // Exercise the actual local PostgREST conflict/RETURNING behavior with a fake
  // Telegram transport. No external message is sent by this handler.
  assert.ok((await fetch(rowUrl, { method: 'DELETE', headers: adminHeaders })).ok)
  let notificationCount = 0
  const diagnostics = []
  const localHandler = createReservationHandler({ databaseUrl: url, databaseKey: serverKey,
    allowedOrigins: [origin], telegramBotToken: 'integration-only', telegramChatId: 'integration-chat',
    logger: code => diagnostics.push(code), fetcher: async (target, options) => {
      if (new URL(target).hostname === 'api.telegram.org') {
        notificationCount++
        assert.ok(JSON.parse(options.body).text.includes(data.additionalGuestName))
        return Response.json({ ok: true })
      }
      return fetch(target, options)
    },
  })
  const invoke = () => localHandler(new Request(`${url}/functions/v1/submit-reservation`, {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }))
  const confirmations = await Promise.all(Array.from({ length: 8 }, invoke))
  for (const reply of confirmations) assert.equal(reply.status, 200)
  assert.equal(notificationCount, 1, 'Concurrent real inserts must trigger one notification attempt')
  assert.equal((await invoke()).status, 200)
  assert.equal(notificationCount, 1, 'Unchanged retries must not send another notification')
  assert.deepEqual(diagnostics, [])
  console.log('Supabase integration checks passed: concurrency, retries, constraints, visitor permissions, decline, contacts, CORS, single Telegram attempt.')
} finally {
  const cleanup = await fetch(`${url}/rest/v1/reservations?submission_id=in.(${cleanupIds.join(',')})`, { method: 'DELETE', headers: adminHeaders })
  assert.ok(cleanup.ok, 'Synthetic reservation cleanup failed')
  if (userId) {
    const removed = await fetch(`${url}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: adminHeaders })
    assert.ok(removed.ok, 'Temporary visitor cleanup failed')
  }
}
