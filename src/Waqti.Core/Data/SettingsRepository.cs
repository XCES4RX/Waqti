using System.Text.RegularExpressions;
using Waqti.Core.Models;

namespace Waqti.Core.Data;

/// <summary>
/// Persistence for global application, Telegram, and auto-update settings in the <c>app_settings</c> table.
/// </summary>
public static partial class SettingsRepository
{
    private const string KeyTelegramEnabled = "telegram_enabled";
    private const string KeyTelegramBotToken = "telegram_bot_token";
    private const string KeyTelegramChatId = "telegram_chat_id";
    private const string KeyNotifyOnLogin = "notify_on_login";
    private const string KeyNotifyOnLogout = "notify_on_logout";
    private const string KeyNotifyOnShutdown = "notify_on_shutdown";
    private const string KeyNotifyOnLimitReached = "notify_on_limit_reached";
    private const string KeyShowCountdownOverlay = "show_countdown_overlay";
    private const string KeyAppLanguage = "app_language";
    private const string KeyTelegramLanguage = "telegram_language";
    private const string KeyAutoUpdateEnabled = "auto_update_enabled";
    private const string KeyTelegramUpdateOffset = "telegram_update_offset";
    private const string KeyCloudRelayEnabled = "cloud_relay_enabled";
    private const string KeyCloudRelayUrl = "cloud_relay_url";
    private const string KeyDeviceId = "device_id";
    private const string KeyPairingCode = "pairing_code";
    private const string KeyIsCloudPaired = "is_cloud_paired";

    private static readonly HashSet<string> SensitiveKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        KeyTelegramBotToken,
        KeyDeviceId,
        KeyPairingCode
    };

    public static AppSettings Get()
    {
        using var connection = DatabaseManager.CreateConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT key, value FROM app_settings";

        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            map[reader.GetString(0)] = reader.GetString(1);
        }

        var devId = Security.DataEncryptor.Unprotect(map.GetValueOrDefault(KeyDeviceId, string.Empty));
        var botToken = Security.DataEncryptor.Unprotect(map.GetValueOrDefault(KeyTelegramBotToken, string.Empty));
        var pairCode = Security.DataEncryptor.Unprotect(map.GetValueOrDefault(KeyPairingCode, string.Empty));
        if (string.IsNullOrWhiteSpace(pairCode) || pairCode.Length != 10)
        {
            pairCode = GenerateDevicePairingCode(string.IsNullOrWhiteSpace(devId) ? "PC-DEFAULT" : devId);
        }

        return new AppSettings
        {
            TelegramEnabled = ParseBool(map, KeyTelegramEnabled, false),
            TelegramBotToken = botToken,
            TelegramChatId = map.GetValueOrDefault(KeyTelegramChatId, string.Empty),
            NotifyOnLogin = ParseBool(map, KeyNotifyOnLogin, true),
            NotifyOnLogout = ParseBool(map, KeyNotifyOnLogout, true),
            NotifyOnShutdown = ParseBool(map, KeyNotifyOnShutdown, true),
            NotifyOnLimitReached = ParseBool(map, KeyNotifyOnLimitReached, true),
            ShowCountdownOverlay = ParseBool(map, KeyShowCountdownOverlay, true),
            AppLanguage = NormalizeLanguage(map.GetValueOrDefault(KeyAppLanguage, "ar")),
            TelegramLanguage = NormalizeLanguage(map.GetValueOrDefault(KeyTelegramLanguage, "ar")),
            AutoUpdateEnabled = ParseBool(map, KeyAutoUpdateEnabled, true),
            TelegramUpdateOffset = ParseLong(map, KeyTelegramUpdateOffset, 0),
            CloudRelayEnabled = ParseBool(map, KeyCloudRelayEnabled, true),
            CloudRelayUrl = map.GetValueOrDefault(KeyCloudRelayUrl, "https://waqti-relay.cpcontrol.workers.dev"),
            DeviceId = devId,
            PairingCode = pairCode,
            IsCloudPaired = ParseBool(map, KeyIsCloudPaired, false)
        };
    }

    public static void Save(AppSettings settings)
    {
        var normalizedToken = NormalizeBotToken(settings.TelegramBotToken);

        using var connection = DatabaseManager.CreateConnection();
        using var transaction = connection.BeginTransaction();

        var pairs = new (string Key, string Value)[]
        {
            (KeyTelegramEnabled, settings.TelegramEnabled ? "1" : "0"),
            (KeyTelegramBotToken, Security.DataEncryptor.Protect(normalizedToken)),
            (KeyTelegramChatId, settings.TelegramChatId.Trim()),
            (KeyNotifyOnLogin, settings.NotifyOnLogin ? "1" : "0"),
            (KeyNotifyOnLogout, settings.NotifyOnLogout ? "1" : "0"),
            (KeyNotifyOnShutdown, settings.NotifyOnShutdown ? "1" : "0"),
            (KeyNotifyOnLimitReached, settings.NotifyOnLimitReached ? "1" : "0"),
            (KeyShowCountdownOverlay, settings.ShowCountdownOverlay ? "1" : "0"),
            (KeyAppLanguage, NormalizeLanguage(settings.AppLanguage)),
            (KeyTelegramLanguage, NormalizeLanguage(settings.TelegramLanguage)),
            (KeyAutoUpdateEnabled, settings.AutoUpdateEnabled ? "1" : "0"),
            (KeyTelegramUpdateOffset, settings.TelegramUpdateOffset.ToString()),
            (KeyCloudRelayEnabled, settings.CloudRelayEnabled ? "1" : "0"),
            (KeyCloudRelayUrl, settings.CloudRelayUrl.Trim()),
            (KeyDeviceId, Security.DataEncryptor.Protect(settings.DeviceId.Trim())),
            (KeyPairingCode, Security.DataEncryptor.Protect(settings.PairingCode.Trim())),
            (KeyIsCloudPaired, settings.IsCloudPaired ? "1" : "0")
        };

        using var cmd = connection.CreateCommand();
        cmd.Transaction = transaction;
        cmd.CommandText = """
            INSERT INTO app_settings (key, value)
            VALUES (@key, @value)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """;
        var keyParam = cmd.Parameters.Add("@key", Microsoft.Data.Sqlite.SqliteType.Text);
        var valParam = cmd.Parameters.Add("@value", Microsoft.Data.Sqlite.SqliteType.Text);

        foreach (var (key, value) in pairs)
        {
            keyParam.Value = key;
            valParam.Value = value;
            cmd.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    public static long GetTelegramUpdateOffset()
    {
        using var connection = DatabaseManager.CreateConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_settings WHERE key = @key";
        cmd.Parameters.AddWithValue("@key", KeyTelegramUpdateOffset);
        var result = cmd.ExecuteScalar() as string;
        return long.TryParse(result, out var val) ? val : 0;
    }

    public static void SaveTelegramUpdateOffset(long offset)
    {
        using var connection = DatabaseManager.CreateConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            INSERT INTO app_settings (key, value)
            VALUES (@key, @value)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """;
        cmd.Parameters.AddWithValue("@key", KeyTelegramUpdateOffset);
        cmd.Parameters.AddWithValue("@value", offset.ToString());
        cmd.ExecuteNonQuery();
    }

    public static string GetTelegramLanguage()
    {
        using var connection = DatabaseManager.CreateConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_settings WHERE key = @key";
        cmd.Parameters.AddWithValue("@key", KeyTelegramLanguage);
        var result = cmd.ExecuteScalar() as string;
        return NormalizeLanguage(result);
    }

    public static void SaveTelegramLanguage(string language)
    {
        var norm = NormalizeLanguage(language);
        using var connection = DatabaseManager.CreateConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            INSERT INTO app_settings (key, value)
            VALUES (@key, @value)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """;
        cmd.Parameters.AddWithValue("@key", KeyTelegramLanguage);
        cmd.Parameters.AddWithValue("@value", norm);
        cmd.ExecuteNonQuery();
    }

    public static string NormalizeLanguage(string? lang)
    {
        if (string.IsNullOrWhiteSpace(lang)) return "ar";
        var lower = lang.Trim().ToLowerInvariant();
        if (lower.StartsWith("en")) return "en";
        if (lower.StartsWith("fr")) return "fr";
        return "ar";
    }

    /// <summary>
    /// Accepts either a raw Telegram bot token or a full Telegram Bot API URL
    /// (e.g. https://api.telegram.org/bot123456:ABC.../getMe) and extracts the token.
    /// </summary>
    public static string NormalizeBotToken(string? rawInput)
    {
        if (string.IsNullOrWhiteSpace(rawInput)) return string.Empty;

        var trimmed = rawInput.Trim();
        var match = BotUrlRegex().Match(trimmed);
        if (match.Success)
        {
            return match.Groups[1].Value;
        }

        if (trimmed.StartsWith("bot", StringComparison.OrdinalIgnoreCase) && trimmed.Contains(':'))
        {
            return trimmed[3..];
        }

        return trimmed;
    }

    private static bool ParseBool(Dictionary<string, string> map, string key, bool defaultValue)
    {
        if (!map.TryGetValue(key, out var raw)) return defaultValue;
        return raw == "1" || raw.Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    private static long ParseLong(Dictionary<string, string> map, string key, long defaultValue)
    {
        if (!map.TryGetValue(key, out var raw)) return defaultValue;
        return long.TryParse(raw, out var val) ? val : defaultValue;
    }

    [GeneratedRegex(@"api\.telegram\.org/bot([^/\s?]+)", RegexOptions.IgnoreCase)]
    private static partial Regex BotUrlRegex();

    public static string? GetCustomSetting(string key)
    {
        using var connection = DatabaseManager.CreateConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_settings WHERE key = @key";
        cmd.Parameters.AddWithValue("@key", key);
        var result = cmd.ExecuteScalar()?.ToString();
        if (result is not null && SensitiveKeys.Contains(key))
        {
            return Security.DataEncryptor.Unprotect(result);
        }
        return result;
    }

    public static void SetCustomSetting(string key, string value)
    {
        var toSave = SensitiveKeys.Contains(key) ? Security.DataEncryptor.Protect(value) : value;
        using var connection = DatabaseManager.CreateConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            INSERT INTO app_settings (key, value) VALUES (@key, @value)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            """;
        cmd.Parameters.AddWithValue("@key", key);
        cmd.Parameters.AddWithValue("@value", toSave);
        cmd.ExecuteNonQuery();
    }

    public static string GetOrCreateDeviceId()
    {
        var existing = GetCustomSetting(KeyDeviceId);
        if (!string.IsNullOrWhiteSpace(existing)) return existing;

        var newId = "PC-" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();
        SetCustomSetting(KeyDeviceId, newId);
        return newId;
    }

    public static void SavePairingInfo(string pairingCode, bool isPaired)
    {
        SetCustomSetting(KeyPairingCode, pairingCode);
        SetCustomSetting(KeyIsCloudPaired, isPaired ? "1" : "0");
    }

    public static string GenerateUserPairingCode(string deviceId, string sid)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes($"WAQTI_USER:{deviceId}:{sid}"));
        ulong val = System.BitConverter.ToUInt64(hash, 0);
        long pin = 1000000000L + (long)(val % 9000000000L);
        return pin.ToString("D10");
    }

    public static string GenerateDevicePairingCode(string deviceId)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes($"WAQTI_DEV:{deviceId}"));
        ulong val = System.BitConverter.ToUInt64(hash, 0);
        long pin = 1000000000L + (long)(val % 9000000000L);
        return pin.ToString("D10");
    }

    public static bool IsUserCloudPaired(string sid)
    {
        var val = GetCustomSetting($"user_paired_{sid}");
        return val == "1";
    }

    public static void SetUserCloudPaired(string sid, bool isPaired)
    {
        SetCustomSetting($"user_paired_{sid}", isPaired ? "1" : "0");
    }
}
