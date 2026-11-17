using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Waqti.Core.Models;
using MediaBrush = System.Windows.Media.Brush;
using MediaColor = System.Windows.Media.Color;

namespace Waqti.Overlay;

public partial class CountdownWindow : Window
{
    private const string PipeName = "Waqti_OverlayStatus";

    private static readonly MediaBrush BrushNormal = new SolidColorBrush(MediaColor.FromRgb(0x38, 0xBD, 0xF8));
    private static readonly MediaBrush BrushWarning = new SolidColorBrush(MediaColor.FromRgb(0xFB, 0xBF, 0x24));
    private static readonly MediaBrush BrushCritical = new SolidColorBrush(MediaColor.FromRgb(0xF8, 0x71, 0x71));

    private readonly DispatcherTimer _tickTimer;
    private readonly DispatcherTimer _syncTimer;
    private readonly int _sessionId;

    private int _remainingSeconds = -1;
    private bool _allowClose = false;
    private bool _isSyncing;
    private bool _chimed5Min;
    private bool _chimed1Min;
    private bool _isPaused;
    private ChildDashboardWindow? _dashboardWindow;

    public CountdownWindow()
    {
        InitializeComponent();
        _sessionId = Process.GetCurrentProcess().SessionId;

        PositionWindow();

        Closing += (_, e) =>
        {
            if (!_allowClose) e.Cancel = true;
        };

        _tickTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _tickTimer.Tick += (_, _) => OnLocalTick();
        _tickTimer.Start();

        _syncTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _syncTimer.Tick += async (_, _) => await SyncStatusAsync();
        _syncTimer.Start();

        Loaded += async (_, _) => await SyncStatusAsync();
    }

    private void PositionWindow()
    {
        var workArea = SystemParameters.WorkArea;
        Left = workArea.Right - Width - 16;
        Top = workArea.Top + 16;
    }

    private void CardBorder_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        var startPos = PointToScreen(e.GetPosition(this));
        if (e.ButtonState == MouseButtonState.Pressed)
        {
            try
            {
                DragMove();
            }
            catch
            {
                // Ignore drag exceptions
            }
        }

        var endPos = PointToScreen(Mouse.GetPosition(this));
        if ((endPos - startPos).Length < 12)
        {
            OpenChildDashboard();
        }
    }

    public void OpenChildDashboard()
    {
        if (_dashboardWindow is null || !_dashboardWindow.IsLoaded)
        {
            _dashboardWindow = new ChildDashboardWindow();
        }

        _dashboardWindow.Show();
        _dashboardWindow.WindowState = WindowState.Normal;
        _dashboardWindow.Topmost = true;
        _dashboardWindow.Activate();
        _dashboardWindow.Focus();
    }

    private void OnLocalTick()
    {
        if (_remainingSeconds > 0)
        {
            _remainingSeconds--;

            if (_remainingSeconds == 300 && !_chimed5Min)
            {
                _chimed5Min = true;
                try { System.Media.SystemSounds.Exclamation.Play(); } catch { }
            }
            else if (_remainingSeconds == 60 && !_chimed1Min)
            {
                _chimed1Min = true;
                try { System.Media.SystemSounds.Hand.Play(); } catch { }
            }
            else if (_remainingSeconds > 300)
            {
                _chimed5Min = false;
                _chimed1Min = false;
            }
        }

        UpdateCountdownDisplay();
    }

    private void UpdateCountdownDisplay()
    {
        if (_isPaused)
        {
            CountdownText.Foreground = BrushWarning;
            StatusDot.Fill = BrushWarning;
            return;
        }

        if (_remainingSeconds < 0)
        {
            CountdownText.Text = "∞";
            CountdownText.Foreground = BrushNormal;
            StatusDot.Fill = BrushNormal;
            return;
        }

        var span = TimeSpan.FromSeconds(_remainingSeconds);
        CountdownText.Text = span.TotalHours >= 1
            ? $"{(int)span.TotalHours:D2}:{span.Minutes:D2}:{span.Seconds:D2}"
            : $"{span.Minutes:D2}:{span.Seconds:D2}";

        var accent = _remainingSeconds <= 300
            ? BrushCritical
            : _remainingSeconds <= 900
                ? BrushWarning
                : BrushNormal;

        CountdownText.Foreground = accent;
        StatusDot.Fill = accent;

        if (!Topmost) Topmost = true;
    }

    private async Task SyncStatusAsync()
    {
        if (_isSyncing) return;
        _isSyncing = true;

        try
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(1500);

            using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
            using var reader = new StreamReader(pipe, leaveOpen: true);

            var (activeApp, activeSite) = ActiveWindowTracker.GetActiveAppAndSite();
            var encApp = Uri.EscapeDataString(activeApp ?? string.Empty);
            var encSite = Uri.EscapeDataString(activeSite ?? string.Empty);

            await writer.WriteLineAsync($"STATUS:{_sessionId}:{encApp}:{encSite}");
            var json = await reader.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(json)) return;

            var status = JsonSerializer.Deserialize<OverlayStatus>(json);
            if (status is null) return;

            if (!status.ShouldShow)
            {
                if (Visibility != Visibility.Collapsed)
                {
                    Visibility = Visibility.Collapsed;
                    Width = 0;
                    Height = 0;
                    ShowInTaskbar = false;
                }
                _tickTimer.Stop();
                _dashboardWindow?.Close();

                if (!string.IsNullOrWhiteSpace(status.BroadcastMessage))
                {
                    var msgWin = new NotificationMessageWindow(status.BroadcastMessage);
                    msgWin.Show();
                }
                return;
            }

            if (Visibility != Visibility.Visible)
            {
                Width = 240;
                Height = 64;
                PositionWindow();
                Visibility = Visibility.Visible;
                if (!_tickTimer.IsEnabled) _tickTimer.Start();
            }

            _isPaused = status.IsPaused;
            _remainingSeconds = status.EffectiveSecondsRemaining < 0 ? -1 : Math.Max(0, status.EffectiveSecondsRemaining);
            UsernameText.Text = string.IsNullOrWhiteSpace(status.Username) ? "PC" : status.Username;

            var lang = "ar";
            try
            {
                var cul = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.ToLowerInvariant();
                if (cul == "fr" || cul == "en") lang = cul;
            }
            catch { }

            if (status.IsPaused)
            {
                CountdownText.Text = lang == "en" ? "PAUSED" : lang == "fr" ? "PAUSE" : "مستقطع";
                HeaderTitleText.Text = lang == "en" ? "Session Paused" : lang == "fr" ? "Session en pause" : "وقت مستقطع";
                SubInfoText.Text = string.IsNullOrWhiteSpace(status.PauseUntil)
                    ? (lang == "en" ? "Break active" : lang == "fr" ? "Pause active" : "استراحة نشطة")
                    : (lang == "en" ? $"Break until {status.PauseUntil}" : lang == "fr" ? $"Pause jusqu'à {status.PauseUntil}" : $"استراحة حتى {status.PauseUntil}");
            }
            else if (status.EffectiveSecondsRemaining < 0)
            {
                HeaderTitleText.Text = lang == "en" ? "Admin Session" : lang == "fr" ? "Compte Admin" : "حساب مسؤول";
                CountdownText.Text = "∞";
                SubInfoText.Text = lang == "en" ? "Unlimited time • Unrestricted" : lang == "fr" ? "Temps illimité" : "وقت مفتوح • بدون قيود";
            }
            else
            {
                HeaderTitleText.Text = lang == "en" ? "Time Remaining" : lang == "fr" ? "Temps restant" : "الوقت المتبقي";
                SubInfoText.Text = lang == "en"
                    ? $"Until {status.ScheduleEnd} • {status.MinutesUsed}/{status.DailyMinutes} min"
                    : lang == "fr"
                    ? $"Jusqu'à {status.ScheduleEnd} • {status.MinutesUsed}/{status.DailyMinutes} min"
                    : $"حتى {status.ScheduleEnd} • {status.MinutesUsed}/{status.DailyMinutes} دقيقة";
            }

            UpdateCountdownDisplay();

            if (!string.IsNullOrWhiteSpace(status.BroadcastMessage))
            {
                var msgWin = new NotificationMessageWindow(status.BroadcastMessage);
                msgWin.Topmost = true;
                msgWin.Show();
                msgWin.Activate();
                msgWin.Focus();
            }
        }
        catch
        {
            // Service may be restarting; keep ticking locally until next poll
        }
        finally
        {
            _isSyncing = false;
        }
    }
}
