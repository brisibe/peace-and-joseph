import { createReservationHandler } from './handler.js'

Deno.serve(createReservationHandler({
  databaseUrl: Deno.env.get('SUPABASE_URL'),
  databaseKey: Deno.env.get('RSVP_DATABASE_KEY'),
  allowedOrigins: (Deno.env.get('RSVP_ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean),
}))
