using System.Diagnostics;
using System.Text.Json;
using Waqti.Core.Cloud;
using Waqti.Core.Data;
using Waqti.Core.Localization;
using Waqti.Core.Models;
using Waqti.Core.Platform;
using Waqti.Core.Security;

namespace Waqti.Service;

/// <summary>
/// Background worker that synchronizes the PC state with the Cloud Relay 24/7,
/// sends device heartbeats, and executes queued remote commands.
/// </summary>
public sealed class CloudRelayWorker : BackgroundService
{
    private readonly CloudRelayClient _client;
    private readonly SessionTracker _sessionTracker;
    private readonly OverlayHostWorker _overlayHost;
    private readonly Serilog.ILogger _logger;
    private readonly DateTime _serviceStartedAt = DateTime.Now;
    private string _deviceId = string.Empty;
    private bool _isRegistered = false;

    public CloudRelayWorker(
        CloudRelayClient client,
        SessionTracker sessionTracker,
        OverlayHostWorker overlayHost,
        Serilog.ILogger logger)
    {
        _client = client;
        _sessionTracker = sessionTracker;
        _overlayHost = overlayHost;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.Information("Cloud Relay Worker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            var settings = SettingsRepository.Get();
            if (!settings.CloudRelayEnabled || string.IsNullOrWhiteSpace(settings.CloudRelayUrl))
            {
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
                continue;
            }

            // Dynamically ensure we're using the active device ID from settings
            var currentId = SettingsRepository.GetOrCreateDeviceId();
            if (_deviceId != currentId)
            {
                _deviceId = currentId;
                _isRegistered = false;
            }

            var hadCommands = false;
            try
            {
                // 1. Ensure registered once or if pairing code is missing
                if (!_isRegistered || string.IsNullOrWhiteSpace(settings.PairingCode))
                {
                    var regResult = await _client.RegisterAsync(
                        settings.CloudRelayUrl,
                        _deviceId,
                        Environment.MachineName,
                        stoppingToken);

                    if (regResult is not null)
                    {
                        SettingsRepository.SavePairingInfo(regResult.PairingCode, regResult.IsPaired);
                        _isRegistered = true;
                    }
                }

                // 2. Build status snapshot
                var status = BuildStatusSnapshot();

                // 3. Send Heartbeat & pull pending commands
                var hbResult = await _client.SendHeartbeatAsync(
                    settings.CloudRelayUrl,
                    _deviceId,
                    status,
                    stoppingToken);

                if (hbResult is not null)
                {
                    SettingsRepository.SavePairingInfo(settings.PairingCode, hbResult.IsPaired);

                    // 4. Process returned commands
                    if (hbResult.Commands.Count > 0)
                    {
                        hadCommands = true;
                        foreach (var cmd in hbResult.Commands)
                        {
                            await ExecuteCommandAsync(settings.CloudRelayUrl, cmd, stoppingToken);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning("Error syncing with Cloud Relay: {Message}", ex.Message);
            }

            // Responsive interval: 10s for snappy Telegram commands; 3s if commands were just processed
            var delaySeconds = hadCommands ? 3 : 10;
            await Task.Delay(TimeSpan.FromSeconds(delaySeconds), stoppingToken);
        }
    }

    private object BuildStatusSnapshot()
    {
        var now = DateTime.Now;
        var today = DateOnly.FromDateTime(now);
        var winUptime = TimeSpan.FromMilliseconds(Environment.TickCount64);
        var srvUptime = now - _serviceStartedAt;

        var usersList = new List<object>();

        foreach (var (sessionId, session) in _sessionTracker.ActiveSessions)
        {
            var user = UserRepository.GetBySid(session.UserSid);
            var limit = user is not null ? LimitRepository.GetByUserId(user.Id) : null;
            var usage = user is not null ? UsageRepository.GetUsage(user.Id, today) : null;
            var used = usage?.MinutesUsed ?? 0;

            if (user is not null && user.IsRestricted && limit is not null)
            {
                var dailyLeft = Math.Max(0, limit.DailyMinutes - used);
                var schedEndDt = now.Date.Add(limit.ScheduleEnd.ToTimeSpan());
                var schedLeft = Math.Max(0, (int)(schedEndDt - now).TotalMinutes);

                usersList.Add(new
                {
                    username = session.Username,
                    sessionId,
                    isRestricted = true,
                    usedToday = used,
                    dailyLimit = limit.DailyMinutes,
                    remainingDaily = dailyLeft,
                    remainingSchedule = schedLeft,
                    scheduleStart = limit.ScheduleStart.ToString("HH:mm"),
                    scheduleEnd = limit.ScheduleEnd.ToString("HH:mm")
                });
            }
            else
            {
                usersList.Add(new
                {
                    username = session.Username,
                    sessionId,
                    isRestricted = false,
                    usedToday = used,
                    dailyLimit = 0,
                    remainingDaily = 0,
                    remainingSchedule = 0,
                    scheduleStart = "00:00",
                    scheduleEnd = "23:59"
                });
            }
        }

        return new
        {
            windowsUptime = $"{(int)winUptime.TotalHours:D2}h {winUptime.Minutes:D2}m",
            serviceUptime = $"{(int)srvUptime.TotalHours:D2}h {srvUptime.Minutes:D2}m",
            users = usersList
        };
    }

    private async Task ExecuteCommandAsync(string relayUrl, CloudCommand cmd, CancellationToken ct)
    {
        _logger.Information("Executing cloud command {Action} ({Id})", cmd.Action, cmd.Id);
        string result = "ok";
        string actionName = cmd.Action;

        try
        {
            switch (cmd.Action.ToLowerInvariant())
            {
                case "adjust_time":
                {
                    var username = cmd.Args.TryGetProperty("username", out var u) ? u.GetString() ?? "" : "";
                    var delta = cmd.Args.TryGetProperty("minutes", out var m) ? m.GetInt32() : 0;
                    if (!string.IsNullOrWhiteSpace(username) && delta != 0)
                    {
                        var user = UserRepository.GetAll().FirstOrDefault(x => x.Username.Equals(username, StringComparison.OrdinalIgnoreCase));
                        if (user is not null)
                        {
                            var limit = LimitRepository.GetByUserId(user.Id);
                            if (limit is not null)
                            {
                                var newMins = Math.Clamp(limit.DailyMinutes + delta, 0, 1440);
                                LimitRepository.Upsert(new LimitConfig
                                {
                                    UserId = user.Id,
                                    DailyMinutes = newMins,
                                    ScheduleStart = limit.ScheduleStart,
                                    ScheduleEnd = limit.ScheduleEnd
                                });
                                actionName = $"تعديل وقت {username} ({delta:+#;-#;0} دقيقة)";
                            }
                        }
                    }
                    break;
                }

                case "lock_screen":
                {
                    var sessionId = cmd.Args.TryGetProperty("sessionId", out var s) ? s.GetInt32() : 1;
                    SessionManager.DisconnectSession(sessionId);
                    actionName = "قفل الشاشة";
                    break;
                }

                case "logoff":
                {
                    var sessionId = cmd.Args.TryGetProperty("sessionId", out var s) ? s.GetInt32() : 1;
                    SessionManager.ForceLogoff(sessionId);
                    actionName = "تسجيل خروج";
                    break;
                }

                case "pause":
                {
                    var minutes = cmd.Args.TryGetProperty("minutes", out var m) ? m.GetInt32() : 30;
                    foreach (var u in UserRepository.GetAll().Where(x => x.IsRestricted))
                    {
                        _overlayHost.PauseUser(u.Username, minutes);
                    }
                    actionName = $"إيقاف مؤقت ({minutes} دقيقة)";
                    break;
                }

                case "resume":
                {
                    foreach (var u in UserRepository.GetAll().Where(x => x.IsRestricted))
                    {
                        _overlayHost.ResumeUser(u.Username);
                    }
                    actionName = "استئناف الجلسة";
                    break;
                }

                case "send_msg":
                {
                    var message = cmd.Args.TryGetProperty("message", out var msg) ? msg.GetString() ?? "" : "";
                    if (!string.IsNullOrWhiteSpace(message))
                    {
                        foreach (var u in UserRepository.GetAll().Where(x => x.IsRestricted))
                        {
                            _overlayHost.SendMessageToUser(u.Username, message);
                        }
                    }
                    actionName = "إرسال رسالة للشاشة";
                    break;
                }

                case "toggle_dns":
                {
                    var current = DnsProtectionManager.IsEnabled();
                    DnsProtectionManager.SetFamilyDns(!current);
                    actionName = !current ? "تفعيل حماية Family DNS" : "إيقاف حماية Family DNS";
                    break;
                }

                case "take_screenshot":
                {
                    actionName = "التقاط صورة شاشة";
                    var shot = await _overlayHost.CaptureScreenshotAsync(ct);
                    if (shot is not null)
                    {
                        await _client.UploadScreenshotAsync(relayUrl, _deviceId, shot.Value.Bytes, ct);
                    }
                    break;
                }

                case "get_top":
                {
                    actionName = "تقرير النشاط والمواقع";
                    var today = DateOnly.FromDateTime(DateTime.Now);
                    var topApps = ActivityRepository.GetAllTopApps(today, 5);
                    var topSites = ActivityRepository.GetAllTopSites(today, 5);

                    var sb = new System.Text.StringBuilder();
                    var lang = SettingsRepository.GetTelegramLanguage();

                    if (lang == "en")
                    {
                        sb.AppendLine($"📊 <b>Daily Activity Report — {Environment.MachineName} ({today:yyyy-MM-dd})</b>\n");
                        sb.AppendLine("📱 <b>Most Used Applications:</b>");
                        if (topApps.Count == 0) sb.AppendLine("  • No application activity recorded today yet.");
                        foreach (var a in topApps)
                        {
                            var mins = Math.Max(1, a.DurationSeconds / 60);
                            sb.AppendLine($"  • <b>{a.Name}</b>: <code>{mins}</code> min");
                        }

                        sb.AppendLine("\n🌐 <b>Most Visited Websites:</b>");
                        if (topSites.Count == 0) sb.AppendLine("  • No website visits recorded today yet.");
                        foreach (var s in topSites)
                        {
                            var mins = Math.Max(1, s.DurationSeconds / 60);
                            sb.AppendLine($"  • <b>{s.Name}</b>: <code>{mins}</code> min");
                        }
                    }
                    else if (lang == "fr")
                    {
                        sb.AppendLine($"📊 <b>Rapport d'activité — {Environment.MachineName} ({today:yyyy-MM-dd})</b>\n");
                        sb.AppendLine("📱 <b>Applications les plus utilisées :</b>");
                        if (topApps.Count == 0) sb.AppendLine("  • Aucune activité enregistrée aujourd'hui.");
                        foreach (var a in topApps)
                        {
                            var mins = Math.Max(1, a.DurationSeconds / 60);
                            sb.AppendLine($"  • <b>{a.Name}</b>: <code>{mins}</code> min");
                        }

                        sb.AppendLine("\n🌐 <b>Sites web les plus visités :</b>");
                        if (topSites.Count == 0) sb.AppendLine("  • Aucun site enregistré aujourd'hui.");
                        foreach (var s in topSites)
                        {
                            var mins = Math.Max(1, s.DurationSeconds / 60);
                            sb.AppendLine($"  • <b>{s.Name}</b>: <code>{mins}</code> min");
                        }
                    }
                    else
                    {
                        sb.AppendLine($"📊 <b>تقرير النشاط اليومي — {Environment.MachineName} ({today:yyyy-MM-dd})</b>\n");
                        sb.AppendLine("📱 <b>أكثر البرامج والتطبيقات استخداماً:</b>");
                        if (topApps.Count == 0) sb.AppendLine("  • لا توجد برامج مسجلة لليوم حتى الآن.");
                        foreach (var a in topApps)
                        {
                            var mins = Math.Max(1, a.DurationSeconds / 60);
                            sb.AppendLine($"  • <b>{a.Name}</b>: <code>{mins}</code> دقيقة");
                        }

                        sb.AppendLine("\n🌐 <b>أكثر المواقع زيارة:</b>");
                        if (topSites.Count == 0) sb.AppendLine("  • لا توجد مواقع مسجلة لليوم حتى الآن.");
                        foreach (var s in topSites)
                        {
                            var mins = Math.Max(1, s.DurationSeconds / 60);
                            sb.AppendLine($"  • <b>{s.Name}</b>: <code>{mins}</code> دقيقة");
                        }
                    }

                    await _client.SendEventAsync(relayUrl, _deviceId, "TOP_ACTIVITY", sb.ToString(), ct: ct);
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.Error(ex, "Failed to execute cloud command {Action}", cmd.Action);
            result = "error: " + ex.Message;
        }

        await _client.AcknowledgeCommandAsync(relayUrl, _deviceId, cmd.Id, actionName, result, ct);
    }
}
