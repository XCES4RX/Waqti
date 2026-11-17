using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Waqti.Core.Cloud;

public sealed record CloudRegisterResult(
    bool Success,
    string DeviceId,
    string PairingCode,
    bool IsPaired,
    string BotUsername,
    string BotPairLink);

public sealed record CloudCommand(
    string Id,
    string Action,
    JsonElement Args);

public sealed record CloudHeartbeatResult(
    bool Success,
    bool IsPaired,
    List<CloudCommand> Commands,
    List<string>? PairedUserSids = null);

public sealed class CloudRelayClient
{
    private readonly HttpClient _http;

    public CloudRelayClient(HttpClient? httpClient = null)
    {
        _http = httpClient ?? new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        if (!_http.DefaultRequestHeaders.Contains("User-Agent"))
        {
            _http.DefaultRequestHeaders.Add("User-Agent", "Waqti-Client/1.0.0");
        }
    }

    public async Task<CloudRegisterResult?> RegisterAsync(
        string relayUrl,
        string deviceId,
        string deviceName,
        string? pairingCode = null,
        object? users = null,
        CancellationToken ct = default)
    {
        try
        {
            var url = $"{relayUrl.TrimEnd('/')}/api/device/register";
            var payload = new { deviceId, deviceName, pairingCode, users };
            using var resp = await _http.PostAsJsonAsync(url, payload, ct);
            if (!resp.IsSuccessStatusCode) return null;

            var json = await resp.Content.ReadAsStringAsync(ct);
            var node = JsonNode.Parse(json);
            if (node is null) return null;

            return new CloudRegisterResult(
                node["success"]?.GetValue<bool>() ?? false,
                node["deviceId"]?.GetValue<string>() ?? deviceId,
                node["pairingCode"]?.GetValue<string>() ?? pairingCode ?? string.Empty,
                node["isPaired"]?.GetValue<bool>() ?? false,
                node["botUsername"]?.GetValue<string>() ?? "Waqti_bot",
                node["botPairLink"]?.GetValue<string>() ?? string.Empty);
        }
        catch
        {
            return null;
        }
    }

    public async Task<CloudHeartbeatResult?> SendHeartbeatAsync(
        string relayUrl,
        string deviceId,
        object status,
        object? users = null,
        CancellationToken ct = default)
    {
        try
        {
            var url = $"{relayUrl.TrimEnd('/')}/api/device/heartbeat";
            var payload = new { deviceId, status, users };
            using var resp = await _http.PostAsJsonAsync(url, payload, ct);
            if (!resp.IsSuccessStatusCode) return null;

            var json = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var success = root.TryGetProperty("success", out var s) && s.GetBoolean();
            var isPaired = root.TryGetProperty("isPaired", out var p) && p.GetBoolean();
            var commands = new List<CloudCommand>();

            if (root.TryGetProperty("commands", out var cmds) && cmds.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in cmds.EnumerateArray())
                {
                    var id = item.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? "" : "";
                    var action = item.TryGetProperty("action", out var actProp) ? actProp.GetString() ?? "" : "";
                    var args = item.TryGetProperty("args", out var aProp) ? aProp.Clone() : default;
                    commands.Add(new CloudCommand(id, action, args));
                }
            }

            var pairedUserSids = new List<string>();
            if (root.TryGetProperty("pairedUserSids", out var pSids) && pSids.ValueKind == JsonValueKind.Array)
            {
                foreach (var sidItem in pSids.EnumerateArray())
                {
                    var sidStr = sidItem.GetString();
                    if (!string.IsNullOrWhiteSpace(sidStr))
                    {
                        pairedUserSids.Add(sidStr);
                    }
                }
            }

            return new CloudHeartbeatResult(success, isPaired, commands, pairedUserSids);
        }
        catch
        {
            return null;
        }
    }

    public async Task AcknowledgeCommandAsync(
        string relayUrl,
        string deviceId,
        string commandId,
        string action,
        string result = "ok",
        CancellationToken ct = default)
    {
        try
        {
            var url = $"{relayUrl.TrimEnd('/')}/api/device/ack";
            var payload = new { deviceId, commandId, action, result };
            _ = await _http.PostAsJsonAsync(url, payload, ct);
        }
        catch {}
    }

    public async Task SendEventAsync(
        string relayUrl,
        string deviceId,
        string eventType,
        string text,
        object? keyboard = null,
        CancellationToken ct = default)
    {
        try
        {
            var url = $"{relayUrl.TrimEnd('/')}/api/device/event";
            var payload = new { deviceId, eventType, text, keyboard };
            _ = await _http.PostAsJsonAsync(url, payload, ct);
        }
        catch {}
    }

    public async Task UploadScreenshotAsync(
        string relayUrl,
        string deviceId,
        byte[] jpegBytes,
        CancellationToken ct = default)
    {
        try
        {
            var url = $"{relayUrl.TrimEnd('/')}/api/device/upload-screenshot?deviceId={Uri.EscapeDataString(deviceId)}";
            using var content = new ByteArrayContent(jpegBytes);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
            _ = await _http.PostAsync(url, content, ct);
        }
        catch {}
    }
}
