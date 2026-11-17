using Microsoft.Extensions.Hosting.WindowsServices;
using Waqti.Core.Cloud;
using Waqti.Core.Data;
using Waqti.Core.Logging;
using Waqti.Core.Telegram;
using Waqti.Service;

DatabaseManager.Initialize();
var logger = LoggingConfig.CreateLogger("Service");
logger.Information("Waqti Service starting");

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddSingleton(logger);
builder.Services.AddSingleton<TelegramApiClient>();
builder.Services.AddSingleton<TelegramNotifier>();
builder.Services.AddSingleton<CloudRelayClient>();
builder.Services.AddSingleton<SessionTracker>();
builder.Services.AddSingleton<OverlayHostWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OverlayHostWorker>());
builder.Services.AddHostedService<UsageMonitorWorker>();
builder.Services.AddSingleton<AutoUpdateWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<AutoUpdateWorker>());
builder.Services.AddHostedService<TelegramBotWorker>();
builder.Services.AddHostedService<CloudRelayWorker>();
builder.Services.AddSingleton<IHostLifetime>(sp =>
{
    var env = sp.GetRequiredService<IHostEnvironment>();
    var appLifetime = sp.GetRequiredService<IHostApplicationLifetime>();
    var loggerFactory = sp.GetRequiredService<ILoggerFactory>();
    var hostOptions = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<HostOptions>>();
    var serviceOptions = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<WindowsServiceLifetimeOptions>>();
    var sessionTracker = sp.GetRequiredService<SessionTracker>();
    var notifier = sp.GetRequiredService<TelegramNotifier>();
    var serilogLogger = sp.GetRequiredService<Serilog.ILogger>();

    return new WaqtiServiceLifetime(
        env, appLifetime, loggerFactory, hostOptions, serviceOptions, sessionTracker, notifier, serilogLogger);
});

var host = builder.Build();

var sessionTracker = host.Services.GetRequiredService<SessionTracker>();
sessionTracker.Initialize();

host.Run();
