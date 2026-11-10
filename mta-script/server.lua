-- DRIP X SHOP · MTA Status Bridge
-- Server-side only. No custom remote events, client scripts or client-callable exports.
-- No in-game chat messages, notifications or routine debug output.

local REPORT_INTERVAL_MS = 30000
local apiUrl, apiSecret = "", ""
local reportTimer, requestInFlight, stopped = nil, false, false
local settings = DRIPX_CONFIG or {}

local function validHttps(value)
    return type(value) == "string" and #value <= 500 and value:match("^https://") ~= nil
end

local function jsonObject(payload)
    local encoded = toJSON(payload, true)
    if type(encoded) ~= "string" or #encoded < 2 then return nil end
    -- MTA may wrap a top-level table in an array; API expects a JSON object.
    if encoded:sub(1, 1) == "[" and encoded:sub(-1) == "]" then
        encoded = encoded:sub(2, -2)
    end
    return encoded
end

local function postJson(url, payload, queueName, callback)
    if stopped or not validHttps(url) or apiSecret == "" then return false end
    local encoded = jsonObject(payload)
    if not encoded then return false end
    fetchRemote(url, {
        method = "POST",
        queueName = queueName,
        connectionAttempts = 1,
        connectTimeout = 5000,
        maxRedirects = 0,
        postData = encoded,
        headers = {
            ["Content-Type"] = "application/json",
            ["X-API-Key"] = apiSecret
        }
    }, function(_responseData, _responseInfo)
        if callback then callback() end
        -- Deliberately silent: do not spam debugscript for network errors.
    end)
    return true
end

local function loadSettings()
    apiUrl = tostring(get("apiUrl") or "")
    apiSecret = tostring(get("apiSecret") or "")
    if not validHttps(apiUrl) or not apiUrl:match("/api/mta%-status$") then apiUrl = "" end
    if #apiSecret < 32 then apiSecret = "" end
end

local function getCapacity()
    local override = tonumber(settings.maxPlayersOverride) or 0
    if override > 0 and override <= 10000 then
        return math.floor(override)
    end
    return math.max(1, math.floor(tonumber(getMaxPlayers()) or 1))
end

local function sendStatus()
    if stopped or requestInFlight or apiUrl == "" or apiSecret == "" then return false end
    local payload = {
        serverName = tostring(getServerName() or "MTA Server"):sub(1, 100),
        players = math.max(0, math.floor(tonumber(getPlayerCount()) or 0)),
        maxPlayers = getCapacity(),
        bannerStatus = validHttps(settings.bannerStatus) and settings.bannerStatus or "",
        logoUrl = validHttps(settings.logoUrl) and settings.logoUrl or "",
        bannerTickets = validHttps(settings.bannerTickets) and settings.bannerTickets or ""
    }
    requestInFlight = true
    local sent = postJson(apiUrl, payload, "dripx_mta_status", function()
        requestInFlight = false
    end)
    if not sent then requestInFlight = false end
    return sent
end

local function sendPlayerEvent(eventName, player)
    if stopped or settings.sendJoinQuitLogs == false or apiUrl == "" or apiSecret == "" then return end
    if not isElement(player) or getElementType(player) ~= "player" then return end
    local name = tostring(getPlayerName(player) or "Unknown"):gsub("#%x%x%x%x%x%x", ""):sub(1, 48)
    local eventUrl = apiUrl:gsub("/api/mta%-status$", "/api/mta-event")
    postJson(eventUrl, {
        event = eventName,
        playerName = name
    }, "dripx_mta_events", nil)
end

local function scheduleStatus()
    if stopped then return end
    setTimer(sendStatus, 750, 1)
end

addEventHandler("onResourceStart", resourceRoot, function()
    loadSettings()
    if reportTimer and isTimer(reportTimer) then killTimer(reportTimer) end
    setTimer(sendStatus, 2000, 1)
    reportTimer = setTimer(sendStatus, REPORT_INTERVAL_MS, 0)
end)

addEventHandler("onPlayerJoin", root, function()
    sendPlayerEvent("join", source)
    scheduleStatus()
end)

addEventHandler("onPlayerQuit", root, function()
    sendPlayerEvent("quit", source)
    scheduleStatus()
end)

addEventHandler("onResourceStop", resourceRoot, function()
    stopped = true
    if reportTimer and isTimer(reportTimer) then killTimer(reportTimer) end
end)

-- No addEvent(..., true), triggerServerEvent handlers or remote-callable exports.
