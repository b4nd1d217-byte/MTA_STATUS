-- DRIP X SHOP · MTA server-side trigger abuse guard
-- Does not register any custom or remotely callable events.
-- Uses MTA's own triggerServerEvent threshold; the server threshold in mtaserver.conf
-- remains under the server owner's control.

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

    -- Avoid kicking on a single burst: require repeated server-level threshold events.
    if entry.hits >= KICK_AFTER_THRESHOLD_HITS then
        hitWindows[player] = nil
        kickPlayer(player, "DRIP X SHOP Security", "Repeated remote event flooding")
    end
end

local function onPlayerQuitCleanup()
    hitWindows[source] = nil
end

addEventHandler("onPlayerTriggerEventThreshold", root, onTriggerThreshold)
addEventHandler("onPlayerQuit", root, onPlayerQuitCleanup)
