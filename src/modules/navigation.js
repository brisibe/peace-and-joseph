const menu = document.querySelector('.menu')
const toggle = document.querySelector('.mobile-toggle')

function setOpen(open) {
  menu.classList.toggle('open', open)
  toggle.setAttribute('aria-expanded', String(open))
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
}

toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'))
menu.addEventListener('click', (event) => {
  if (event.target.closest('a')) setOpen(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
    setOpen(false)
    toggle.focus()
  }
})
matchMedia('(min-width: 851px)').addEventListener('change', () => setOpen(false))
