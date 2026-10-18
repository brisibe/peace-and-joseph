import { createReservationHandler } from './handler.js'

Deno.serve(createReservationHandler({
  databaseUrl: Deno.env.get('SUPABASE_URL'),
  databaseKey: Deno.env.get('RSVP_DATABASE_KEY'),
  telegramBotToken: Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim(),
  telegramChatId: Deno.env.get('TELEGRAM_CHAT_ID')?.trim(),
  allowedOrigins: (Deno.env.get('RSVP_ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean),
}))
