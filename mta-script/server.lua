-- DRIP X SHOP · MTA Status Bridge
-- Server-side only. No custom remote events are declared by this resource.
-- Silent reporting: no chat messages, notifications, outputChatBox or debug output.

local REPORT_INTERVAL_MS = 30000
local apiUrl = ""
local apiSecret = ""
local reportTimer = nil
local requestInFlight = false
local stopped = false

local function loadSettings()
    apiUrl = tostring(get("apiUrl") or "")
    apiSecret = tostring(get("apiSecret") or "")
    if not apiUrl:match("^https://") or not apiUrl:match("/api/mta%-status$") then
        apiUrl = ""
    end
    if #apiSecret < 32 then
        apiSecret = ""
    end
end

local function sendStatus()
    if stopped or requestInFlight or apiUrl == "" or apiSecret == "" then
        return false
    end

    local playerCount = tonumber(getPlayerCount()) or 0
    local maxPlayers = tonumber(getMaxPlayers()) or 0
    local serverName = tostring(getServerName() or "MTA Server")

    if maxPlayers < 1 then
        return false
    end

    local payload = {
        serverName = serverName,
        players = math.max(0, math.floor(playerCount)),
        maxPlayers = math.max(1, math.floor(maxPlayers))
    }

    local encoded = toJSON(payload, true)
    if type(encoded) ~= "string" or #encoded < 2 then
        return false
    end

    -- MTA toJSON wraps a top-level table in a JSON array; the API expects the object itself.
    if encoded:sub(1, 1) == "[" and encoded:sub(-1) == "]" then
        encoded = encoded:sub(2, -2)
    end

    requestInFlight = true
    local options = {
        method = "POST",
        queueName = "dripx_mta_status",
        connectionAttempts = 1,
        connectTimeout = 5000,
        maxRedirects = 0,
        postData = encoded,
        headers = {
            ["Content-Type"] = "application/json",
            ["X-API-Key"] = apiSecret
        }
    }

    fetchRemote(apiUrl, options, function(_responseData, _responseInfo)
        requestInFlight = false
        -- Intentionally silent: network failures do not spam debugscript or in-game chat.
    end)

    return true
end

local function scheduleStatus()
    if stopped then return end
    setTimer(sendStatus, 750, 1)
end

addEventHandler("onResourceStart", resourceRoot, function()
    loadSettings()
    if reportTimer and isTimer(reportTimer) then
        killTimer(reportTimer)
    end
    setTimer(sendStatus, 2000, 1)
    reportTimer = setTimer(sendStatus, REPORT_INTERVAL_MS, 0)
end)

addEventHandler("onPlayerJoin", root, scheduleStatus)
addEventHandler("onPlayerQuit", root, scheduleStatus)

addEventHandler("onResourceStop", resourceRoot, function()
    stopped = true
    if reportTimer and isTimer(reportTimer) then
        killTimer(reportTimer)
    end
end)

-- Intentionally no addEvent(..., true), no triggerServerEvent handlers and no
-- client-callable exports. All server values are read directly from MTA's server API.
