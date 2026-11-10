-- DRIP X SHOP · MTA server-side trigger abuse guard
-- This resource declares NO custom events and exposes NO client-callable exports.
-- On MTA builds that support the event-threshold hook, repeated server-level
-- triggerServerEvent floods are kicked silently. The server owner's own
-- mtaserver.conf threshold is never weakened or overwritten.

local hitWindows = {}
local WINDOW_MS = 15000
local KICK_AFTER_THRESHOLD_HITS = 3

local function onTriggerThreshold(eventName)
    local player = source
    if not isElement(player) or getElementType(player) ~= "player" then
        return
    end

    local now = getTickCount()
    local entry = hitWindows[player]
    if not entry or now - entry.startedAt > WINDOW_MS then
        entry = { startedAt = now, hits = 0 }
        hitWindows[player] = entry
    end

    entry.hits = entry.hits + 1

    -- A single spike can be legitimate; repeated threshold hits indicate sustained abuse.
    if entry.hits >= KICK_AFTER_THRESHOLD_HITS then
        hitWindows[player] = nil
        -- ACL is checked first: never generate access-denied debug noise.
        if hasObjectPermissionTo(getThisResource(), "function.kickPlayer", true) then
            kickPlayer(player, "DRIP X SHOP Security", "Repeated remote event flooding")
        end
    end
end

local function cleanupPlayer()
    hitWindows[source] = nil
end

-- onPlayerTriggerEventThreshold exists in MTA 1.6.0 builds from r22313.
-- Detect it by sortable build number so older servers still load the resource safely.
local versionInfo = getVersion()
local sortable = tostring(versionInfo and versionInfo.sortable or "")
local build = tonumber(sortable:match("%.(%d+)%.%d+$")) or 0
if build >= 22313 then
    addEventHandler("onPlayerTriggerEventThreshold", root, onTriggerThreshold)
end

addEventHandler("onPlayerQuit", root, cleanupPlayer)
