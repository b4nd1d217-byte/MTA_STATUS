# MTA_STATUS — DRIP X SHOP MTA Discord Manager

Discord.js v14 + Express + PostgreSQL, with a server-side MTA:SA heartbeat resource.

## Features
- Live MTA status panel: server name, players, capacity and ONLINE/OFFLINE heartbeat.
- Silent MTA reporting: no in-game chat messages, announcements, notifications or debug spam.
- Persistent Discord panels and ticket records (PostgreSQL).
- Select-menu ticket creation and management; modals for visual settings and adding users. No buttons.
- Ticket claim, HTML transcript, close/delete workflow and configurable support categories.
- Moderation slash commands: ban, kick, timeout, clear and warn, with audit logs.
- Rate-limited, authenticated status API with payload validation.
- MTA resource exposes no client-callable custom server events.

## Deploy to Render
1. Push this repository to GitHub and create a Render Web Service from branch `main`.
2. Build command: `npm install`; start command: `npm start`; health check: `/healthz`.
3. Configure environment variables from `.env.example`. Use a PostgreSQL database and set `DATABASE_URL`; persistent panels/tickets require PostgreSQL.
4. Invite the bot with `bot` and `applications.commands` scopes and permissions to manage channels, read/send messages, attach files, moderate members and view audit logs.
5. Enable Discord's **Message Content Intent** only if you want transcript bodies; the bot uses slash commands and does not need Presence Intent.
6. Upload your supplied GIF as `public/assets/dripx-shop-logo.gif`, then set `LOGO_URL` to `https://YOUR-RENDER-HOST/assets/dripx-shop-logo.gif`. (The source GIF is not embedded in this text-only GitHub commit; use the original attachment.)
7. Copy the API secret into the MTA resource setting `apiSecret`; set `apiUrl` to `https://YOUR-RENDER-HOST/api/mta-status`.

## MTA resource install
Copy `mta-script/` into the server's `resources` folder, add `<resource src="mta-status" startup="1" protected="1" />` to `mtaserver.conf`, then configure the resource settings in the MTA server resource settings panel:
- `apiUrl`: full HTTPS URL ending in `/api/mta-status`
- `apiSecret`: exactly the same secret as Render's `API_SECRET`

The Lua file obtains server name, current player count and max players directly from MTA. It sends an initial report, reports after join/quit, and sends a heartbeat every 30 seconds. It does not send chat messages or notifications.

## Security notes
- No custom event is registered with remote triggering enabled; no client-side trigger can invoke bot/API operations.
- Do not add secrets to client-side Lua, Git, or screenshots.
- MTA's `onPlayerTriggerInvalidEvent` monitor is optional and non-punitive by default to avoid false-positive kicks. This resource does not replace a full server-wide security audit of other resources.
- Protect the Render API secret and rotate it if exposed. Use HTTPS only.
- Keep Discord bot permissions to the minimum required.

## Commands
Configuration: `/panel-status`, `/panel-tickets`, `/config-logs`, `/editar-visual`, `/ticket-add-opcion`, `/ticket-remove-opcion`.
Moderation: `/ban`, `/kick`, `/timeout`, `/clear`, `/warn`.

## Notes
A bot restart marks MTA offline until the next valid heartbeat. The API itself does not infer online state from a Discord presence value; it uses last successful authenticated heartbeat (60-second timeout).
