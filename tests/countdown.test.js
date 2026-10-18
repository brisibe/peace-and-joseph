import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { countdownValues } from '../src/modules/countdown.js'

test('countdown respects the explicit wedding instant and clamps expired dates', () => {
  const target = Date.parse('2026-12-04T16:00:00+01:00')
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.ok(html.includes('data-wedding-date="2026-12-04T16:00:00+01:00"'))
  assert.equal(target, Date.parse('2026-12-04T15:00:00Z'))
  assert.deepEqual(countdownValues(target, target - 93784000), [1, 2, 3, 4])
  assert.deepEqual(countdownValues(target, target - 86400000), [1, 0, 0, 0])
  assert.deepEqual(countdownValues(target, target - 1000), [0, 0, 0, 1])
  assert.deepEqual(countdownValues(target, target), [0, 0, 0, 0])
  assert.deepEqual(countdownValues(target, target + 1), [0, 0, 0, 0])
})

test('countdown renders immediately, updates each second, resumes from current time, and stops at zero', () => {
  const target = Date.parse('2026-12-04T16:00:00+01:00')
  let now = target - 86400000
  let interval
  let onVisibilityChange
  const document = {
    hidden: false,
    addEventListener(event, listener) {
      assert.equal(event, 'visibilitychange')
      onVisibilityChange = listener
    },
  }
  const fields = Array.from({ length: 4 }, () => ({ textContent: '—' }))
  const element = {
    dataset: { weddingDate: '2026-12-04T16:00:00+01:00' },
    querySelectorAll: () => fields,
  }
  const context = vm.createContext({
    document,
    Date: class extends Date { static now() { return now } },
    setInterval(callback, delay) {
      assert.equal(delay, 1000)
      interval = callback
      return 1
    },
    clearInterval() { interval = undefined },
  })
  const source = readFileSync(new URL('../src/modules/countdown.js', import.meta.url), 'utf8')
  vm.runInContext(source.replace(/^export /gm, ''), context)
  const displayed = () => fields.map((field) => field.textContent)

  context.startCountdown(element)
  assert.deepEqual(displayed(), ['01', '00', '00', '00'])
  now += 1000
  interval()
  assert.deepEqual(displayed(), ['00', '23', '59', '59'])

  // Delayed ticks and device-clock adjustments must use the actual current time.
  now = target - 3600000
  interval()
  assert.deepEqual(displayed(), ['00', '01', '00', '00'])
  now = target - 7200000
  interval()
  assert.deepEqual(displayed(), ['00', '02', '00', '00'])

  document.hidden = true
  onVisibilityChange()
  assert.equal(interval, undefined)
  now = target - 1000
  document.hidden = false
  onVisibilityChange()
  assert.deepEqual(displayed(), ['00', '00', '00', '01'])

  // Reinitializing the page also derives its value from the current clock.
  context.startCountdown(element)
  assert.deepEqual(displayed(), ['00', '00', '00', '01'])
  now = target
  interval()
  assert.deepEqual(displayed(), ['00', '00', '00', '00'])
  assert.equal(interval, undefined)
  now += 1000
  onVisibilityChange()
  assert.deepEqual(displayed(), ['00', '00', '00', '00'])
  assert.equal(interval, undefined)
})

