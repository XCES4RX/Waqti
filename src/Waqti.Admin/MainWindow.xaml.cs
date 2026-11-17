using System.Windows;
using Waqti.Admin.ViewModels;

namespace Waqti.Admin;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Closed += OnClosed;
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        if (DataContext is MainViewModel vm)
            vm.StopServicePolling();
    }
}
