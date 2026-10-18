export function countdownValues(target, now = Date.now()) {
  const remaining = Math.max(0, target - now)
  return [
    Math.floor(remaining / 86400000),
    Math.floor(remaining / 3600000) % 24,
    Math.floor(remaining / 60000) % 60,
    Math.floor(remaining / 1000) % 60,
  ]
}

export function startCountdown(element) {
  const target = Date.parse(element.dataset.weddingDate)
  if (!Number.isFinite(target)) return
  const fields = element.querySelectorAll('strong')
  let timer
  function tick() {
    // Read the visitor's device clock each time, rather than decrementing a saved duration.
    const now = Date.now()
    countdownValues(target, now).forEach((value, index) => {
      const text = String(value).padStart(2, '0')
      if (fields[index].textContent !== text) fields[index].textContent = text
    })
    if (now >= target) clearInterval(timer)
  }
  function resume() {
    clearInterval(timer)
    if (!document.hidden) {
      tick()
      if (Date.now() < target) timer = setInterval(tick, 1000)
    }
  }
  document.addEventListener('visibilitychange', resume)
  resume()
}
