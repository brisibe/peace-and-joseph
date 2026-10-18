import './modules/navigation.js'
import { startCountdown } from './modules/countdown.js'
import { setupGallery } from './modules/gallery.js'
import { setupReservationForm } from './modules/reservations.js'
import { setupGiftInvitation } from './modules/gift-invitation.js'

startCountdown(document.querySelector('.countdown'))
setupGallery()
const showGiftInvitation = setupGiftInvitation(
  document.querySelector('.gift-dialog'), document.querySelector('#support'),
)
setupReservationForm(document.querySelector('#rsvpForm'), import.meta.env.VITE_RSVP_ENDPOINT, {
  onSuccess: showGiftInvitation,
})

document.querySelectorAll('[data-copy], [data-copy-target]').forEach((button) => {
  const feedback = document.createElement('span')
  feedback.className = 'copy-feedback'
  feedback.setAttribute('aria-hidden', 'true')
  button.append(feedback)
  let feedbackTimer
  button.addEventListener('click', async () => {
    const status = document.querySelector('#copy-status')
    try {
      const value = button.dataset.copyTarget
        ? document.getElementById(button.dataset.copyTarget)?.textContent.trim()
        : button.dataset.copy
      if (!value) throw new Error('No copy value available')
      await navigator.clipboard.writeText(value)
      status.textContent = 'Copied to clipboard.'
      clearTimeout(feedbackTimer)
      feedback.textContent = 'Copied'
      feedbackTimer = setTimeout(() => { feedback.textContent = '' }, 1800)
    } catch {
      clearTimeout(feedbackTimer)
      feedback.textContent = ''
      status.textContent = 'Could not copy. Please select and copy the details manually.'
    }
  })
})
