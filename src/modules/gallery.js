export function setupGallery() {
  const dialog = document.querySelector('.lightbox')
  const enlarged = dialog.querySelector('img')
  const source = dialog.querySelector('source')
  let trigger
  document.querySelector('.photos').addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    const image = button.querySelector('img')
    trigger = button
    if (image.dataset.fullAvif) source.srcset = image.dataset.fullAvif
    else source.removeAttribute('srcset')
    enlarged.src = image.dataset.full || image.currentSrc || image.src
    enlarged.alt = image.alt
    dialog.showModal()
    document.body.classList.add('modal-open')
  })
  dialog.querySelector('button').addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => {
    document.body.classList.remove('modal-open')
    enlarged.removeAttribute('src')
    source.removeAttribute('srcset')
    trigger?.focus()
  })
}
