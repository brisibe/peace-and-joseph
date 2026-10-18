import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const endpoint = 'https://preview.supabase.co/functions/v1/submit-reservation'
const readModule = (name) => readFileSync(new URL(`../src/modules/${name}.js`, import.meta.url), 'utf8')
  .replace(/^export /gm, '').replace('import.meta.env?.DEV', 'false')

function formHarness(submit, endpointValue = endpoint) {
  const values = {
    name: 'Ada Guest', email: 'ada@example.com', phone: '+234 803 123 4567',
    attending: 'yes', guests: '2', additionalGuestName: 'Grace Guest', message: 'Hello', website: '',
  }
  const fields = { disabled: true }
  const button = { disabled: false }
  const status = { textContent: '' }
  const additionalGuestField = { hidden: true }
  const events = {}
  let resets = 0
  let invitations = 0
  let nextId = 0
  const elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, {
    value, disabled: false, required: false, error: '',
    addEventListener(event, callback) { events[`${name}:${event}`] = callback },
    setCustomValidity(error) { this.error = error },
    focus() {},
  }]))
  const form = {
    elements, busy: false,
    querySelector: (selector) => ({ '#status': status, '[type="submit"]': button, fieldset: fields, '#additionalGuestField': additionalGuestField })[selector],
    addEventListener(event, callback) { events[event] = callback },
    reportValidity: () => !Object.values(elements).some((field) => !field.disabled && (field.error || (field.required && !field.value)))
      && Boolean(elements.name.value && elements.attending.value),
    reset() {
      resets++
      for (const field of Object.values(elements)) field.value = ''
      elements.guests.value = '1'
    },
    setAttribute() { this.busy = true },
    removeAttribute() { this.busy = false },
  }
  const context = vm.createContext({
    URL, URLSearchParams,
    crypto: { randomUUID: () => `01234567-89ab-4cde-8fab-${String(++nextId).padStart(12, '0')}` },
    FormData: class {
      *[Symbol.iterator]() {
        for (const [key, field] of Object.entries(elements)) {
          if (!fields.disabled && !field.disabled) yield [key, field.value]
        }
      }
    },
  })
  vm.runInContext(readModule('reservations'), context)
  context.setupReservationForm(form, endpointValue, {
    submit, onSuccess(trigger) {
      assert.equal(trigger, button)
      assert.equal(fields.disabled, false)
      assert.equal(form.busy, false)
      invitations++
    },
  })
  return {
    elements, fields, button, status, form, events, additionalGuestField,
    resets: () => resets, invitations: () => invitations,
    send: () => events.submit({ preventDefault() {} }),
  }
}

test('RSVP saves normalized contacts, disables pending submission, and invites gifting only on success', async () => {
  let complete
  let calls = 0
  const app = formHarness((url, data) => {
    calls++
    assert.equal(url, endpoint)
    assert.equal(data.email, 'ada@example.com')
    assert.equal(data.phone, '+234 803 123 4567')
    assert.equal(data.additionalGuestName, 'Grace Guest')
    return new Promise((resolve) => { complete = resolve })
  })
  app.elements.email.value = ' ada@example.com '
  app.elements.additionalGuestName.value = ' Grace Guest '
  const pending = app.send()
  assert.equal(app.fields.disabled, true)
  assert.equal(app.form.busy, true)
  assert.equal(app.invitations(), 0)
  await app.send()
  assert.equal(calls, 1)
  complete()
  await pending
  assert.equal(app.resets(), 1)
  assert.equal(app.invitations(), 1)
  assert.equal(app.elements.email.value, '')
  assert.equal(app.elements.additionalGuestName.value, '')
  assert.equal(app.additionalGuestField.hidden, true)
  assert.equal(app.elements.additionalGuestName.disabled, true)
  assert.equal(app.elements.additionalGuestName.required, false)
  assert.match(app.status.textContent, /received/)
})

test('failed and timed-out submissions retain data and ID for retry without showing a gift invitation', async () => {
  const ids = []
  let fail = true
  const app = formHarness(async (url, data) => {
    ids.push(data.submissionId)
    if (fail) throw new Error('Timeout')
  })
  await app.send()
  await app.send()
  assert.equal(ids[0], ids[1])
  assert.equal(app.invitations(), 0)
  assert.equal(app.resets(), 0)
  assert.equal(app.elements.email.value, 'ada@example.com')
  assert.equal(app.fields.disabled, false)
  app.elements.message.value = 'Changed RSVP'
  await app.send()
  assert.notEqual(ids[2], ids[1])
  fail = false
  await app.send()
  assert.equal(ids[3], ids[2])
  assert.equal(app.invitations(), 1)
})

test('declines submit zero guests, accept omitted phone, and still invite gifting', async () => {
  const app = formHarness(async (url, data) => {
    assert.equal(data.guests, '0')
    assert.equal(data.attending, 'no')
    assert.equal(data.phone, '')
    assert.equal(data.additionalGuestName, '')
  })
  app.elements.attending.value = 'no'
  app.events['attending:change']()
  assert.equal(app.elements.guests.disabled, true)
  app.elements.phone.value = ''
  await app.send()
  assert.equal(app.invitations(), 1)
  assert.equal(app.elements.guests.disabled, false)
})

test('invalid contacts prevent submission; correcting them permits retry', async () => {
  let calls = 0
  const app = formHarness(async () => { calls++ })
  app.elements.email.value = ''
  await app.send()
  assert.equal(calls, 0)
  assert.match(app.elements.email.error, /email/)
  app.elements.email.value = 'ada@example.com'
  app.events['email:input']()
  app.elements.phone.value = 'abc'
  await app.send()
  assert.equal(calls, 0)
  app.elements.phone.value = ''
  app.events['phone:input']()
  await app.send()
  assert.equal(calls, 1)
})

test('missing endpoint keeps the form disabled and cannot invite gifting', () => {
  const app = formHarness(async () => assert.fail('Must not submit'), '')
  assert.equal(app.fields.disabled, true)
  assert.equal(app.button.disabled, true)
  assert.equal(app.invitations(), 0)
})

test('additional name is visible and required only for an attending party of two', async () => {
  const payloads = []
  const app = formHarness(async (_, data) => { payloads.push(data); throw new Error('Offline') })
  assert.equal(app.additionalGuestField.hidden, false)
  assert.equal(app.elements.additionalGuestName.required, true)
  app.elements.additionalGuestName.value = '   '
  await app.send()
  assert.equal(payloads.length, 0)
  assert.match(app.elements.additionalGuestName.error, /full name/)
  app.elements.guests.value = '1'
  app.events['guests:change']()
  assert.equal(app.additionalGuestField.hidden, true)
  assert.equal(app.elements.additionalGuestName.disabled, true)
  assert.equal(app.elements.additionalGuestName.required, false)
  await app.send()
  assert.equal(payloads[0].additionalGuestName, '')
  app.elements.guests.value = '2'
  app.events['guests:change']()
  app.elements.additionalGuestName.value = 'Grace'
  app.events['additionalGuestName:input']()
  await app.send()
  await app.send()
  assert.equal(payloads[1].additionalGuestName, 'Grace')
  assert.equal(payloads[1].submissionId, payloads[2].submissionId)
  assert.equal(app.elements.additionalGuestName.value, 'Grace')
  app.elements.additionalGuestName.value = 'Another Guest'
  app.events['additionalGuestName:input']()
  await app.send()
  assert.notEqual(payloads[2].submissionId, payloads[3].submissionId)
  app.elements.attending.value = 'no'
  app.events['attending:change']()
  assert.equal(app.additionalGuestField.hidden, true)
  await app.send()
  assert.equal(payloads[4].additionalGuestName, '')
  app.elements.attending.value = 'yes'
  app.events['attending:change']()
  assert.equal(app.elements.additionalGuestName.value, 'Another Guest')
  assert.equal(app.additionalGuestField.hidden, false)
})

test('oversized additional names block submission and correcting them permits saving', async () => {
  let calls = 0
  const app = formHarness(async () => { calls++ })
  app.elements.additionalGuestName.value = 'x'.repeat(101)
  await app.send()
  assert.equal(calls, 0)
  app.elements.additionalGuestName.value = 'Grace Guest'
  app.events['additionalGuestName:input']()
  await app.send()
  assert.equal(calls, 1)
})

function dialogHarness(reducedMotion = false) {
  const events = {}
  const dismissEvents = [{}, {}]
  const classes = new Set()
  let sourceFocus = 0
  let supportFocus = 0
  let scroll
  const dialog = {
    returnValue: '', open: false,
    querySelector: () => ({ addEventListener: (event, callback) => { events.view = callback } }),
    querySelectorAll: () => dismissEvents.map((target) => ({
      addEventListener: (event, callback) => { target.click = callback },
    })),
    addEventListener(event, callback) { events[event] = callback },
    showModal() { this.open = true },
    close(value) { if (value !== undefined) this.returnValue = value; this.open = false; events.close() },
  }
  const source = { focus() { sourceFocus++ } }
  const support = {
    focus() { supportFocus++ }, scrollIntoView(options) { scroll = options },
  }
  const context = vm.createContext({
    document: {
      activeElement: source,
      body: { classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) } },
    },
    matchMedia: () => ({ matches: reducedMotion }),
  })
  vm.runInContext(readModule('gift-invitation'), context)
  return {
    open: context.setupGiftInvitation(dialog, support), dialog, events, dismissEvents, classes,
    sourceFocus: () => sourceFocus, supportFocus: () => supportFocus, scroll: () => scroll,
  }
}

test('view gift options closes the dialog, unlocks scrolling, and focuses the gift section', () => {
  for (const reduced of [false, true]) {
    const app = dialogHarness(reduced)
    app.open()
    assert.equal(app.dialog.open, true)
    assert.equal(app.classes.has('modal-open'), true)
    app.events.view()
    assert.equal(app.dialog.open, false)
    assert.equal(app.classes.has('modal-open'), false)
    assert.equal(app.supportFocus(), 1)
    assert.equal(app.sourceFocus(), 0)
    assert.equal(app.scroll().behavior, reduced ? 'auto' : 'smooth')
  }
})

test('Not now, close button, and native Escape close return focus without scrolling to gifts', () => {
  for (const choice of ['not-now', 'close', 'escape']) {
    const app = dialogHarness()
    app.open()
    if (choice === 'escape') app.dialog.close() // Native dialog Escape closes without a return value.
    else app.dismissEvents[choice === 'close' ? 0 : 1].click()
    assert.equal(app.sourceFocus(), 1)
    assert.equal(app.supportFocus(), 0)
    assert.equal(app.scroll(), undefined)
    assert.equal(app.classes.size, 0)
  }
})

test('reopened invitation resets the prior gift choice before Escape dismissal', () => {
  const app = dialogHarness()
  app.open()
  app.events.view()
  app.open()
  app.dialog.close()
  assert.equal(app.supportFocus(), 1)
  assert.equal(app.sourceFocus(), 1)
})
