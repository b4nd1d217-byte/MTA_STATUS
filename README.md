# MTA_STATUS — DRIP X SHOP MTA Discord Manager

Discord.js v14 + Express + PostgreSQL, with a server-side MTA:SA heartbeat resource.

## Features
- Live MTA status panel: server name, current player count, capacity and ONLINE/OFFLINE heartbeat.
- Bot activity displays `MTA: X/Y`; the panel and activity switch to OFFLINE after 60 seconds without a valid heartbeat.
- Silent MTA reporting: no in-game chat messages, announcements, notifications or debug spam.
- MTA JOIN/QUIT audit events sent privately to a configurable Discord log channel.
- MTA-side `config.lua` for status banner, thumbnail/logo, ticket banner, displayed capacity override and JOIN/QUIT logging toggle.
- `/configsv ip` saves the server IP/domain directly in PostgreSQL and refreshes the Discord status panel; no MTA config-file edit is needed for the displayed IP.
- Persistent Discord panels, ticket records, visual settings and warnings (PostgreSQL).
- Select-menu ticket creation and management; modals for visual settings and adding users. No buttons.
- Ticket claim, HTML transcript, close/delete workflow and configurable support categories.
- Moderation slash commands: ban, kick, timeout, clear and warn, with audit logs.
- Rate-limited, authenticated status API with payload validation.
- No custom server-side MTA event is registered for remote client triggering.
- Optional server-side event-flood guard: on MTA builds supporting `onPlayerTriggerEventThreshold` (build r22313+), it kicks only after repeated threshold violations inside 15 seconds. It does not change the server's own event thresholds.

## Deploy to Render
1. Create a Render Web Service from this GitHub repository, branch `main`.
2. Build command: `npm install`; start command: `npm start`; health check: `/healthz`.
3. Create/use a PostgreSQL database and set `DATABASE_URL`. PostgreSQL is required for durable panel IDs, tickets and settings; the service intentionally refuses to boot without it.
4. Configure the remaining variables from `.env.example`. Use a random `API_SECRET` of at least 32 characters.
5. Invite the bot with `bot` and `applications.commands` scopes and permissions to manage channels, read/send messages, attach files, moderate members and manage roles/channels as required.
6. Enable Discord's **Message Content Intent** so transcript files can include message text. Presence Intent is not required.
7. Upload your supplied GIF as `public/assets/dripx-shop-logo.gif`, then set `LOGO_URL` to `https://YOUR-RENDER-HOST/assets/dripx-shop-logo.gif`. The original binary is available from the conversation attachment; it cannot be committed by the connected text-file GitHub operation.
8. Copy the same API secret into the MTA resource setting `apiSecret`; set `apiUrl` to `https://YOUR-RENDER-HOST/api/mta-status`.

## Availability and storage on Render Free

The Blueprint is intentionally set to the Free Web Service plan to avoid creating a paid service without your approval. The MTA heartbeat every 30 seconds keeps the web service receiving traffic while the game server is up. If the MTA server stays offline, Render Free spins the web service down after 15 minutes without inbound traffic; the Discord bot then disconnects and cannot keep monitoring continuously until a new request wakes it. Upgrade the web service to an always-on paid plan for continuous Discord presence and offline monitoring.

Use a durable external PostgreSQL database for production. Render Free Postgres expires after 30 days, so do not treat it as permanent storage. The app requires `DATABASE_URL` and refuses to start without it.

## MTA configuration and JOIN/QUIT logs

The resource loads `mta-script/config.lua` before `server.lua`. Edit these values:

- `bannerStatus`: direct HTTPS URL for the large status panel image.
- `logoUrl`: direct HTTPS URL for the small thumbnail/logo.
- `bannerTickets`: direct HTTPS URL for the tickets panel image.
- `maxPlayersOverride`: `0` uses the real `getMaxPlayers()` value; a positive value intentionally overrides the capacity displayed in Discord.
- `sendJoinQuitLogs`: `true` sends JOIN/QUIT events to the configured Discord log channel; `false` disables those events.

The MTA resource posts the configured images with its authenticated heartbeat. The bot validates HTTPS URLs and stores them in PostgreSQL, then refreshes the persistent panels. Leave image URLs blank if you prefer to manage images with `/editar-visual` in Discord. The IP shown in the panel is configured independently with `/configsv ip`.

In Discord, run `/config-logs`, choose the channel and select the type `JOIN / QUIT MTA`. Run it again with type `General / moderación` to configure the separate moderation/ticket log channel. The MTA bridge never writes JOIN/QUIT messages into in-game chat.

## MTA resource install
Copy `mta-script/` into the server's `resources` folder, preferably as resource `mta-status`, then add `<resource src="mta-status" startup="1" protected="1" />` to `mtaserver.conf`.
Configure the resource settings:
- `apiUrl`: full HTTPS URL ending in `/api/mta-status`
- `apiSecret`: exactly the same secret as Render's `API_SECRET`

The Lua file gets the server name, current player count and max players directly from MTA. It reports at startup, after player join/quit and every 30 seconds. It sends no chat messages or notifications and emits no routine debug output.

## Security boundaries
- The MTA bridge exposes no custom trigger event and has no client-side script or exported remote functions.
- The optional flood guard only addresses excessive `triggerServerEvent` traffic detected by MTA's built-in threshold (build r22313+). To allow its repeated-abuse kick action, approve the resource ACL request for `function.kickPlayer` (for a resource folder named `mta-status`, run `aclrequest allow mta-status function.kickPlayer` in the server console). Without that permission, it deliberately does not attempt a kick or emit access-denied debug messages.
- This guard does **not** automatically audit or repair vulnerable trigger handlers in your other resources. Those must independently validate the global `client` identity, ACL permissions and every client-supplied parameter; never trust `source` or client arguments as proof of identity.
- Do not put secrets in client-side Lua, Git, public screenshots or chat.
- Use HTTPS only and rotate `API_SECRET` immediately if it is exposed.
- Keep Discord bot permissions to the minimum required.

## Commands
Configuration: `/panel-status`, `/panel-tickets`, `/config-logs` (choose General or JOIN/QUIT MTA), `/configsv ip`, `/editar-visual`, `/ticket-add-opcion`, `/ticket-remove-opcion`.
Moderation: `/ban`, `/kick`, `/timeout`, `/clear`, `/warn`.

A bot restart marks MTA offline until the next valid heartbeat, even when the last saved server metadata remains available.
