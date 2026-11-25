using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class DesktopWindow : Form
{
    private readonly LocalService service = new LocalService();
    private readonly CancellationTokenSource cancel = new CancellationTokenSource();
    private readonly WebView2 view;
    private readonly Label status;
    private readonly string data;
    private Form officialWindow;
    private bool openingOfficial;

    internal DesktopWindow(string settings, string data)
    {
        this.data = data;
        Text = "CloudVault";
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(460, 360);
        var area = Screen.PrimaryScreen.WorkingArea;
        ClientSize = new Size(Math.Min(1240, Math.Max(440, area.Width - 70)), Math.Min(790, Math.Max(320, area.Height - 105)));
        BackColor = Color.FromArgb(246, 249, 255);

        view = new WebView2 { Dock = DockStyle.Fill, Visible = false, DefaultBackgroundColor = BackColor };
        status = new Label {
            Text = "Preparando o CloudVault…", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI Semibold", 15), ForeColor = Color.FromArgb(33, 57, 111)
        };
        Controls.Add(view);
        Controls.Add(status);

        Shown += async delegate
        {
            try
            {
                var address = await Task.Run(() => service.Start(settings, data, false, cancel.Token));
                if (cancel.IsCancellationRequested || IsDisposed) return;
                await OpenEmbedded(address);
            }
            catch (OperationCanceledException) { }
            catch (WebView2RuntimeNotFoundException)
            {
                if (!IsDisposed) status.Text = "Instale o Microsoft Edge WebView2 Runtime\ne abra o CloudVault novamente.";
            }
            catch (Exception error)
            {
                if (!IsDisposed && !cancel.IsCancellationRequested)
                    status.Text = "Não foi possível abrir o CloudVault.\n" + error.Message;
            }
        };
        FormClosed += delegate { cancel.Cancel(); service.Dispose(); };
    }

    private async Task OpenEmbedded(Uri address)
    {
        var core = await CreateWebView(view, data, "webview-profile");
        if (cancel.IsCancellationRequested) return;
        Configure(core);
        core.NavigationStarting += async delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsAppOrigin(e.Uri, address)) return;
            e.Cancel = true;
            Uri target;
            if (e.IsUserInitiated && TryOfficialUri(e.Uri, out target)) await OpenOfficial(target);
        };
        core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            e.Cancel = !IsAppOrigin(e.Uri, address) && !e.Uri.StartsWith("blob:" + address.GetLeftPart(UriPartial.Authority) + "/", StringComparison.OrdinalIgnoreCase);
        };
        core.NewWindowRequested += async delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            Uri target;
            if (e.IsUserInitiated && TryOfficialUri(e.Uri, out target)) await OpenOfficial(target);
        };
        core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead && e.IsUserInitiated && IsAppOrigin(e.Uri, address))
                e.State = CoreWebView2PermissionState.Allow;
            else e.State = CoreWebView2PermissionState.Deny;
        };
        core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                status.Hide();
                view.Show();
                view.Focus();
            }
            else if (e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            {
                view.Hide();
                status.Text = "A conexão local foi interrompida.\nFeche e abra o CloudVault para tentar novamente.";
                status.Show();
            }
        };
        core.Navigate(address.AbsoluteUri);
    }

    private async Task OpenOfficial(Uri address)
    {
        if (openingOfficial || cancel.IsCancellationRequested) return;
        if (officialWindow != null && !officialWindow.IsDisposed)
        {
            officialWindow.Activate();
            return;
        }
        openingOfficial = true;
        var portal = new Form {
            Text = address.Host + " — Telegram oficial", StartPosition = FormStartPosition.CenterParent,
            Icon = Icon, Width = Math.Min(920, Width), Height = Math.Min(710, Height), MinimizeBox = false
        };
        var content = new WebView2 { Dock = DockStyle.Fill };
        portal.Controls.Add(content);
        officialWindow = portal;
        portal.FormClosed += delegate { officialWindow = null; };
        portal.Show(this);
        try
        {
            var core = await CreateWebView(content, data, "webview-telegram");
            if (portal.IsDisposed) return;
            Configure(core);
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                Uri next;
                e.Cancel = !TryOfficialUri(e.Uri, out next);
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                Uri next;
                e.Handled = true;
                if (e.IsUserInitiated && TryOfficialUri(e.Uri, out next)) core.Navigate(next.AbsoluteUri);
            };
            core.Navigate(address.AbsoluteUri);
        }
        catch (Exception error)
        {
            if (!portal.IsDisposed) MessageBox.Show(portal, error.Message, "Portal do Telegram", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { openingOfficial = false; }
    }

    private static bool IsAppOrigin(string value, Uri address)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == address.Scheme &&
            uri.Host == address.Host && uri.Port == address.Port && uri.UserInfo.Length == 0;
    }

    private static bool TryOfficialUri(string value, out Uri uri)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps &&
            uri.IsDefaultPort && uri.UserInfo.Length == 0 &&
            (uri.Host == "my.telegram.org" || uri.Host == "core.telegram.org" || uri.Host == "telegram.org" ||
             uri.Host == "oauth.telegram.org" || uri.Host == "t.me");
    }

    private static void Configure(CoreWebView2 core)
    {
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsBuiltInErrorPageEnabled = false;
    }

    private static async Task<CoreWebView2> CreateWebView(WebView2 target, string data, string profile)
    {
        var dll = Path.Combine(LocalService.RuntimeDirectory(data), "webview", "WebView2Loader.dll");
        if (GetModuleHandle("WebView2Loader.dll") == IntPtr.Zero && LoadLibrary(dll) == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "O carregador WebView2 não pôde ser iniciado.");
        var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(data, profile));
        await target.EnsureCoreWebView2Async(environment);
        return target.CoreWebView2;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string file);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string file);

    internal static void VerifyEmbeddedPage(Uri address, string data)
    {
        Exception failure = null;
        using (var host = new Form { Width = 800, Height = 600, ShowInTaskbar = false, Opacity = 0 })
        using (var testView = new WebView2 { Dock = DockStyle.Fill })
        using (var timeout = new System.Windows.Forms.Timer { Interval = 45000 })
        {
            host.Controls.Add(testView);
            timeout.Tick += delegate { failure = new TimeoutException("A interface WebView2 não respondeu no autoteste."); host.Close(); };
            host.Shown += async delegate
            {
                try
                {
                    var core = await CreateWebView(testView, data, "webview-selftest");
                    Configure(core);
                    core.Navigate(address.AbsoluteUri);
                    for (int count = 0; count < 60; count++)
                    {
                        await Task.Delay(200);
                        var ready = await core.ExecuteScriptAsync("Boolean(document.querySelector('h1')?.textContent?.includes('Escolha sua conta'))");
                        if (ready == "true") { host.Close(); return; }
                    }
                    throw new InvalidOperationException("A entrada do CloudVault não apareceu na janela incorporada.");
                }
                catch (Exception error) { failure = error; host.Close(); }
            };
            timeout.Start();
            Application.Run(host);
        }
        if (failure != null) throw failure;
    }
}
