A static Vite site based on `template.html`. The original template is retained as a reference; **edit `index.html` for the live page**. No UI framework or runtime packages are needed.

## Run locally

```sh
npm install
npm run dev
```

```sh
npm test
npm run build
npm run preview
```

Deploy `dist/` to any static host. Production builds hash and minify CSS/JavaScript. Configure long-lived immutable caching for `/assets/` on your host, and revalidate `index.html` on deployment.

## Structure

```text
index.html                 Wedding content and accessible HTML
template.html              Original design reference
src/style.css              Responsive template styles
src/main.js                Small interaction entry point
src/modules/               Countdown, menu, gallery, RSVP submission
public/images/             Photo assets
assets/originals/          Original photos, excluded from the published site
scripts/optimize-images.py Responsive image generation
supabase/                  Database migrations and RSVP Edge Function
tests/                     Native Node tests; no test dependencies
```

Content renders before JavaScript loads. The hero image has reserved dimensions and high fetch priority; gallery images have reserved dimensions and lazy loading. The countdown pauses in hidden tabs and after the wedding. The gallery uses a native dialog for keyboard focus, Escape, and focus restoration. Google Fonts use `display=swap` with local fallbacks; self-host WOFF2 files if eliminating third-party font requests is a priority.

The navbar's sun/moon button switches between light and dark mode on desktop and mobile. The initial theme follows the device setting until a visitor chooses a mode; the choice is saved under `wedding-theme` in local storage and synchronized across tabs. A small script applies the preference before styles load to avoid a flash of the other theme. If storage is unavailable, switching still works for the current page. Clear the stored preference to resume following the device setting.

## Connect reservations to Supabase

The public form sends JSON to a `submit-reservation` Edge Function. The function validates the request and inserts into a private Postgres table. The browser needs only `VITE_RSVP_ENDPOINT`; no database key or browser SDK is required. Hosting stays static.

### Production setup

1. Create a Supabase project and install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started). Run `supabase login` and `supabase link --project-ref PROJECT_REF` from this directory.
2. Review and apply the migration with `supabase db push`. It creates `public.reservations`, enables RLS, and revokes visitor table access. There are no anonymous or authenticated table policies.
3. Copy `supabase/.env.example` to `supabase/.env.local`. Set `RSVP_DATABASE_KEY` to a server-only Supabase secret key (`sb_secret_...`) from the project's API settings. Set `RSVP_ALLOWED_ORIGINS` to comma-separated exact origins, for example `https://your-wedding.example,http://localhost:5173`. Origins have no trailing slash or path. Include preview origins explicitly if needed. `SUPABASE_URL` is provided by the function runtime.
4. Upload only server settings using `supabase secrets set --env-file supabase/.env.local`. Never put these values in `VITE_` variables, HTML, or `public/`. The local file is ignored by Git.
5. Run `supabase functions deploy submit-reservation`. The checked-in function configuration sets `verify_jwt = false` because guests do not sign in. The endpoint intentionally accepts anonymous submissions; CORS is a browser-origin restriction, not authentication or rate limiting.
6. Copy `.env.example` to `.env.local` and set `VITE_RSVP_ENDPOINT=https://PROJECT_REF.supabase.co/functions/v1/submit-reservation`. Remove any old endpoint override. Restart Vite after changes; set the same public variable in the static host's build environment and rebuild/redeploy for production.
7. Verify from localhost and the deployed site using synthetic contact details. Check acceptance, decline, leading-zero phone numbers, lost-response retries, and the gift dialog. Inspect one row per unchanged submission in the Supabase dashboard, then delete synthetic rows.

Use Supabase's Table Editor to review/manage reservations and export responses privately. Grant project dashboard access only to trusted administrators. The public website has no reservation-list or administrator interface.

### Data and API contract

The form requires a name (1–100 characters), email (maximum 254 characters), attendance response, and party size. Phone (maximum 32 characters) and message (maximum 1000 characters) are optional. Phone accepts 7–15 digits, an optional leading `+`, spaces, parentheses, and hyphens. Guests means total party size including the responding person: 1–2 for `yes`, zero for `no`. Browser and receiver validate contacts; the receiver validates all fields, rejects a filled `website` honeypot, and limits request bodies to 12,000 UTF-8 bytes.

POST JSON fields are `submissionId` (UUID v4), `name`, `email`, `phone`, `attending`, `guests` (a string, matching the form), `additionalGuestName`, `message`, and `website`. Optional text fields default to empty strings. The honeypot is never stored. The table contains `submission_id`, server-generated `received_at`, `name`, `email`, `phone`, `attending`, `guests` (integer), `additional_guest_name` (nullable text), and `message`. Contacts and guest text are stored literally, preserving phone prefixes and leading zeros. Spreadsheet formula escaping is unnecessary for database storage; apply appropriate escaping if preparing exports for spreadsheet use.

A successful response is HTTP 200 with `{ "ok": true, "submissionId": "..." }`. Failures return `{ "ok": false, "code": "..." }`: 400/403/405/413/415 for `INVALID_REQUEST`, 422 for `INVALID_RESERVATION`, 503 for `CONFIG_MISSING`, `SERVICE_BUSY`, or `SERVICE_UNAVAILABLE`, and 500 for `SAVE_FAILED`. CORS preflight uses OPTIONS and returns 204. Allowed origins receive CORS headers on both success and error responses.

The function writes through PostgREST using `resolution=ignore-duplicates` and the primary key on `submission_id`, equivalent to `ON CONFLICT DO NOTHING`. A duplicate confirms the ID without changing the original row, including its timestamp. It does not update an existing RSVP. The insert returns only the new row’s ID and timestamp internally; an empty result identifies a duplicate and suppresses another Telegram alert. An unchanged retry on the same page reuses its ID; changing fields or refreshing starts a new submission. The frontend requires a matching ID and successful HTTP/JSON response before claiming success. Network failures and the 25-second timeout retain form details for retry. No guest details are logged or stored in browser storage.

After confirmation, the form clears and opens the optional gift invitation, including for declines. View gift options navigates to Gift & Support; Not now, close, and Escape return focus to the submit button. Failed or unconfirmed submissions never open the invitation.

### Additional guest name upgrade

Selecting attendance **yes** and party size **2** reveals a required additional guest full name (1–100 characters after trimming). Single attendees and declines submit no additional name, stored as `null`. Switching attendance or party size keeps the typed name available if the visitor switches back, but hidden names are not submitted. Success clears the field; failures retain it for retry. Editing the name creates a new submission ID.

For an existing deployment, run `npx supabase db push` first to add the nullable `additional_guest_name` column, then `npx supabase functions deploy submit-reservation`, then rebuild/redeploy the frontend. Existing rows and historical party sizes remain unchanged; names are not backfilled. New submissions are limited to party sizes of one or two. Older open pages submitting two guests without an additional name will receive a validation error and must refresh. Verify a two-person RSVP and the stored name in the Table Editor after deployment.

### Telegram admin alerts

The existing RSVP function can send one Telegram alert for each newly inserted reservation, for both acceptances and declines. It includes the respondent and additional guest names, party size, email, optional phone/message, submission ID, and the saved timestamp in Lagos time. Messages are plain text with link previews disabled. The browser does not contact Telegram or receive the bot token.

1. In Telegram, open the official **@BotFather** (`https://t.me/BotFather`), send `/newbot`, and follow the prompts. Save the bot token privately.
2. For a personal admin chat, open your new bot and press **Start**, then send it a message. For several admins, add the bot to a private group and send a command addressed to it, such as `/start@YourBotUsername`; ensure it can send messages there.
3. Obtain the destination `chat.id` from the bot's `getUpdates` response. Call `https://api.telegram.org/bot<TOKEN>/getUpdates` using a trusted local API client, keeping the token out of browser/frontend code and shared logs. Look under `result[].message.chat.id` for your personal conversation or intended group. Preserve a negative group ID, including a `-100` prefix when present. A new bot does not need a webhook or polling service just to send these alerts. If updates are empty, send a fresh command to the bot and retry. See the [Telegram Bot API](https://core.telegram.org/bots/api#getupdates).
4. Add the settings to **`supabase/.env.local`**, alongside the existing server settings:

   ```dotenv
   TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
   TELEGRAM_CHAT_ID=YOUR_CHAT_OR_GROUP_ID
   ```

5. Upload secrets, then deploy the updated receiver:

   ```sh
   npx supabase secrets set --env-file supabase/.env.local
   npx supabase functions deploy submit-reservation
   ```

6. Submit a synthetic RSVP and check both the database row and admin message. Test a decline too, then delete synthetic rows. Existing reservations are not announced.

The function uses `resolution=ignore-duplicates,return=representation` and requests only `submission_id,received_at`. Only a newly inserted row triggers an alert. An unchanged retry confirms the reservation without sending another message. No additional database migration or frontend change is needed for Telegram.

Notification delivery is best effort: the function attempts it once with a three-second timeout before returning RSVP success. Missing Telegram settings, rejection, rate limiting, network failures, and malformed Telegram responses never turn a saved RSVP into an error. There is no queue or automatic retry. A crash after saving, or a timeout after Telegram accepts a message, can leave delivery uncertain; retrying the RSVP will not retry the alert. If the database confirms a write but its insert representation cannot be read or recognized, the function still confirms the RSVP and skips notification.

Safe server diagnostics are `TELEGRAM_CONFIG_MISSING`, `TELEGRAM_REJECTED`, `TELEGRAM_UNCONFIRMED`, `TELEGRAM_TIMEOUT`, `TELEGRAM_REQUEST_FAILED`, and `NOTIFICATION_INSERT_UNCONFIRMED`. No tokens, token-bearing URLs, raw provider errors, or guest details are logged. Check the configured chat and bot permissions if notifications fail. Leave either Telegram setting blank to disable alerts; reservations continue working.

Unit tests use mock Telegram responses, including an actual three-second abort check. Local integration checks verify concurrent inserts against the real local database with a fake Telegram transport. Leave Telegram secrets blank in the local function environment when running automated integration checks to prevent its separate HTTP-flow checks from sending real alerts.

### Local Supabase and integration checks

Requires a running Docker engine and the Supabase CLI:

```sh
supabase start
supabase migration up
supabase status
```

Copy `supabase/.env.example` to `supabase/.env.local`, set `RSVP_DATABASE_KEY` to the local `service_role` JWT shown by `supabase status`, and keep the localhost origins. These local credentials must never be uploaded as production secrets. In another terminal:

```sh
supabase functions serve submit-reservation --env-file supabase/.env.local
```

Set `.env.local` to `VITE_RSVP_ENDPOINT=http://127.0.0.1:54321/functions/v1/submit-reservation`, restart `npm run dev`, and visit the Vite localhost URL. Local HTTP function URLs are accepted only in Vite development mode, never in production builds.

For integration checks, set shell variables `SUPABASE_TEST_SERVICE_ROLE_KEY` and `SUPABASE_TEST_ANON_KEY` using the local CLI values (keep them out of frontend environment variables), then run:

```sh
npm run test:integration
```

The integration runner defaults to `http://127.0.0.1:54321`; `SUPABASE_TEST_URL` can change the local address. It rejects non-local hosts, submits synthetic data through the running Edge Function, verifies concurrent duplicate handling, immutable retries, database constraints, acceptance/decline, contact text, CORS, and denied SELECT/INSERT/UPDATE/DELETE for anonymous and signed-in visitors. It creates a temporary Auth user and removes that user and its synthetic reservation in cleanup. `npm test` runs only isolated tests; it does not require Docker or credentials.

### Local UI preview without a backend

Run `npm run dev` and visit `/tests/rsvp-preview.html`. It uses the real markup and RSVP/gift modules with simulated success or failure and synthetic data; it never sends reservations externally. Check keyboard focus, Escape/close dismissal, gift navigation, themes, and mobile widths. The preview fixture is excluded from production builds.

### Troubleshooting and cutover

- `CONFIG_MISSING`: configure `RSVP_DATABASE_KEY` and a nonempty `RSVP_ALLOWED_ORIGINS` on the function. Frontend `.env` values do not configure the receiver.
- `SAVE_FAILED`: check that the migration was applied and the server key has database access. Inspect only safe diagnostic codes; never log request data or raw database errors.
- `SERVICE_UNAVAILABLE` / `SERVICE_BUSY`: retry after checking Supabase availability. The form retains data and the same retry ID.
- CORS/401 errors: check exact allowed origins, function deployment and `verify_jwt = false`. Test the actual browser flow from the deployed origin.
- Disabled form: check the endpoint's project reference and `/functions/v1/submit-reservation` path, remove old environment overrides, then restart Vite or rebuild production. HTTPS hosted URLs must use `PROJECT_REF.supabase.co`.

Deploy and verify the database/function before switching the frontend endpoint. Start fresh: do not import or dual-write historical responses. Keep the old Sheet as an archive. Retain the previous static build and already-deployed receiver temporarily for rollback and cached clients; only retire the receiver after verifying the new live flow. Cached older pages may still write to the previous receiver during this interval. Roll back by restoring the previous static build with its prior endpoint; do not delete new Supabase responses. Review safe function failure codes during cutover.

The honeypot remains basic spam protection. This refactor adds no CAPTCHA, rate limiting, invitation authentication, RSVP editing, email notifications, capacity enforcement, or website admin area.

References: [public Edge Functions](https://supabase.com/docs/guides/functions/auth), [CORS](https://supabase.com/docs/guides/functions/cors), [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Customize before launch

- Confirm the names, venue, dress code, and actual wedding date. The configured wedding date is **Friday, 4 December 2026 at 4:00 PM Lagos time**. Update the visible dates and `data-wedding-date` together; the countdown uses Lagos time (`+01:00`).
- Original photos live in `assets/originals/`; only compressed, resized versions in `public/images/` are published. The hero has 480/960/1600px variants; gallery photos have 320/640/960px thumbnails and a separate 1600px lightbox version. Each uses AVIF with a JPEG fallback. Responsive `srcset`/`sizes` lets the browser choose a suitable resolution. Gallery photos remain lazy-loaded, and the larger lightbox image is fetched only when opened.
- Bank transfers support two Nigerian naira accounts (`bankNgn1Value`, `bankNgn2Value`) and one USD account (`bankUsdValue`). Replace each placeholder in `index.html` with its bank name, account holder, and account number; add USD SWIFT/routing details if applicable. Use separate `<small>` elements for each line. Then remove `disabled`/`title` and add `data-copy="ACCOUNT_NUMBER"` to that account's button. The existing copy handler works independently for every account. The USDT wallet remains a separate option with its own copy button.
- Until a valid endpoint is configured, RSVP submission is disabled and visitors see a reservations-opening message. Configure and verify the deployed Supabase function before opening reservations.

## Regenerate optimized photos

Keep the original filenames (`cover.jpg`, `1.jpg` through `5.jpg`) in `assets/originals/`. On macOS with `sips` and FFmpeg (including the `libsvtav1` encoder) available, run:

```sh
python3 scripts/optimize-images.py
npm run build
```

The script generates AVIF at CRF 28 and JPEG at quality 78 from the originals, preserving their framing. The supplied photos are all 2880 × 3600; update HTML intrinsic dimensions if replacement originals have a different aspect ratio. Generated files are included in the project, so normal builds and deployment do not require image tools. The SVG favicon is already lightweight and remains a vector.
