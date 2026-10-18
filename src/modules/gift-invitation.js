export function setupGiftInvitation(dialog, support) {
  let trigger
  dialog.querySelector('[data-gift-view]').addEventListener('click', () => dialog.close('gift'))
  dialog.querySelectorAll('[data-gift-dismiss]').forEach((button) => {
    button.addEventListener('click', () => dialog.close('dismiss'))
  })
  dialog.addEventListener('close', () => {
    document.body.classList.remove('modal-open')
    if (dialog.returnValue === 'gift') {
      support.focus({ preventScroll: true })
      support.scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      })
    } else {
      trigger?.focus({ preventScroll: true })
    }
  })
  return (source = document.activeElement) => {
    trigger = source
    dialog.returnValue = ''
    dialog.showModal()
    document.body.classList.add('modal-open')
  }
}
