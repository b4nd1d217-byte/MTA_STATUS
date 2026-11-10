-- DRIP X SHOP · MTA bridge configuration
-- Edit this file on the MTA server. Keep API secrets server-side only.
DRIPX_CONFIG = {
    -- Discord panel images. Use direct HTTPS image URLs (PNG/JPG/GIF).
    bannerStatus = "",
    logoUrl = "",
    bannerTickets = "",

    -- 0 = use getMaxPlayers() from MTA automatically.
    -- Set a positive number only if you intentionally want a displayed capacity override.
    maxPlayersOverride = 0,

    -- Send player JOIN/QUIT audit entries to the Discord channel configured with /config-logs.
    sendJoinQuitLogs = true
}
