using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("CloudVault")]
[assembly: AssemblyProduct("CloudVault")]
[assembly: AssemblyDescription("CloudVault para Windows")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string settings = AppDomain.CurrentDomain.BaseDirectory;
        AppDomain.CurrentDomain.AssemblyResolve += ResolveWebViewAssembly;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 2 && args[0] == "--self-test")
            return SelfTest(settings, args[1]);
        return RunDesktop(settings);
    }

    private static Assembly ResolveWebViewAssembly(object sender, ResolveEventArgs e)
    {
        string name = new AssemblyName(e.Name).Name;
        string suffix = name == "Microsoft.Web.WebView2.Core" ? "Core" :
            name == "Microsoft.Web.WebView2.WinForms" ? "WinForms" : null;
        if (suffix == null) return null;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("CloudVault.WebView." + suffix))
        using (var bytes = new MemoryStream())
        {
            stream.CopyTo(bytes);
            return Assembly.Load(bytes.ToArray());
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunDesktop(string settings)
    {
        using (var instance = new Mutex(false, @"Local\CloudVault-" + Environment.UserName))
        {
            try
            {
                if (!instance.WaitOne(0))
                {
                    MessageBox.Show("O CloudVault já está aberto.", "CloudVault");
                    return 0;
                }
            }
            catch (AbandonedMutexException) { }
            try
            {
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CloudVault");
                Application.Run(new DesktopWindow(settings, data));
                return 0;
            }
            finally { instance.ReleaseMutex(); }
        }
    }

    private static int SelfTest(string settings, string data)
    {
        string message;
        int code = 0;
        try
        {
            using (var service = new LocalService())
            {
                Uri address = service.Start(settings, data, true, CancellationToken.None);
                using (var browser = new WebClient())
                {
                    browser.Proxy = null;
                    var html = browser.DownloadString(address);
                    var session = browser.DownloadString(new Uri(address, "/api/session"));
                    var health = browser.DownloadString(new Uri(address, "/api/health"));
                    var manifest = browser.DownloadString(new Uri(address, "/manifest.webmanifest"));
                    if (!html.Contains("CloudVault") || !html.Contains("/assets/") ||
                        !session.Contains("\"configured\":false") || !health.Contains("\"ok\":true") ||
                        !manifest.Contains("\"CloudVault\""))
                        throw new InvalidDataException("A interface, a API ou o manifesto não respondeu como esperado.");
                    var setupToken = address.Fragment.Substring("#setup=".Length);
                    var setupUrl = new Uri(address, "/api/desktop/setup");
                    var origin = address.GetLeftPart(UriPartial.Authority);
                    var fixture = "{\"credentials\":{\"apiId\":\"100\",\"apiHash\":\"" + new string('a', 32) +
                        "\"},\"token\":\"";
                    browser.Headers["Origin"] = origin;
                    browser.Headers[HttpRequestHeader.ContentType] = "application/json";
                    try
                    {
                        browser.UploadString(setupUrl, fixture + new string('a', 43) + "\"}");
                        throw new InvalidDataException("A configuração aceitou um token inválido.");
                    }
                    catch (WebException denied)
                    {
                        var response = denied.Response as HttpWebResponse;
                        if (response == null || response.StatusCode != HttpStatusCode.Forbidden) throw;
                        response.Dispose();
                    }
                    browser.Headers["Origin"] = origin;
                    browser.Headers[HttpRequestHeader.ContentType] = "application/json";
                    browser.UploadString(setupUrl, fixture + setupToken + "\"}");
                    bool configured = false;
                    for (int i = 0; i < 40 && !configured; i++)
                    {
                        Thread.Sleep(200);
                        try
                        {
                            string after = browser.DownloadString(new Uri(address, "/api/session"));
                            configured = after.Contains("\"configured\":true");
                        }
                        catch (WebException) { }
                    }
                    if (!configured) throw new InvalidDataException("As credenciais do autoteste não foram carregadas.");
                }
                DesktopWindow.VerifyEmbeddedPage(address, data);
                message = "Executável verificado: janela WebView2, interface, API e configuração local disponíveis.";
            }
        }
        catch (Exception error) { code = 1; message = error.ToString(); }
        File.WriteAllText(Path.Combine(data, "resultado.txt"), message, Encoding.UTF8);
        return code;
    }
}

internal sealed class LocalService : IDisposable
{
    private readonly object sync = new object();
    private Process process;
    private bool stopped;

    public Uri Start(string settings, string data, bool test, CancellationToken token)
    {
        string version = RuntimeDirectory(data);
        string node = Path.Combine(version, "node.exe");
        string backend = Path.Combine(version, "backend.mjs");
        Unpack(version);
        token.ThrowIfCancellationRequested();

        var ready = new ManualResetEventSlim();
        var messages = new Queue<string>();
        Uri address = null;
        var options = new ProcessStartInfo(node) {
            Arguments = Quote(backend) + " " + Quote(settings) + " " + Quote(data) + (test ? " self-test" : ""),
            WorkingDirectory = version,
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        options.EnvironmentVariables.Remove("NODE_OPTIONS");
        options.EnvironmentVariables.Remove("NODE_PATH");
        options.EnvironmentVariables.Remove("UV_THREADPOOL_SIZE");
        if (test)
        {
            foreach (var key in new[] { "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_OIDC_CLIENT_ID", "TELEGRAM_OIDC_CLIENT_SECRET", "SESSION_KEY", "PUBLIC_ORIGIN" })
                options.EnvironmentVariables.Remove(key);
        }
        var child = new Process { StartInfo = options };
        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            const string prefix = "CLOUDVAULT_READY ";
            if (e.Data == null || !e.Data.StartsWith(prefix, StringComparison.Ordinal)) return;
            Uri url;
            if (Uri.TryCreate(e.Data.Substring(prefix.Length), UriKind.Absolute, out url) &&
                url.IsLoopback && url.Scheme == Uri.UriSchemeHttp)
            {
                address = url;
                ready.Set();
            }
        };
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (String.IsNullOrWhiteSpace(e.Data)) return;
            lock (messages)
            {
                if (messages.Count == 10) messages.Dequeue();
                messages.Enqueue(e.Data);
            }
        };
        lock (sync)
        {
            if (stopped) throw new OperationCanceledException();
            if (!child.Start()) throw new InvalidOperationException("O processo local não pôde ser iniciado.");
            process = child;
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
        }
        try
        {
            for (var tick = 0; tick < 240; tick++)
            {
                token.ThrowIfCancellationRequested();
                if (ready.Wait(125, token)) return address;
                if (child.HasExited)
                {
                    child.WaitForExit();
                    string details;
                    lock (messages) { details = String.Join(Environment.NewLine, messages.ToArray()); }
                    throw new InvalidOperationException("A API local foi encerrada durante a inicialização." +
                        (details.Length == 0 ? "" : Environment.NewLine + details));
                }
            }
            throw new TimeoutException("A API local levou mais de 30 segundos para iniciar.");
        }
        catch { Dispose(); throw; }
    }

    internal static string RuntimeDirectory(string data) { return Path.Combine(data, "runtime", PackageId.Value); }

    private static void Unpack(string destination)
    {
        if (File.Exists(Path.Combine(destination, ".ready"))) return;
        string parent = Path.GetDirectoryName(destination);
        Directory.CreateDirectory(parent);
        string staging = Path.Combine(parent, ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 10));
        Directory.CreateDirectory(staging);
        try
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("CloudVault.Runtime.zip"))
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
                archive.ExtractToDirectory(staging);
            File.WriteAllText(Path.Combine(staging, ".ready"), PackageId.Value);
            Directory.Move(staging, destination);
        }
        finally
        {
            if (Path.GetDirectoryName(Path.GetFullPath(staging)) == Path.GetFullPath(parent) &&
                Path.GetFileName(staging).StartsWith(".tmp-", StringComparison.Ordinal) && Directory.Exists(staging))
                Directory.Delete(staging, true);
        }
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char letter in value)
        {
            if (letter == '\\') { slashes++; continue; }
            if (letter == '"') result.Append('\\', slashes + 1);
            result.Append('\\', slashes);
            result.Append(letter);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    public void Dispose()
    {
        Process child;
        lock (sync)
        {
            stopped = true;
            child = process;
            process = null;
        }
        if (child == null) return;
        try
        {
            if (!child.HasExited)
            {
                child.StandardInput.Close();
                if (!child.WaitForExit(1200) && !child.HasExited) child.Kill();
            }
        }
        catch (InvalidOperationException) { }
        catch (IOException) { if (!child.HasExited) child.Kill(); }
        finally { child.Dispose(); }
    }
}
