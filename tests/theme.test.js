import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8')

function theme({ saved = null, dark = false, blocked = false } = {}) {
  const events = {}
  const stored = new Map(saved === null ? [] : [['wedding-theme', saved]])
  const icon = { textContent: '' }
  const button = {
    hidden: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value },
    querySelector: () => icon,
    addEventListener(name, callback) { events[name] = callback },
  }
  const root = { dataset: {} }
  const system = {
    matches: dark,
    addEventListener(name, callback) { events.systemChange = callback },
  }
  vm.runInNewContext(source, {
    document: {
      documentElement: root,
      querySelector: () => button,
      addEventListener(name, callback) { events[name] = callback },
    },
    window: {
      matchMedia: () => system,
      addEventListener(name, callback) { events[name] = callback },
    },
    localStorage: {
      getItem: (key) => {
        if (blocked) throw new Error('Storage blocked')
        return stored.get(key) ?? null
      },
      setItem: (key, value) => {
        if (blocked) throw new Error('Storage blocked')
        stored.set(key, value)
      },
    },
  })
  return { root, system, button, stored, events, icon }
}

test('theme follows system preference before the page renders', () => {
  for (const dark of [false, true]) {
    const app = theme({ dark })
    assert.equal(app.root.dataset.theme, dark ? 'dark' : 'light')
    app.events.DOMContentLoaded()
    assert.equal(app.button.hidden, false)
    assert.equal(app.button.attributes['aria-pressed'], String(dark))
    app.system.matches = !dark
    app.events.systemChange()
    assert.equal(app.root.dataset.theme, dark ? 'light' : 'dark')
  }
})

test('toggle updates theme and accessible label, persists choice, and overrides system', () => {
  const app = theme()
  app.events.DOMContentLoaded()
  app.events.click()
  assert.equal(app.root.dataset.theme, 'dark')
  assert.equal(app.stored.get('wedding-theme'), 'dark')
  assert.equal(app.button.attributes['aria-pressed'], 'true')
  assert.equal(app.button.attributes['aria-label'], 'Switch to light mode')
  assert.equal(app.icon.textContent, '☀')
  app.events.systemChange()
  assert.equal(app.root.dataset.theme, 'dark')
  assert.equal(theme({ saved: app.stored.get('wedding-theme') }).root.dataset.theme, 'dark')
  app.events.click()
  assert.equal(app.root.dataset.theme, 'light')
  assert.equal(app.button.attributes['aria-label'], 'Switch to dark mode')
  assert.equal(app.stored.get('wedding-theme'), 'light')
})

test('saved preference wins; invalid or blocked storage still allows switching', () => {
  assert.equal(theme({ saved: 'light', dark: true }).root.dataset.theme, 'light')
  assert.equal(theme({ saved: 'invalid', dark: true }).root.dataset.theme, 'dark')
  const app = theme({ blocked: true, dark: true })
  app.events.DOMContentLoaded()
  app.events.click()
  assert.equal(app.root.dataset.theme, 'light')
})

test('theme synchronizes across tabs and returns to system when the preference is cleared', () => {
  const app = theme({ saved: 'dark' })
  app.events.DOMContentLoaded()
  app.events.storage({ key: 'unrelated', newValue: 'light' })
  assert.equal(app.root.dataset.theme, 'dark')
  app.events.storage({ key: 'wedding-theme', newValue: 'light' })
  assert.equal(app.root.dataset.theme, 'light')
  app.system.matches = true
  app.events.storage({ key: null, newValue: null })
  assert.equal(app.root.dataset.theme, 'dark')
})
