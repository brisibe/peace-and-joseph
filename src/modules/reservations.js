export function isReservationEndpoint(value, allowLocal = import.meta.env?.DEV === true) {
  try {
    const url = new URL(value)
    const hosted = url.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
      && !url.port && url.hostname !== 'yourprojectref.supabase.co'
    const local = allowLocal && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === '54321'
    return (hosted || local) && url.pathname === '/functions/v1/submit-reservation'
      && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

export async function submitReservation(endpoint, data, fetcher = fetch) {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(25000),
  })
  let result
  try { result = await response.json() } catch {
    throw Object.assign(new Error('RSVP response was not JSON'), { code: response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR' })
  }
  if (!response.ok || result?.ok !== true) {
    const knownCodes = ['INVALID_REQUEST', 'INVALID_RESERVATION', 'CONFIG_MISSING', 'SERVICE_BUSY',
      'SERVICE_UNAVAILABLE', 'SAVE_FAILED']
    throw Object.assign(new Error('RSVP was not confirmed'), {
      code: knownCodes.includes(result?.code) ? result.code : response.ok ? 'UNCONFIRMED' : 'HTTP_ERROR',
    })
  }
  if (result.submissionId !== data.submissionId) {
    throw Object.assign(new Error('RSVP confirmation did not match this submission'), {
      code: 'CONFIRMATION_MISMATCH',
    })
  }
  return result
}

export function reservationErrorMessage(error) {
  if (['CONFIG_MISSING', 'SERVICE_UNAVAILABLE'].includes(error?.code)) {
    return 'Online reservations are temporarily unavailable. Please contact the couple. Your details are still here.'
  }
  if (error?.code === 'INVALID_RESERVATION') return 'Please check your RSVP details and try again.'
  if (error?.code === 'SERVICE_BUSY') return 'The RSVP service is busy. Your details are still here; please try again shortly.'
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'Confirmation took too long. Your details are still here; please retry.'
  }
  return 'We could not confirm your RSVP. Your details are still here; please retry. If it keeps failing, contact the couple.'
}

export function contactErrors(email, phone) {
  return {
    email: email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? '' : 'Please enter a valid email address.',
    phone: !phone || (phone.length <= 32 && /^\+?[\d ()-]+$/.test(phone)
      && phone.replace(/\D/g, '').length >= 7 && phone.replace(/\D/g, '').length <= 15)
      ? '' : 'Please enter 7–15 digits, optionally with a country code, spaces, brackets, or hyphens.',
  }
}

export function setupReservationForm(form, endpoint, { onSuccess, submit = submitReservation } = {}) {
  const status = form.querySelector('#status')
  const button = form.querySelector('[type="submit"]')
  const fields = form.querySelector('fieldset')
  const attending = form.elements.attending
  const guests = form.elements.guests
  const additionalGuest = form.elements.additionalGuestName
  const additionalGuestField = form.querySelector('#additionalGuestField')
  let pendingId
  let pendingPayload

  if (!isReservationEndpoint(endpoint)) {
    button.disabled = true
    status.textContent = 'Online reservations will open soon. Please check back.'
    return
  }
  fields.disabled = false

  function syncGuests() {
    guests.disabled = attending.value === 'no'
    const needsGuestName = attending.value === 'yes' && guests.value === '2'
    additionalGuestField.hidden = !needsGuestName
    additionalGuest.disabled = !needsGuestName
    additionalGuest.required = needsGuestName
    additionalGuest.setCustomValidity('')
  }
  attending.addEventListener('change', syncGuests)
  guests.addEventListener('change', syncGuests)
  for (const field of [form.elements.email, form.elements.phone, additionalGuest]) {
    field.addEventListener('input', () => field.setCustomValidity(''))
  }
  syncGuests()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (button.disabled) return
    const errors = contactErrors(form.elements.email.value.trim(), form.elements.phone.value.trim())
    form.elements.email.setCustomValidity(errors.email)
    form.elements.phone.setCustomValidity(errors.phone)
    const needsGuestName = attending.value === 'yes' && guests.value === '2'
    const additionalGuestName = needsGuestName ? additionalGuest.value.trim() : ''
    additionalGuest.setCustomValidity(needsGuestName && (!additionalGuestName || additionalGuestName.length > 100)
      ? 'Please enter your additional guest’s full name (up to 100 characters).' : '')
    if (!form.reportValidity()) return
    const data = Object.fromEntries(new FormData(form))
    data.name = data.name.trim()
    data.message = data.message.trim()
    data.email = data.email.trim()
    data.phone = data.phone.trim()
    data.guests = attending.value === 'no' ? '0' : data.guests
    data.additionalGuestName = additionalGuestName
    if (!data.name) {
      status.textContent = 'Please enter your full name.'
      form.elements.name.focus()
      return
    }
    const payload = JSON.stringify(data)
    // An unchanged retry reuses its ID if the write succeeded but the reply was lost.
    if (payload !== pendingPayload) {
      pendingId = crypto.randomUUID()
      pendingPayload = payload
    }
    data.submissionId = pendingId
    button.disabled = true
    fields.disabled = true
    form.setAttribute('aria-busy', 'true')
    status.textContent = 'Sending your RSVP…'
    let saved = false
    try {
      await submit(endpoint, data)
      form.reset()
      syncGuests()
      pendingPayload = undefined
      pendingId = undefined
      status.textContent = 'Thank you — your RSVP has been received.'
      saved = true
    } catch (error) {
      // Log only an allowlisted diagnostic code, never request data or raw server errors.
      const code = ['HTTP_ERROR', 'INVALID_RESPONSE', 'UNCONFIRMED', 'CONFIRMATION_MISMATCH', 'INVALID_REQUEST', 'INVALID_RESERVATION',
        'CONFIG_MISSING', 'SERVICE_BUSY', 'SERVICE_UNAVAILABLE', 'SAVE_FAILED'].includes(error?.code)
        ? error.code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_OR_CLIENT_ERROR'
      console.warn('RSVP submission failed:', code)
      status.textContent = reservationErrorMessage(error)
    } finally {
      fields.disabled = false
      button.disabled = false
      form.removeAttribute('aria-busy')
    }
    // Keep gift UI errors separate from the confirmed save result.
    if (saved) onSuccess?.(button)
  })
}
