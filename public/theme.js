// Run before styles load so a saved preference is applied before the first paint.
(() => {
  const key = 'wedding-theme'
  const root = document.documentElement
  const system = window.matchMedia('(prefers-color-scheme: dark)')
  const valid = (value) => value === 'light' || value === 'dark'
  let preference
  let button
  try {
    const saved = localStorage.getItem(key)
    if (valid(saved)) preference = saved
  } catch { /* Theme switching still works when storage is unavailable. */ }

  function apply() {
    const dark = preference ? preference === 'dark' : system.matches
    root.dataset.theme = dark ? 'dark' : 'light'
    if (button) {
      const label = dark ? 'Switch to light mode' : 'Switch to dark mode'
      button.setAttribute('aria-label', label)
      button.setAttribute('aria-pressed', String(dark))
      button.title = label
      button.querySelector('span').textContent = dark ? '☀' : '☾'
    }
  }

  apply()
  system.addEventListener('change', apply)
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return
    preference = valid(event.newValue) ? event.newValue : undefined
    apply()
  })
  document.addEventListener('DOMContentLoaded', () => {
    button = document.querySelector('.theme-toggle')
    if (!button) return
    button.hidden = false
    apply()
    button.addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(key, preference) } catch { /* Keep the session choice. */ }
      apply()
    })
  }, { once: true })
})()
