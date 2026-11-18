using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Waqti.Admin.Services;
using Waqti.Core;
using Waqti.Core.Data;
using Waqti.Core.Localization;
using Waqti.Core.Models;
using Waqti.Core.Telegram;

namespace Waqti.Admin.ViewModels;

public partial class SettingsViewModel : ObservableObject
{
    private readonly Action _navigateBack;
    private readonly TelegramApiClient _telegramClient = new();

    [ObservableProperty]
    private bool _hasUpdate;

    [ObservableProperty]
    private string _updateTitleText = string.Empty;

    [ObservableProperty]
    private string _updateStatusBadge = string.Empty;

    [ObservableProperty]
    private bool _isDownloading;

    [ObservableProperty]
    private double _downloadPercentage;

    [ObservableProperty]
    private string _downloadProgressDetail = string.Empty;

    [ObservableProperty]
    private bool _canDownload;

    [ObservableProperty]
    private bool _isReadyToInstall;

    private string? _updateExeDownloadUrl;
    private string? _downloadedFilePath;

    [ObservableProperty]
    private bool _telegramEnabled;

    [ObservableProperty]
    private string _telegramBotInput = string.Empty;

    [ObservableProperty]
    private string _telegramChatId = string.Empty;

    [ObservableProperty]
    private bool _notifyOnLogin = true;

    [ObservableProperty]
    private bool _notifyOnLogout = true;

    [ObservableProperty]
    private bool _notifyOnShutdown = true;

    [ObservableProperty]
    private bool _notifyOnLimitReached = true;

    [ObservableProperty]
    private bool _showCountdownOverlay = true;

    [ObservableProperty]
    private string _appLanguage = "ar";

    [ObservableProperty]
    private string _telegramLanguage = "ar";

    [ObservableProperty]
    private bool _autoUpdateEnabled = true;

    [ObservableProperty]
    private string _currentVersion = AppVersionInfo.VersionString;

    [ObservableProperty]
    private string _statusMessage = string.Empty;

    [ObservableProperty]
    private bool _isBusy;

    [ObservableProperty]
    private bool _cloudRelayEnabled = true;

    [ObservableProperty]
    private string _cloudRelayUrl = "https://waqti-relay.cpcontrol.workers.dev";

    [ObservableProperty]
    private string _deviceId = string.Empty;

    [ObservableProperty]
    private string _pairingCode = string.Empty;

    [ObservableProperty]
    private bool _isCloudPaired;

    [ObservableProperty]
    private string _cloudStatusText = "⚪ بانتظار الاقتران";
    private DispatcherTimer? _pollTimer;

    public SettingsViewModel(Action navigateBack)
    {
        _navigateBack = navigateBack;
    }

    public void Load()
    {
        var s = SettingsRepository.Get();
        TelegramEnabled = s.TelegramEnabled;
        TelegramBotInput = s.TelegramBotToken;
        TelegramChatId = s.TelegramChatId;
        NotifyOnLogin = s.NotifyOnLogin;
        NotifyOnLogout = s.NotifyOnLogout;
        NotifyOnShutdown = s.NotifyOnShutdown;
        NotifyOnLimitReached = s.NotifyOnLimitReached;
        ShowCountdownOverlay = s.ShowCountdownOverlay;
        AppLanguage = s.AppLanguage;
        TelegramLanguage = s.TelegramLanguage;
        AutoUpdateEnabled = s.AutoUpdateEnabled;
        CloudRelayEnabled = s.CloudRelayEnabled;
        CloudRelayUrl = s.CloudRelayUrl;
        DeviceId = SettingsRepository.GetOrCreateDeviceId();
        PairingCode = s.PairingCode;
        IsCloudPaired = s.IsCloudPaired;
        UpdateCloudStatus();
        CurrentVersion = AppVersionInfo.VersionString;
        StatusMessage = string.Empty;

        // Auto fetch fresh pairing code if none
        if (string.IsNullOrWhiteSpace(PairingCode))
        {
            _ = RefreshPairingCodeAsync();
        }

        LocalizedStrings.Instance.ApplyLanguage(AppLanguage);

        _pollTimer?.Stop();
        _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        _pollTimer.Tick += (_, _) => CheckPairingStatus();
        _pollTimer.Start();
    }

    private void CheckPairingStatus()
    {
        try
        {
            var s = SettingsRepository.Get();
            if (s.IsCloudPaired != IsCloudPaired || (!string.IsNullOrWhiteSpace(s.PairingCode) && s.PairingCode != PairingCode))
            {
                IsCloudPaired = s.IsCloudPaired;
                if (!string.IsNullOrWhiteSpace(s.PairingCode))
                {
                    PairingCode = s.PairingCode;
                }
                UpdateCloudStatus();
            }
        }
        catch
        {
            // Ignore DB lock
        }
    }

    partial void OnAppLanguageChanged(string value)
    {
        LocalizedStrings.Instance.ApplyLanguage(value);
        UpdateCloudStatus();
        PersistSettings();
    }

    partial void OnTelegramLanguageChanged(string value)
    {
        PersistSettings();
    }

    [RelayCommand]
    private void GoBack()
    {
        _pollTimer?.Stop();
        _navigateBack();
    }

    [RelayCommand]
    private void Save()
    {
        var lang = LocalizedStrings.Instance.CurrentLanguage;
        var token = SettingsRepository.NormalizeBotToken(TelegramBotInput);
        if (TelegramEnabled && string.IsNullOrWhiteSpace(token))
        {
            var warn = lang == "en" ? "Please enter a valid Telegram Bot Token or API URL before enabling Telegram." :
                       lang == "fr" ? "Veuillez saisir un jeton de bot valide avant d'activer Telegram." :
                       "يرجى إدخال رمز بوت تلغرام أو رابط الـ API قبل تفعيل الربط.";
            MessageBox.Show(warn, "Validation", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        TelegramBotInput = token;
        PersistSettings();
        var savedMsg = lang == "en" ? "Settings saved successfully." :
                       lang == "fr" ? "Paramètres enregistrés avec succès." :
                       "تم حفظ الإعدادات بنجاح.";
        StatusMessage = savedMsg;
        MessageBox.Show(savedMsg, "Saved", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    [RelayCommand]
    private async Task TestAndSaveAsync()
    {
        var lang = LocalizedStrings.Instance.CurrentLanguage;
        var token = SettingsRepository.NormalizeBotToken(TelegramBotInput);
        if (string.IsNullOrWhiteSpace(token))
        {
            var warn = lang == "en" ? "Enter a Telegram Bot Token first." :
                       lang == "fr" ? "Entrez d'abord un jeton de bot Telegram." :
                       "أدخل رمز توكن البوت أولاً.";
            MessageBox.Show(warn, "Validation", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        IsBusy = true;
        StatusMessage = lang == "en" ? "Connecting to Telegram Bot API..." :
                        lang == "fr" ? "Connexion à l'API Telegram..." :
                        "جاري الاتصال بـ Telegram Bot API...";
        try
        {
            var bot = await _telegramClient.GetMeAsync(token);
            TelegramBotInput = token;
            TelegramEnabled = true;
            PersistSettings();

            if (!string.IsNullOrWhiteSpace(TelegramChatId))
            {
                var testMsg = lang == "en" ? $"✅ <b>Connected successfully</b>\n🤖 Bot: @{bot.Username}\n🖥 Device: <b>{Environment.MachineName}</b>" :
                              lang == "fr" ? $"✅ <b>Connexion réussie</b>\n🤖 Bot : @{bot.Username}\n🖥 Appareil : <b>{Environment.MachineName}</b>" :
                              $"✅ <b>تم الاتصال بنجاح</b>\n🤖 البوت: @{bot.Username}\n🖥 الجهاز: <b>{Environment.MachineName}</b>";
                await _telegramClient.SendMessageAsync(token, TelegramChatId.Trim(), testMsg);
                StatusMessage = lang == "en" ? $"Connected to @{bot.Username} and sent test message." :
                                lang == "fr" ? $"Connecté à @{bot.Username} et message test envoyé." :
                                $"تم الاتصال بـ @{bot.Username} وإرسال رسالة اختبار.";
            }
            else
            {
                StatusMessage = lang == "en" ? $"Bot @{bot.Username} verified! Send /start to @{bot.Username} on Telegram, then click Detect Chat ID." :
                                lang == "fr" ? $"Bot @{bot.Username} vérifié ! Envoyez /start à @{bot.Username} puis cliquez sur Détecter." :
                                $"تم التحقق من @{bot.Username}! أرسل /start للبوت ثم اضغط زر اكتشاف المعرف.";
            }
        }
        catch (Exception ex)
        {
            StatusMessage = $"Error: {ex.Message}";
            MessageBox.Show(ex.Message, "Telegram Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private async Task DetectChatIdAsync()
    {
        var lang = LocalizedStrings.Instance.CurrentLanguage;
        var token = SettingsRepository.NormalizeBotToken(TelegramBotInput);
        if (string.IsNullOrWhiteSpace(token))
        {
            var warn = lang == "en" ? "Enter your Bot Token first." :
                       lang == "fr" ? "Entrez d'abord votre jeton de bot." :
                       "أدخل رمز توكن البوت أولاً.";
            MessageBox.Show(warn, "Validation", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        IsBusy = true;
        StatusMessage = lang == "en" ? "Checking recent Telegram messages..." :
                        lang == "fr" ? "Recherche des messages récents..." :
                        "جاري فحص رسائل تلغرام الأخيرة...";
        try
        {
            var updates = await _telegramClient.GetUpdatesAsync(token, offset: 0, timeoutSeconds: 0);
            var latest = updates.LastOrDefault(u => !string.IsNullOrWhiteSpace(u.ChatId));
            if (latest is null)
            {
                var notFound = lang == "en" ? "No messages found. Send /start to your bot in Telegram, then click Detect again." :
                               lang == "fr" ? "Aucun message trouvé. Envoyez /start à votre bot puis réessayez." :
                               "لم يتم العثور على رسائل. أرسل /start للبوت في تلغرام ثم اضغط اكتشاف مجدداً.";
                StatusMessage = notFound;
                MessageBox.Show(notFound, "Chat ID", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            TelegramBotInput = token;
            TelegramChatId = latest.ChatId;
            TelegramEnabled = true;
            PersistSettings();

            var linkedMsg = lang == "en" ? $"✅ <b>Chat ID linked successfully</b>\n🖥 Device: <b>{Environment.MachineName}</b>" :
                            lang == "fr" ? $"✅ <b>Chat ID associé avec succès</b>\n🖥 Appareil : <b>{Environment.MachineName}</b>" :
                            $"✅ <b>تم ربط Chat ID بنجاح</b>\n🖥 الجهاز: <b>{Environment.MachineName}</b>";
            await _telegramClient.SendMessageAsync(token, TelegramChatId, linkedMsg);

            StatusMessage = lang == "en" ? $"Detected Chat ID {TelegramChatId} and saved!" :
                            lang == "fr" ? $"Chat ID {TelegramChatId} détecté et enregistré !" :
                            $"تم اكتشاف Chat ID {TelegramChatId} وحفظه بنجاح!";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Error: {ex.Message}";
            MessageBox.Show(ex.Message, "Telegram Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private async Task CheckUpdateAsync()
    {
        var lang = LocalizedStrings.Instance.CurrentLanguage;
        IsBusy = true;
        StatusMessage = lang == "en" ? "Checking GitHub for updates..." :
                        lang == "fr" ? "Vérification des mises à jour sur GitHub..." :
                        "جاري فحص التحديثات على GitHub...";
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            var url = $"https://api.github.com/repos/{AppVersionInfo.GitHubRepo}/releases/latest";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.UserAgent.Add(new ProductInfoHeaderValue("WaqtiAdmin", AppVersionInfo.VersionString));
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github.v3+json"));

            using var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                StatusMessage = $"GitHub API: {resp.StatusCode}";
                return;
            }

            var json = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var tagName = root.TryGetProperty("tag_name", out var tp) ? tp.GetString() ?? "" : "";
            var cleaned = tagName.TrimStart('v', 'V');

            if (Version.TryParse(cleaned, out var remoteVer) && remoteVer > AppVersionInfo.CurrentVersion)
            {
                HasUpdate = true;
                CanDownload = true;
                IsReadyToInstall = false;
                UpdateTitleText = lang == "en" ? $"🚀 New version available: {tagName}" :
                                  lang == "fr" ? $"🚀 Nouvelle version disponible : {tagName}" :
                                  $"🚀 إصدار جديد متاح الآن: {tagName}";
                UpdateStatusBadge = lang == "en" ? "Ready to download" :
                                    lang == "fr" ? "Prêt au téléchargement" :
                                    "جاهز للتحميل";
                StatusMessage = LocalizationManager.T("update_available", lang, tagName);

                // Find exe asset
                _updateExeDownloadUrl = null;
                if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
                {
                    foreach (var asset in assets.EnumerateArray())
                    {
                        var name = asset.TryGetProperty("name", out var np) ? np.GetString() ?? "" : "";
                        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                        {
                            _updateExeDownloadUrl = asset.TryGetProperty("browser_download_url", out var bp) ? bp.GetString() : null;
                            if (name.Equals("WaqtiSetup.exe", StringComparison.OrdinalIgnoreCase))
                                break;
                        }
                    }
                }
            }
            else
            {
                HasUpdate = false;
                StatusMessage = LocalizationManager.T("update_no_new", lang, AppVersionInfo.VersionString);
                var upToDate = lang == "en" ? $"You are running the latest version (v{AppVersionInfo.VersionString})." :
                               lang == "fr" ? $"Vous utilisez la dernière version (v{AppVersionInfo.VersionString})." :
                               $"أنت تستخدم بالفعل أحدث إصدار (v{AppVersionInfo.VersionString}).";
                MessageBox.Show(upToDate, "Waqti", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            StatusMessage = $"Check failed: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private async Task DownloadUpdateAsync()
    {
        if (string.IsNullOrWhiteSpace(_updateExeDownloadUrl)) return;
        var lang = LocalizedStrings.Instance.CurrentLanguage;

        IsDownloading = true;
        CanDownload = false;
        DownloadPercentage = 0;
        DownloadProgressDetail = lang == "en" ? "Connecting to download server..." : "جاري الاتصال بخادم التحميل...";

        try
        {
            var updateDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "Waqti",
                "updates");
            Directory.CreateDirectory(updateDir);
            var destPath = Path.Combine(updateDir, "WaqtiSetup_update.exe");

            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("WaqtiAdmin", AppVersionInfo.VersionString));

            using var resp = await http.GetAsync(_updateExeDownloadUrl, HttpCompletionOption.ResponseHeadersRead);
            resp.EnsureSuccessStatusCode();

            var totalBytes = resp.Content.Headers.ContentLength ?? 52_000_000L;
            await using (var stream = await resp.Content.ReadAsStreamAsync())
            await using (var fs = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
            {
                var buffer = new byte[81920];
                long totalRead = 0;
                int bytesRead;

                while ((bytesRead = await stream.ReadAsync(buffer)) > 0)
                {
                    await fs.WriteAsync(buffer.AsMemory(0, bytesRead));
                    totalRead += bytesRead;

                    if (totalBytes > 0)
                    {
                        DownloadPercentage = Math.Round((double)totalRead / totalBytes * 100, 1);
                        var mbRead = totalRead / (1024.0 * 1024.0);
                        var mbTotal = totalBytes / (1024.0 * 1024.0);
                        DownloadProgressDetail = $"{DownloadPercentage:0}% ({mbRead:0.0} MB / {mbTotal:0.0} MB)";
                    }
                }
            }

            _downloadedFilePath = destPath;
            IsDownloading = false;
            IsReadyToInstall = true;
            UpdateStatusBadge = lang == "en" ? "Ready to install" : "اكتمل التحميل — جاهز للتثبيت!";
        }
        catch (Exception ex)
        {
            IsDownloading = false;
            CanDownload = true;
            DownloadProgressDetail = $"Download error: {ex.Message}";
        }
    }

    [RelayCommand]
    private void InstallUpdate()
    {
        if (string.IsNullOrWhiteSpace(_downloadedFilePath) || !File.Exists(_downloadedFilePath)) return;

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = _downloadedFilePath,
                Arguments = "/SP-",
                UseShellExecute = true
            };
            Process.Start(psi);
            Application.Current.Shutdown(0);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Failed to launch installer: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void PersistSettings()
    {
        SettingsRepository.Save(new AppSettings
        {
            TelegramEnabled = TelegramEnabled,
            TelegramBotToken = SettingsRepository.NormalizeBotToken(TelegramBotInput),
            TelegramChatId = TelegramChatId.Trim(),
            NotifyOnLogin = NotifyOnLogin,
            NotifyOnLogout = NotifyOnLogout,
            NotifyOnShutdown = NotifyOnShutdown,
            NotifyOnLimitReached = NotifyOnLimitReached,
            ShowCountdownOverlay = ShowCountdownOverlay,
            AppLanguage = AppLanguage,
            TelegramLanguage = TelegramLanguage,
            AutoUpdateEnabled = AutoUpdateEnabled,
            CloudRelayEnabled = CloudRelayEnabled,
            CloudRelayUrl = CloudRelayUrl.Trim(),
            DeviceId = DeviceId,
            PairingCode = PairingCode,
            IsCloudPaired = IsCloudPaired
        });
    }

    [RelayCommand]
    private async Task RefreshPairingCodeAsync()
    {
        try
        {
            var client = new Waqti.Core.Cloud.CloudRelayClient();
            var res = await client.RegisterAsync(CloudRelayUrl, DeviceId, Environment.MachineName);
            if (res is not null && !string.IsNullOrWhiteSpace(res.PairingCode))
            {
                PairingCode = res.PairingCode;
                IsCloudPaired = res.IsPaired;
                SettingsRepository.SavePairingInfo(res.PairingCode, res.IsPaired);
                UpdateCloudStatus();
            }
        }
        catch {}
    }

    [RelayCommand]
    private void OpenTelegramBot()
    {
        var url = string.IsNullOrWhiteSpace(PairingCode)
            ? "https://t.me/Waqti_bot"
            : $"https://t.me/Waqti_bot?start={PairingCode}";
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch {}
    }

    private void UpdateCloudStatus()
    {
        if (IsCloudPaired)
        {
            CloudStatusText = LocalizedStrings.Instance["status_cloud_connected"];
        }
        else
        {
            CloudStatusText = LocalizedStrings.Instance["status_cloud_waiting"];
        }
    }
}
