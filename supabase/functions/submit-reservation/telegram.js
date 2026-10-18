export function formatTelegramMessage(row, receivedAt) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'medium',
  }).format(new Date(receivedAt))
  return [
    'New wedding RSVP',
    `Name: ${row.name}`,
    ...(row.additional_guest_name ? [`Additional guest: ${row.additional_guest_name}`] : []),
    `Attendance: ${row.attending === 'yes' ? 'Accepts' : 'Declines'}`,
    `Party size: ${row.guests}`,
    `Email: ${row.email}`,
    ...(row.phone ? [`Phone: ${row.phone}`] : []),
    ...(row.message ? [`Message: ${row.message}`] : []),
    `Submission ID: ${row.submission_id}`,
    `Received: ${time} (Lagos)`,
  ].join('\n')
}

/**
 * @param {{ botToken?: string, chatId?: string, fetcher?: typeof fetch,
 *   logger?: (code: string) => void }} [options]
 */
export function createTelegramNotifier({ botToken, chatId, fetcher = fetch,
  logger = (code) => console.warn('RSVP notification:', code) } = {}) {
  return async function notify(row, receivedAt) {
    if (!botToken || !chatId) {
      logger('TELEGRAM_CONFIG_MISSING')
      return
    }
    try {
      const response = await fetcher(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: formatTelegramMessage(row, receivedAt),
          link_preview_options: { is_disabled: true } }),
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) {
        logger('TELEGRAM_REJECTED')
        return
      }
      const result = await response.json()
      if (result?.ok !== true) logger('TELEGRAM_UNCONFIRMED')
    } catch (error) {
      // Fetch errors may contain the bot-token URL; never log the exception.
      logger(error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_REQUEST_FAILED')
    }
  }
}
