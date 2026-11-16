namespace ParentalControl.Core.Models;

/// <summary>
/// Global application, Telegram bot, auto-update, and overlay settings stored in SQLite.
/// </summary>
public sealed class AppSettings
{
    public bool TelegramEnabled { get; set; }
    public string TelegramBotToken { get; set; } = string.Empty;
    public string TelegramChatId { get; set; } = string.Empty;
    public bool NotifyOnLogin { get; set; } = true;
    public bool NotifyOnLogout { get; set; } = true;
    public bool NotifyOnShutdown { get; set; } = true;
    public bool NotifyOnLimitReached { get; set; } = true;
    public bool ShowCountdownOverlay { get; set; } = true;
    public string AppLanguage { get; set; } = "ar";
    public string TelegramLanguage { get; set; } = "ar";
    public bool AutoUpdateEnabled { get; set; } = true;
    public long TelegramUpdateOffset { get; set; } = 0;
    public bool CloudRelayEnabled { get; set; } = true;
    public string CloudRelayUrl { get; set; } = "https://waqti-relay.cpcontrol.workers.dev";
    public string DeviceId { get; set; } = string.Empty;
    public string PairingCode { get; set; } = string.Empty;
    public bool IsCloudPaired { get; set; }
}
