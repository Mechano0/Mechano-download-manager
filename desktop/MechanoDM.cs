// Mechano DM.exe: the Windows program.
//
//  - runs the download engine (Node.js, hidden) as a child process and stops it on exit
//    (a Windows "job object" makes sure it never keeps running on its own)
//  - tray icon + menu, notifications
//  - the main window: a real window hosting the app page with WebView2 (no browser window,
//    shows as "Mechano Download Manager" in Task Manager and on the taskbar, can be pinned)
//  - "New download" window: floats on top of whatever you are using, movable, with
//    quality + save-folder choice
//  - "Download complete" window: Open / Open folder
//
// Mechano DM.exe             start (or show the window if it is already running)
// Mechano DM.exe -Background start without showing the window ("Start with Windows")
//
// Build (from the app folder):
//   csc /target:winexe /win32icon:assets\mdm.ico /r:System.Windows.Forms.dll /r:System.Drawing.dll
//       /r:System.Web.Extensions.dll /r:lib\Microsoft.Web.WebView2.Core.dll
//       /r:lib\Microsoft.Web.WebView2.WinForms.dll /out:"Mechano DM.exe" desktop\MechanoDM.cs
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Mechano Download Manager")]
[assembly: AssemblyProduct("Mechano Download Manager")]
[assembly: AssemblyDescription("Mechano Download Manager")]
[assembly: AssemblyCompany("Mechano")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

static class Program
{
    public const string AppId = "Mechano.DownloadManager";
    public const string Title = "Mechano Download Manager";
    public static string Dir;

    [STAThread]
    static int Main(string[] args)
    {
        Dir = AppDomain.CurrentDomain.BaseDirectory;
        string lib = Path.Combine(Dir, "lib");
        // WebView2 files live in lib\ (keeps the main folder tidy)
        AppDomain.CurrentDomain.AssemblyResolve += delegate (object s, ResolveEventArgs e)
        {
            string p = Path.Combine(lib, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(p) ? Assembly.LoadFrom(p) : null;
        };
        Native.SetDllDirectory(lib);
        try { Native.SetProcessDPIAware(); } catch { }
        Native.SetCurrentProcessExplicitAppUserModelID(AppId); // own taskbar button + pin target

        bool background = args.Any(a => a.Equals("-Background", StringComparison.OrdinalIgnoreCase));
        bool created;
        var mutex = new Mutex(true, @"Local\MechanoDM.Host", out created);
        if (!created)
        {
            // Already running: ask it to show its window.
            try { using (var ev = EventWaitHandle.OpenExisting(@"Local\MechanoDM.Show")) ev.Set(); } catch { }
            return 0;
        }
        int code = Run(background);
        GC.KeepAlive(mutex);
        return code;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static int Run(bool background)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Host(background));
        return 0;
    }

    public static Icon AppIcon(int size)
    {
        try { return new Icon(Path.Combine(Dir, @"assets\mdm.ico"), size, size); } catch { return SystemIcons.Application; }
    }

    public static Image Logo()
    {
        try { return Image.FromFile(Path.Combine(Dir, @"assets\logo-mark-64.png")); } catch { return null; }
    }

    /** Small troubleshooting log: data\host.log (kept short). */
    public static void Log(string line)
    {
        try
        {
            string p = Path.Combine(Dir, @"data\host.log");
            if (File.Exists(p) && new FileInfo(p).Length > 256 * 1024) File.Delete(p);
            File.AppendAllText(p, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine, new UTF8Encoding(true)); // BOM: Arabic names read correctly
        }
        catch { }
    }

    /** Interface language for the tray and the small windows (Settings → Language). */
    public static bool Arabic = System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ar";
    public static string L(string en, string ar) { return Arabic ? ar : en; }

    public static string FormatBytes(double n)
    {
        if (n <= 0) return "";
        string[] u = { "B", "KB", "MB", "GB", "TB" };
        int i = 0;
        while (n >= 1024 && i < u.Length - 1) { n /= 1024; i++; }
        return n.ToString(i > 1 ? "0.0" : "0") + " " + u[i];
    }
}

// ====================================================================== engine API (local HTTP)
class Api
{
    public int Port = 9614;
    public string Token = "";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    public string Base { get { return "http://127.0.0.1:" + Port; } }

    public void LoadConfig()
    {
        try
        {
            var cfg = Json.DeserializeObject(File.ReadAllText(Path.Combine(Program.Dir, @"data\config.json"), Encoding.UTF8)) as Dictionary<string, object>;
            if (cfg == null) return;
            if (cfg.ContainsKey("token")) Token = Convert.ToString(cfg["token"]);
            if (cfg.ContainsKey("port")) Port = Convert.ToInt32(cfg["port"]);
        }
        catch { }
    }

    public bool Ping()
    {
        try { Send("GET", "/api/ping", null, 1500); return true; } catch { return false; }
    }

    public object Get(string path, int timeout = 5000) { return Json.DeserializeObject(Send("GET", path, null, timeout)); }
    public object Post(string path, string body, int timeout = 5000) { return Json.DeserializeObject(Send("POST", path, body ?? "{}", timeout)); }

    string Send(string method, string path, string body, int timeout)
    {
        var req = (HttpWebRequest)WebRequest.Create(Base + path);
        req.Method = method;
        req.Timeout = timeout;
        req.ReadWriteTimeout = timeout;
        req.Proxy = null;
        req.KeepAlive = false; // the engine closes idle connections after 5 s; reusing one gave "Stream was not readable"
        req.Headers["x-mdm-token"] = Token;
        if (body != null)
        {
            byte[] b = Encoding.UTF8.GetBytes(body);
            req.ContentType = "application/json";
            req.ContentLength = b.Length;
            using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
        }
        try
        {
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) return r.ReadToEnd();
        }
        catch (WebException we)
        {
            // Read the engine's error message if there is a readable reply (a broken connection has none).
            string msg = null;
            try
            {
                var s = we.Response != null ? we.Response.GetResponseStream() : null;
                if (s != null && s.CanRead)
                    using (var r = new StreamReader(s, Encoding.UTF8))
                    {
                        var err = Json.DeserializeObject(r.ReadToEnd()) as Dictionary<string, object>;
                        if (err != null && err.ContainsKey("error")) msg = Convert.ToString(err["error"]);
                    }
            }
            catch { }
            if (msg != null) throw new Exception(msg);
            throw;
        }
    }

    public static string Str(Dictionary<string, object> d, string k)
    {
        object v;
        return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
    }

    public static string Q(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}

// ====================================================================== tray + engine + popups
class Host : ApplicationContext
{
    readonly bool background;
    readonly Api api = new Api();
    readonly Control invoker = new Control();
    readonly NotifyIcon tray = new NotifyIcon();
    readonly ToolStripMenuItem miCancel = new ToolStripMenuItem("Cancel the pending shut down / sleep");
    readonly ToolStripMenuItem miStartup = new ToolStripMenuItem("Start with Windows");
    readonly ToolStripMenuItem miClipboard = new ToolStripMenuItem("Watch copied links");
    readonly ToolStripMenuItem miOpen = new ToolStripMenuItem("Open Mechano DM");
    readonly ToolStripMenuItem miFolder = new ToolStripMenuItem("Open downloads folder");
    readonly ToolStripMenuItem miExit = new ToolStripMenuItem("Exit");
    readonly ToolStripMenuItem miHidden = new ToolStripMenuItem("Show download windows");
    readonly List<WebConfirmForm> progressWindows = new List<WebConfirmForm>();
    bool toldAboutHidden;
    ClipboardWatcher clip;
    bool clipboardOn = true;
    string language = "auto";
    readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
    readonly Dictionary<string, string> lastStatus = new Dictionary<string, string>();
    readonly Queue<string> confirmQueue = new Queue<string>();
    readonly List<CompleteForm> completes = new List<CompleteForm>();
    Process engine;
    IntPtr killJob = IntPtr.Zero;
    MainForm main;
    IConfirmWindow confirm;
    bool exiting, first = true, pollBusy, toldAboutTray;
    int ticks, restarts, pollFailures;
    bool showComplete = true;
    double warnedAt;

    public Host(bool background)
    {
        this.background = background;
        invoker.CreateControl();
        var h = invoker.Handle; // make BeginInvoke usable

        tray.Icon = Program.AppIcon(16);
        tray.Text = "Mechano DM - starting";
        tray.Visible = true;
        var menu = new ContextMenuStrip();
        miOpen.Click += delegate { ShowMain(); };
        miOpen.Font = new Font(miOpen.Font, FontStyle.Bold);
        menu.Items.Add(miOpen);
        miHidden.Visible = false;
        miHidden.Click += delegate { ShowHiddenWindows(); };
        menu.Items.Add(miHidden);
        miFolder.Click += delegate { OpenDownloads(); };
        menu.Items.Add(miFolder);
        miStartup.Checked = File.Exists(StartupLink);
        miStartup.Click += delegate { ToggleStartup(); };
        menu.Items.Add(miStartup);
        miClipboard.Checked = true;
        miClipboard.Click += delegate
        {
            bool on = !miClipboard.Checked;
            miClipboard.Checked = clipboardOn = on;
            Task.Run(() => Try(() => api.Post("/api/config", "{\"clipboardMonitor\":" + (on ? "true" : "false") + "}")));
        };
        menu.Items.Add(miClipboard);
        miCancel.Visible = false;
        miCancel.Click += delegate { Try(() => api.Post("/api/schedule/cancel-action", "{}")); tray.ShowBalloonTip(3000, Program.L("Cancelled", "تم الإلغاء"), Program.L("The computer will stay on.", "الكمبيوتر هيفضل شغال."), ToolTipIcon.Info); };
        menu.Items.Add(miCancel);
        menu.Items.Add(new ToolStripSeparator());
        miExit.Click += delegate { Exit(); };
        menu.Items.Add(miExit);
        tray.ContextMenuStrip = menu;
        ApplyLanguage();

        // Copied links → "Download File Info" (like IDM's clipboard monitoring)
        clip = new ClipboardWatcher(OnClipboard);
        tray.DoubleClick += delegate { ShowMain(); };

        // A second start of Mechano DM.exe only asks this one to show its window.
        var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\MechanoDM.Show");
        var t = new Thread(() => { while (true) { showEvent.WaitOne(); invoker.BeginInvoke((Action)ShowMain); } });
        t.IsBackground = true;
        t.Start();

        poll.Interval = 1000;
        poll.Tick += delegate { Poll(); };
        Task.Run(() => StartEngine()).ContinueWith(task => invoker.BeginInvoke((Action)(() => EngineReady(task.Result))));
    }

    // ------------------------------------------------------------------ engine
    bool StartEngine()
    {
        api.LoadConfig();
        if (api.Ping()) return true; // already running (e.g. started from the command line)
        string node = Path.Combine(Program.Dir, @"runtime\node.exe");
        string path = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) + ";" +
                      Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User);
        if (!File.Exists(node)) node = FindOnPath("node.exe", path);
        if (node == null)
        {
            invoker.BeginInvoke((Action)(() => MessageBox.Show("Node.js was not found.\n\nUse the portable copy of Mechano DM (it includes Node.js), or install Node.js from nodejs.org.", Program.Title, MessageBoxButtons.OK, MessageBoxIcon.Error)));
            return false;
        }
        var psi = new ProcessStartInfo(node, "\"" + Path.Combine(Program.Dir, @"bin\mdm.js") + "\" serve")
        {
            WorkingDirectory = Program.Dir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.EnvironmentVariables["Path"] = path; // finds yt-dlp / ffmpeg installed after Windows started
        string log = Path.Combine(Program.Dir, @"data\engine.log");
        try { Directory.CreateDirectory(Path.GetDirectoryName(log)); File.WriteAllText(log, ""); } catch { }
        engine = new Process { StartInfo = psi, EnableRaisingEvents = true };
        DataReceivedEventHandler write = delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) try { File.AppendAllText(log, e.Data + Environment.NewLine); } catch { } };
        engine.OutputDataReceived += write;
        engine.ErrorDataReceived += write;
        engine.Exited += delegate { invoker.BeginInvoke((Action)EngineExited); };
        engine.Start();
        engine.BeginOutputReadLine();
        engine.BeginErrorReadLine();
        KillWithMe(engine);
        for (int i = 0; i < 60; i++) { Thread.Sleep(250); if (api.Ping()) { api.LoadConfig(); return true; } }
        return api.Ping();
    }

    static string FindOnPath(string exe, string path)
    {
        foreach (string d in path.Split(';'))
        {
            try { string p = Path.Combine(d.Trim(), exe); if (d.Trim().Length > 0 && File.Exists(p)) return p; } catch { }
        }
        return null;
    }

    void EngineReady(bool ok)
    {
        Program.Log("engine ready: " + ok + " port " + api.Port + " token " + (api.Token.Length > 0 ? "loaded" : "MISSING"));
        if (!ok) { tray.Text = "Mechano DM - engine did not start"; return; }
        api.LoadConfig();
        tray.Text = Program.Title;
        poll.Start();
        if (!background) ShowMain();
    }

    void EngineExited()
    {
        if (exiting) return;
        if (++restarts > 5) { tray.ShowBalloonTip(8000, "Mechano DM stopped", "The download engine keeps closing. See data\\engine.log.", ToolTipIcon.Error); return; }
        Task.Run(() => StartEngine());
    }

    /** Job object: the engine is closed by Windows when Mechano DM.exe ends, even after a crash. */
    void KillWithMe(Process p)
    {
        try
        {
            if (killJob == IntPtr.Zero)
            {
                killJob = Native.CreateJobObject(IntPtr.Zero, null);
                var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int len = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr ptr = Marshal.AllocHGlobal(len);
                Marshal.StructureToPtr(info, ptr, false);
                Native.SetInformationJobObject(killJob, 9 /* ExtendedLimitInformation */, ptr, (uint)len);
                Marshal.FreeHGlobal(ptr);
            }
            Native.AssignProcessToJobObject(killJob, p.Handle);
        }
        catch { }
    }

    // ------------------------------------------------------------------ polling the engine
    void Poll()
    {
        if (pollBusy) return;
        pollBusy = true;
        int tick = ++ticks;
        Task.Run(() =>
        {
            object jobs = null, sched = null;
            try
            {
                jobs = api.Get("/api/jobs");
                if (tick % 2 == 0) { api.Post("/api/host", "{}"); sched = api.Get("/api/schedule"); }
                if (tick % 5 == 1)
                {
                    var c = api.Get("/api/config") as Dictionary<string, object>;
                    if (c != null && c.ContainsKey("showCompleteDialog")) showComplete = Convert.ToBoolean(c["showCompleteDialog"]);
                    if (c != null && c.ContainsKey("clipboardMonitor")) clipboardOn = Convert.ToBoolean(c["clipboardMonitor"]);
                    var up = api.Get("/api/app-update") as Dictionary<string, object>;
                    string launch = Api.Str(up, "launch");
                    if (!string.IsNullOrEmpty(launch) && !updateStarted) invoker.BeginInvoke((Action)(() => RunAppUpdate(launch)));
                    string lang = Api.Str(c, "language");
                    if (lang != null && lang != language) { language = lang; invoker.BeginInvoke((Action)ApplyLanguage); }
                }
            }
            catch (Exception ex)
            {
                // One missed check is harmless (it repeats every second); only log when it keeps failing.
                if (++pollFailures == 5) Program.Log("engine not answering: " + ex.Message);
                jobs = null;
            }
            if (jobs != null) pollFailures = 0;
            invoker.BeginInvoke((Action)(() =>
            {
                try { Handle(jobs as object[], sched as Dictionary<string, object>); }
                catch (Exception ex) { Program.Log("handle failed: " + ex); }
                finally { pollBusy = false; }
            }));
        });
    }

    void Handle(object[] jobs, Dictionary<string, object> sched)
    {
        if (jobs != null)
        {
            int active = 0;
            foreach (var o in jobs)
            {
                var j = o as Dictionary<string, object>;
                if (j == null) continue;
                string id = Api.Str(j, "id"), status = Api.Str(j, "status");
                string prev;
                bool known = lastStatus.TryGetValue(id, out prev);
                if (status == "confirm" && prev != "confirm" && !confirmQueue.Contains(id)) confirmQueue.Enqueue(id);
                if (!first && known && prev != "done" && status == "done" && showComplete) ShowComplete(j);
                if (!first && known && prev != "error" && status == "error")
                    tray.ShowBalloonTip(6000, Program.L("Download failed", "التحميل فشل"), (Api.Str(j, "filename") ?? Api.Str(j, "url")) + "\n" + Api.Str(j, "error"), ToolTipIcon.Error);
                if (status == "downloading") active++;
                lastStatus[id] = status;
            }
            first = false;
            // Approved or cancelled somewhere else (main window, another PC tab): close the floating window.
            if (confirm != null && !confirm.IsDisposed && !confirm.Keep)
            {
                string cs;
                if (!lastStatus.TryGetValue(confirm.JobId, out cs) || cs != "confirm") { confirm.Silent = true; confirm.Close(); }
                else if (!jobs.Any(o => Api.Str(o as Dictionary<string, object>, "id") == confirm.JobId)) { confirm.Silent = true; confirm.Close(); }
            }
            string tip = active > 0 ? "Mechano DM - " + active + Program.L(" downloading", " بيتحمّل") : Program.Title;
            if (tray.Text != tip) tray.Text = tip;
            if (miClipboard.Checked != clipboardOn) miClipboard.Checked = clipboardOn;
            NextConfirm();
        }
        if (sched != null)
        {
            var p = sched.ContainsKey("pendingAction") ? sched["pendingAction"] as Dictionary<string, object> : null;
            miCancel.Visible = p != null;
            if (p != null)
            {
                double at = Convert.ToDouble(p["at"]);
                miCancel.Text = "Cancel: " + Api.Str(p, "label") + " (scheduled downloads finished)";
                if (at != warnedAt)
                {
                    warnedAt = at;
                    double secs = Math.Max(0, Math.Round((at - (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds) / 1000));
                    tray.ShowBalloonTip(15000, Api.Str(p, "label") + " in " + secs + " seconds", "Scheduled downloads are finished. Right-click this icon (or open Mechano DM) to cancel.", ToolTipIcon.Warning);
                }
            }
        }
    }

    // ------------------------------------------------------------------ app update
    bool updateStarted;

    /** The engine downloaded and checked a signed Setup.exe: run it (it closes this app and starts the new one). */
    void RunAppUpdate(string setup)
    {
        if (updateStarted) return;
        string updates = Path.GetFullPath(Path.Combine(Program.Dir, @"data\update")) + "\\";
        string full = Path.GetFullPath(setup);
        if (!full.StartsWith(updates, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) { Program.Log("app update: unexpected installer path " + setup); return; }
        if (!File.Exists(Path.Combine(Program.Dir, "install-files.txt"))) return; // portable copy
        updateStarted = true;
        Program.Log("app update: running " + full);
        tray.ShowBalloonTip(5000, Program.L("Updating Mechano DM", "بيتم تحديث Mechano DM"), Program.L("The app restarts in a few seconds. Downloads continue after it.", "البرنامج هيقفل ويفتح تاني خلال ثواني، والتحميلات هتكمل بعدها."), ToolTipIcon.Info);
        string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Mechano Download Manager.lnk");
        string args = "/silent \"/dir=" + Program.Dir.TrimEnd('\\') + "\"" + (File.Exists(desktopLink) ? "" : " /nodesktop");
        try { Process.Start(new ProcessStartInfo(full, args) { UseShellExecute = false, WorkingDirectory = Path.GetTempPath() }); }
        catch (Exception ex) { updateStarted = false; Program.Log("app update failed to start: " + ex.Message); }
    }

    // ------------------------------------------------------------------ language + clipboard
    void ApplyLanguage()
    {
        Program.Arabic = language == "ar" || (language == "auto" && System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ar");
        miOpen.Text = Program.L("Open Mechano DM", "افتح Mechano DM");
        miFolder.Text = Program.L("Open downloads folder", "افتح فولدر التحميلات");
        miStartup.Text = Program.L("Start with Windows", "يشتغل مع ويندوز");
        miClipboard.Text = Program.L("Watch copied links", "راقب الروابط المنسوخة");
        miExit.Text = Program.L("Exit", "خروج");
        tray.ContextMenuStrip.RightToLeft = Program.Arabic ? RightToLeft.Yes : RightToLeft.No;
    }

    void OnClipboard()
    {
        if (!clipboardOn || !poll.Enabled) return;
        string text = null;
        try { if (Clipboard.ContainsText()) text = Clipboard.GetText(); } catch { return; } // another app holds the clipboard
        if (string.IsNullOrEmpty(text)) return;
        text = text.Trim();
        // only something that looks like one link; the engine decides if it is a download
        if (text.Length > 4000 || text.IndexOfAny(new[] { ' ', '\n', '\r', '\t' }) >= 0) return;
        if (!(text.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || text.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
              text.StartsWith("magnet:?", StringComparison.OrdinalIgnoreCase))) return;
        string body = "{\"text\":" + Api.Q(text) + "}";
        Task.Run(() => Try(() => api.Post("/api/clipboard", body)));
    }

    // ------------------------------------------------------------------ popups
    void NextConfirm()
    {
        if (confirm != null || confirmQueue.Count == 0) return;
        string id = confirmQueue.Dequeue();
        string st;
        if (!lastStatus.TryGetValue(id, out st) || st != "confirm") { NextConfirm(); return; }
        Program.Log("showing Download File Info window for " + id);
        ShowConfirm(id, !WebConfirmForm.Broken);
    }

    void ShowConfirm(string id, bool web)
    {
        PopupForm f = web ? (PopupForm)new WebConfirmForm(api, id) : new ConfirmForm(api, id, confirmQueue.Count);
        confirm = (IConfirmWindow)f;
        var wf = f as WebConfirmForm;
        if (wf != null)
        {
            // After Start the window stays as a progress window; the next new download gets its own window.
            wf.ProgressStarted += delegate
            {
                if (confirm == wf) confirm = null;
                progressWindows.Add(wf);
                invoker.BeginInvoke((Action)NextConfirm);
            };
            wf.HiddenToTray += delegate
            {
                UpdateHiddenMenu();
                if (!toldAboutHidden)
                {
                    toldAboutHidden = true;
                    tray.ShowBalloonTip(4000, Program.L("The download continues", "التحميل مكمل"),
                        Program.L("Right-click this icon → Show download windows to see it again.", "كليك يمين على الأيقونة دي ← اعرض نوافذ التحميل عشان تظهر تاني."), ToolTipIcon.Info);
                }
            };
        }
        f.FormClosed += delegate
        {
            bool failed = ((IConfirmWindow)f).Failed;
            if (wf != null && progressWindows.Remove(wf)) { UpdateHiddenMenu(); return; } // a progress window closed
            if (confirm == f) confirm = null;
            // WebView2 could not start: show the same download in the simple window
            if (failed) invoker.BeginInvoke((Action)(() => ShowConfirm(id, false)));
            else invoker.BeginInvoke((Action)NextConfirm);
        };
        f.Show();
        f.BringToTop();
    }

    /** Tray menu entry for progress windows hidden in the notification area. */
    void UpdateHiddenMenu()
    {
        int n = progressWindows.Count(w => !w.IsDisposed && !w.Visible);
        miHidden.Visible = n > 0;
        miHidden.Text = Program.L("Show download windows", "اعرض نوافذ التحميل") + " (" + n + ")";
    }

    void ShowHiddenWindows()
    {
        foreach (var w in progressWindows.ToArray()) if (!w.IsDisposed && !w.Visible) w.ShowAgain();
        UpdateHiddenMenu();
    }

    void ShowComplete(Dictionary<string, object> j)
    {
        Program.Log("showing Download complete window for " + Api.Str(j, "filename"));
        var f = new CompleteForm(j, completes.Count);
        completes.Add(f);
        f.FormClosed += delegate { completes.Remove(f); };
        f.Show();
    }

    public void ShowMain()
    {
        // A window whose page engine died would stay blank: replace it with a fresh one.
        if (main != null && !main.IsDisposed && main.IsHandleCreated && !main.WebAlive)
        {
            Program.Log("window was blank - rebuilding it");
            bool was = exiting; exiting = true; main.Close(); main.Dispose(); exiting = was; main = null;
        }
        if (main == null || main.IsDisposed)
        {
            main = new MainForm(api.Base + "/");
            main.FormClosing += delegate (object s, FormClosingEventArgs e)
            {
                if (exiting || e.CloseReason == CloseReason.WindowsShutDown) return;
                e.Cancel = true; // closing the window keeps downloads running in the tray, like IDM
                main.Hide();
                if (!toldAboutTray) { toldAboutTray = true; tray.ShowBalloonTip(4000, Program.L("Mechano DM is still running", "Mechano DM لسه شغال"), Program.L("Downloads continue here. Double-click this icon to open the window; right-click → Exit to quit.", "التحميلات مكملة هنا. دبل كليك على الأيقونة دي تفتح النافذة؛ كليك يمين ← خروج للقفل."), ToolTipIcon.Info); }
            };
        }
        if (!main.Visible) main.Show();
        if (main.WindowState == FormWindowState.Minimized) main.WindowState = FormWindowState.Normal;
        main.Activate();
        Native.SetForegroundWindow(main.Handle);
    }

    // ------------------------------------------------------------------ tray actions
    void OpenDownloads()
    {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @"Downloads\M.DM");
        Try(() =>
        {
            var c = api.Get("/api/config") as Dictionary<string, object>;
            string d = Api.Str(c, "downloadDir");
            if (!string.IsNullOrEmpty(d)) dir = d;
        });
        Directory.CreateDirectory(dir);
        Process.Start("explorer.exe", "\"" + dir + "\"");
    }

    static string StartupLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Mechano Download Manager.lnk"); } }

    void ToggleStartup()
    {
        if (File.Exists(StartupLink)) { File.Delete(StartupLink); miStartup.Checked = false; return; }
        Try(() =>
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { StartupLink });
            Type lt = lnk.GetType();
            string exe = Application.ExecutablePath;
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { exe });
            lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { "-Background" });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { exe + ",0" });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Program.Dir });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        });
        miStartup.Checked = File.Exists(StartupLink);
    }

    void Exit()
    {
        exiting = true;
        poll.Stop();
        tray.Visible = false;
        foreach (var f in completes.ToArray()) f.Close();
        if (confirm != null) { confirm.Silent = true; confirm.Close(); }
        foreach (var w in progressWindows.ToArray()) { w.Silent = true; w.Close(); }
        if (main != null) main.Close();
        try { if (engine != null && !engine.HasExited) engine.Kill(); } catch { }
        ExitThread();
    }

    static void Try(Action a) { try { a(); } catch { } }
}

// ====================================================================== main window (WebView2)
class MainForm : Form
{
    readonly string url;
    WebView2 web;

    public MainForm(string url)
    {
        this.url = url;
        Text = Program.Title;
        Icon = Program.AppIcon(32);
        StartPosition = FormStartPosition.CenterScreen;
        var area = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min(1180, area.Width - 60), Math.Min(820, area.Height - 60));
        MinimumSize = new Size(520, 420);
        BackColor = Color.FromArgb(233, 237, 242);
        Load += async delegate { await InitWeb(); };
        HandleCreated += delegate { Native.UseDarkTitleBar(Handle, Native.SystemUsesDarkMode()); };
    }

    /** False when the page engine is gone (the window would be blank). */
    public bool WebAlive
    {
        get { try { return web != null && web.CoreWebView2 != null && web.CoreWebView2.BrowserProcessId != 0 && Process.GetProcessById((int)web.CoreWebView2.BrowserProcessId) != null; } catch { return false; } }
    }

    async Task InitWeb()
    {
        try
        {
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"MechanoDM\webview");
            var env = await CoreWebView2Environment.CreateAsync(null, data);
            await web.EnsureCoreWebView2Async(env);
            var s = web.CoreWebView2.Settings;
            s.AreDevToolsEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = true;
            // Links that try to open a new window go to the normal browser
            web.CoreWebView2.NewWindowRequested += delegate (object o, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; try { Process.Start(e.Uri); } catch { } };
            web.CoreWebView2.DocumentTitleChanged += delegate { Text = Program.Title; };
            // If the WebView2 engine stops (crash, sleep, GPU reset), start it again instead of showing a blank window.
            web.CoreWebView2.ProcessFailed += delegate (object o, CoreWebView2ProcessFailedEventArgs e)
            {
                Program.Log("WebView2 stopped: " + e.ProcessFailedKind + " - restarting the window view");
                BeginInvoke((Action)(async () => { try { Controls.Remove(web); web.Dispose(); } catch { } web = null; await InitWeb(); }));
            };
            Program.Log("window view ready");
            web.Source = new Uri(url);
        }
        catch (Exception ex)
        {
            // No WebView2 runtime: open the app in the normal browser instead.
            MessageBox.Show("The built-in window could not start (" + ex.Message + ").\nMechano DM will open in your browser instead.", Program.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            try { Process.Start(url); } catch { }
            BeginInvoke((Action)Hide);
        }
    }
}

// ====================================================================== shared window style
class PopupForm : Form
{
    protected static readonly Color Ink = Color.FromArgb(20, 32, 48);
    protected static readonly Color Muted = Color.FromArgb(93, 107, 124);
    protected static readonly Color Line = Color.FromArgb(213, 220, 228);
    protected static readonly Color Accent = Color.FromArgb(36, 87, 214);
    protected static readonly Color Surface = Color.White;
    protected static readonly Color Footer = Color.FromArgb(243, 246, 249);

    public PopupForm()
    {
        Font = new Font("Segoe UI", 9.75f);
        // Layout is written in 96-DPI pixels; Windows scaling (e.g. 110%) enlarges it to match.
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Surface;
        ForeColor = Ink;
        Icon = Program.AppIcon(32);
        TopMost = true;
    }

    protected static Label MakeLabel(string text, float size = 9.75f, FontStyle style = FontStyle.Regular, Color? color = null)
    {
        return new Label
        {
            Text = text, AutoSize = false, AutoEllipsis = true, Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", size, style), ForeColor = color ?? Ink, TextAlign = ContentAlignment.MiddleLeft,
            Margin = new Padding(0, 2, 0, 2),
        };
    }

    protected static Button MakeButton(string text, bool primary = false)
    {
        var b = new Button
        {
            Text = text, AutoSize = true, MinimumSize = new Size(96, 32), Padding = new Padding(10, 2, 10, 2),
            FlatStyle = FlatStyle.Flat, Margin = new Padding(6, 0, 0, 0), Cursor = Cursors.Hand,
            BackColor = primary ? Accent : Color.White, ForeColor = primary ? Color.White : Ink,
            Font = new Font("Segoe UI", 9.75f, primary ? FontStyle.Bold : FontStyle.Regular),
        };
        b.FlatAppearance.BorderColor = primary ? Accent : Line;
        b.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(26, 69, 176) : Color.FromArgb(243, 246, 249);
        return b;
    }

    /** Show above the app you are using even when Windows blocks focus stealing. */
    public void BringToTop()
    {
        TopMost = true;
        Native.ShowWindow(Handle, 5);
        Native.SetForegroundWindow(Handle);
        Activate();
        Native.FlashWindow(Handle, true);
    }
}

// ====================================================================== "Download File Info" window (WebView2)
// Shows ui/dialog.html (the same page the main window uses), floating on top of everything.
// The page talks to this window with postMessage: theme (title bar colour), browse (folder
// dialog), done (close). If WebView2 cannot start, Host falls back to the WinForms ConfirmForm.
interface IConfirmWindow
{
    string JobId { get; }
    bool Silent { get; set; }
    bool Failed { get; }
    bool Keep { get; }
    void Close();
    bool IsDisposed { get; }
}

class WebConfirmForm : PopupForm, IConfirmWindow
{
    static CoreWebView2Environment env;
    public static bool Broken; // WebView2 failed once: use the WinForms window from now on
    readonly Api api;
    readonly string id;
    WebView2 web;
    bool done;
    public bool Silent { get; set; }
    public bool Failed { get; private set; }
    public string JobId { get { return id; } }
    /** Start was pressed: the page asked to stay open while the job leaves the "confirm" state. */
    public bool Keep { get; private set; }
    /** The window now shows the download's progress (Host stops treating it as the confirm window). */
    public event Action ProgressStarted;
    /** The user hid the window in the notification area. */
    public event Action HiddenToTray;

    public WebConfirmForm(Api api, string id)
    {
        this.api = api;
        this.id = id;
        Text = "Download File Info - Mechano DM";
        // The page draws its own title bar (hide to tray, minimize, close), like IDM's progress window.
        FormBorderStyle = FormBorderStyle.None;
        MaximizeBox = false;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(660, 470);
        bool dark = Native.SystemUsesDarkMode();
        BackColor = dark ? Color.FromArgb(24, 27, 31) : Color.White;
        HandleCreated += delegate { Native.UseDarkTitleBar(Handle, dark); Native.RoundCorners(Handle); };
        FormClosing += delegate (object s, FormClosingEventArgs e)
        {
            // Closing with X = Cancel (but not when the app exits or the page already finished)
            if (Silent || done || Failed) return;
            done = true;
            Task.Run(() => { try { api.Post("/api/jobs/" + id + "/remove", "{\"deleteFiles\":false}"); } catch { } });
        };
        Load += async delegate { await InitWeb(); };
        PerformAutoScale();
    }

    async Task InitWeb()
    {
        try
        {
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            if (env == null)
            {
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"MechanoDM\webview");
                env = await CoreWebView2Environment.CreateAsync(null, data);
            }
            await web.EnsureCoreWebView2Async(env);
            var s = web.CoreWebView2.Settings;
            s.AreDevToolsEnabled = false;
            s.IsStatusBarEnabled = false;
            s.AreDefaultContextMenusEnabled = false;
            s.IsZoomControlEnabled = false;
            web.CoreWebView2.NewWindowRequested += delegate (object o, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            web.CoreWebView2.WebMessageReceived += delegate (object o, CoreWebView2WebMessageReceivedEventArgs e) { OnMessage(e.WebMessageAsJson); };
            web.Source = new Uri(api.Base + "/dialog.html?id=" + Uri.EscapeDataString(id));
        }
        catch (Exception ex)
        {
            Program.Log("Download File Info window: WebView2 failed (" + ex.Message + ") - using the simple window");
            Broken = true;
            Failed = true;
            BeginInvoke((Action)Close);
        }
    }

    void OnMessage(string json)
    {
        Dictionary<string, object> m = null;
        try { m = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>; } catch { }
        string type = Api.Str(m, "type");
        if (type == "done") { done = true; Close(); }
        else if (type == "close") Close(); // before Start: FormClosing cancels the download
        else if (type == "starting") Keep = true;
        else if (type == "start-failed") Keep = false;
        else if (type == "progress") StartProgress(m);
        else if (type == "drag") { Native.ReleaseCapture(); Native.SendMessage(Handle, 0xA1 /* WM_NCLBUTTONDOWN */, (IntPtr)2 /* HTCAPTION */, IntPtr.Zero); }
        else if (type == "minimize") WindowState = FormWindowState.Minimized;
        else if (type == "hide") { Hide(); if (HiddenToTray != null) HiddenToTray(); }
        else if (type == "theme")
        {
            bool dark = m.ContainsKey("dark") && Convert.ToBoolean(m["dark"]);
            Native.UseDarkTitleBar(Handle, dark);
            BackColor = dark ? Color.FromArgb(24, 27, 31) : Color.White;
        }
        else if (type == "browse")
        {
            string start = Api.Str(m, "start");
            string chosen = null;
            using (var dlg = new FolderBrowserDialog { Description = Program.L("Choose where to save this download", "اختار مكان حفظ التحميل ده"), ShowNewFolderButton = true })
            {
                if (!string.IsNullOrEmpty(start) && Directory.Exists(start)) dlg.SelectedPath = start;
                if (dlg.ShowDialog(this) == DialogResult.OK) chosen = dlg.SelectedPath;
            }
            try { web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"folder\",\"path\":" + Api.Q(chosen) + "}"); } catch { }
        }
    }

    /** After Start: smaller window, no longer on top of everything, closing it no longer cancels. */
    void StartProgress(Dictionary<string, object> m)
    {
        done = true;
        Keep = true;
        TopMost = false;
        Text = Program.L("Downloading - Mechano DM", "جاري التحميل - Mechano DM");
        int w = 560, h = 300;
        try { w = Convert.ToInt32(m["w"]); h = Convert.ToInt32(m["h"]); } catch { }
        float scale;
        using (var g = CreateGraphics()) scale = g.DpiX / 96f;
        var center = new Point(Left + Width / 2, Top + Height / 2);
        ClientSize = new Size((int)(w * scale), (int)(h * scale));
        Location = new Point(center.X - Width / 2, center.Y - Height / 2);
        if (ProgressStarted != null) ProgressStarted();
    }

    /** Back from the notification area. */
    public void ShowAgain()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        Native.SetForegroundWindow(Handle);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ClassStyle |= 0x20000;                // CS_DROPSHADOW: a shadow without the Windows frame
            cp.Style |= 0x00020000 | 0x00080000;     // WS_MINIMIZEBOX | WS_SYSMENU: taskbar click minimizes / restores
            return cp;
        }
    }
}

// ====================================================================== "New download" window (simple fallback)
class ConfirmForm : PopupForm, IConfirmWindow
{
    public bool Failed { get { return false; } }
    public bool Keep { get { return false; } }
    readonly Api api;
    readonly string id;
    readonly Label name, meta, url, note, count;
    readonly ComboBox quality = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, Margin = new Padding(0, 2, 0, 2) };
    readonly TextBox folder = new TextBox { Dock = DockStyle.Fill, Margin = new Padding(0, 3, 0, 3) };
    readonly Button browse, start, later, cancel;
    readonly CheckBox dontAsk = new CheckBox { Text = "Don't ask again", AutoSize = true, Anchor = AnchorStyles.Left, ForeColor = Color.FromArgb(93, 107, 124) };
    readonly TableLayoutPanel grid;
    readonly Label qualityLabel;
    Dictionary<string, object> folders;
    string autoFolder;
    bool busy;
    public bool Silent { get; set; } // set when the app exits: closing then must not cancel the download
    public string JobId { get { return id; } }

    class Choice
    {
        public string Value, Text;
        public override string ToString() { return Text; }
    }

    public ConfirmForm(Api api, string id, int waitingAfter)
    {
        this.api = api;
        this.id = id;
        Text = "New download - Mechano DM";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(600, 330);

        // header
        var head = new Panel { Dock = DockStyle.Top, Height = 54, BackColor = Surface };
        var logo = new PictureBox { Image = Program.Logo(), SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(30, 30), Location = new Point(18, 12) };
        var title = new Label { Text = "New download", AutoSize = true, Font = new Font("Segoe UI Semibold", 12f), ForeColor = Ink, Location = new Point(56, 15) };
        count = new Label { Text = waitingAfter > 0 ? "+" + waitingAfter + " more waiting" : "", AutoSize = true, ForeColor = Muted, Anchor = AnchorStyles.Top | AnchorStyles.Right };
        count.Location = new Point(ClientSize.Width - 140, 19);
        head.Controls.AddRange(new Control[] { logo, title, count });
        var headLine = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Line };

        // body
        grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Padding = new Padding(18, 12, 18, 8), BackColor = Surface };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 76));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        name = MakeLabel("Getting details...", 10.5f, FontStyle.Bold);
        meta = MakeLabel("", 9f, FontStyle.Regular, Muted);
        url = MakeLabel("", 8.5f, FontStyle.Regular, Muted);
        note = MakeLabel("", 9f, FontStyle.Regular, Color.FromArgb(168, 106, 18));
        note.Visible = false;
        qualityLabel = MakeLabel("Quality", 9.5f, FontStyle.Regular, Muted);
        browse = MakeButton("Browse...");
        browse.Anchor = AnchorStyles.Left;
        browse.Margin = new Padding(6, 1, 0, 1);
        browse.MinimumSize = new Size(90, 28);
        AddRow(name, 3, 26);
        AddRow(meta, 3, 22);
        AddRow(url, 3, 22);
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 10));
        grid.Controls.Add(new Label(), 0, grid.RowStyles.Count - 1);
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        int r = grid.RowStyles.Count - 1;
        grid.Controls.Add(qualityLabel, 0, r);
        grid.Controls.Add(quality, 1, r);
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        r = grid.RowStyles.Count - 1;
        grid.Controls.Add(MakeLabel("Save to", 9.5f, FontStyle.Regular, Muted), 0, r);
        grid.Controls.Add(folder, 1, r);
        grid.Controls.Add(browse, 2, r);
        AddRow(note, 3, 40);
        qualityLabel.Visible = quality.Visible = false;

        // footer
        var foot = new Panel { Dock = DockStyle.Bottom, Height = 58, BackColor = Footer };
        var footLine = new Panel { Dock = DockStyle.Bottom, Height = 1, BackColor = Line };
        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Right, AutoSize = true, Padding = new Padding(0, 13, 16, 0), BackColor = Footer, WrapContents = false };
        start = MakeButton("Start download", true);
        later = MakeButton("Later");
        cancel = MakeButton("Cancel");
        buttons.Controls.AddRange(new Control[] { start, later, cancel });
        dontAsk.Location = new Point(18, 20);
        foot.Controls.Add(buttons);
        foot.Controls.Add(dontAsk);

        Controls.Add(grid);
        Controls.Add(headLine);
        Controls.Add(head);
        Controls.Add(footLine);
        Controls.Add(foot);
        AcceptButton = start;
        CancelButton = cancel;

        start.Click += delegate { Finish("start"); };
        later.Click += delegate { Finish("later"); };
        cancel.Click += delegate { Finish("cancel"); };
        browse.Click += delegate { Browse(); };
        quality.SelectedIndexChanged += delegate { SwitchFolderForQuality(); };
        FormClosing += delegate (object s, FormClosingEventArgs e)
        {
            // Closing with X = Cancel (but not when the whole app is exiting)
            if (Silent || DialogResult == DialogResult.OK) return;
            DialogResult = DialogResult.OK;
            Task.Run(() => { try { api.Post("/api/jobs/" + id + "/remove", "{\"deleteFiles\":false}"); } catch { } });
        };
        Shown += delegate { LoadDetails(); };
        PerformAutoScale();
    }

    void AddRow(Control c, int span, int height)
    {
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        grid.Controls.Add(c, 0, grid.RowStyles.Count - 1);
        grid.SetColumnSpan(c, span);
    }

    void LoadDetails()
    {
        SetBusy(true);
        Task.Run(() =>
        {
            Dictionary<string, object> d = null;
            string err = null;
            try { d = api.Post("/api/jobs/" + id + "/details", "{}", 90000) as Dictionary<string, object>; } catch (Exception ex) { err = ex.Message; }
            if (IsDisposed) return;
            BeginInvoke((Action)(() => Fill(d, err)));
        });
    }

    void Fill(Dictionary<string, object> d, string err)
    {
        SetBusy(false);
        if (d == null) { name.Text = "New download"; ShowNote(err); return; }
        name.Text = Api.Str(d, "name");
        new ToolTip().SetToolTip(name, name.Text);
        string kind = Api.Str(d, "kind");
        bool playlist = d.ContainsKey("playlist") && Convert.ToBoolean(d["playlist"]);
        string kindText = playlist ? "Playlist" : kind == "direct" ? "File" : kind == "hls" ? "Stream" : "Video site";
        double size = d.ContainsKey("size") && d["size"] != null ? Convert.ToDouble(d["size"]) : 0;
        meta.Text = kindText + (size > 0 ? "   ·   " + Program.FormatBytes(size) : "");
        folder.Text = Api.Str(d, "folder");
        autoFolder = folder.Text;
        folders = d.ContainsKey("folders") ? d["folders"] as Dictionary<string, object> : null;
        var qs = d.ContainsKey("qualities") ? d["qualities"] as object[] : null;
        if (qs != null && qs.Length > 0)
        {
            string selected = Api.Str(d, "selected") ?? "best";
            foreach (var o in qs)
            {
                var q = o as Dictionary<string, object>;
                double qs2 = q.ContainsKey("size") && q["size"] != null ? Convert.ToDouble(q["size"]) : 0;
                var c = new Choice { Value = Api.Str(q, "value"), Text = Api.Str(q, "label") + (qs2 > 0 ? "   (" + Program.FormatBytes(qs2) + ")" : "") };
                quality.Items.Add(c);
                if (c.Value == selected) quality.SelectedItem = c;
            }
            if (quality.SelectedIndex < 0) quality.SelectedIndex = 0;
            qualityLabel.Visible = quality.Visible = true;
        }
        ShowNote(Api.Str(d, "note"));
        start.Focus();
    }

    void SwitchFolderForQuality()
    {
        // Audio goes to Music, video to Video, unless you typed your own folder.
        if (folders == null || quality.SelectedItem == null) return;
        string video = Api.Str(folders, "video"), audio = Api.Str(folders, "audio");
        if (folder.Text != video && folder.Text != audio && folder.Text != autoFolder) return;
        folder.Text = ((Choice)quality.SelectedItem).Value == "audio" ? audio : video;
        autoFolder = folder.Text;
    }

    void ShowNote(string text)
    {
        note.Text = text ?? "";
        note.Visible = !string.IsNullOrEmpty(text);
    }

    void Browse()
    {
        using (var dlg = new FolderBrowserDialog { Description = "Choose where to save this download", ShowNewFolderButton = true })
        {
            if (Directory.Exists(folder.Text)) dlg.SelectedPath = folder.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK) folder.Text = dlg.SelectedPath;
        }
    }

    void SetBusy(bool b)
    {
        busy = b;
        start.Enabled = later.Enabled = browse.Enabled = !b;
        UseWaitCursor = b;
    }

    void Finish(string action)
    {
        if (busy) return;
        SetBusy(true);
        string dir = folder.Text.Trim();
        string q = quality.Visible && quality.SelectedItem != null ? ((Choice)quality.SelectedItem).Value : null;
        bool noAsk = dontAsk.Checked;
        Task.Run(() =>
        {
            string err = null;
            try
            {
                if (noAsk) api.Post("/api/config", "{\"confirmDownloads\":false}");
                if (action == "cancel") api.Post("/api/jobs/" + id + "/remove", "{\"deleteFiles\":false}");
                else api.Post("/api/jobs/" + id + "/confirm",
                    "{\"dir\":" + (dir.Length > 0 ? Api.Q(dir) : "null") + ",\"later\":" + (action == "later" ? "true" : "false") +
                    (q != null ? ",\"quality\":" + Api.Q(q) : "") + "}");
            }
            catch (Exception ex) { err = ex.Message; }
            BeginInvoke((Action)(() =>
            {
                if (err != null) { SetBusy(false); ShowNote(err); return; }
                DialogResult = DialogResult.OK;
                Close();
            }));
        });
    }
}

// ====================================================================== "Download complete" window
class CompleteForm : PopupForm
{
    readonly string file;
    readonly bool isFolder;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 1000 };
    int secondsLeft = 20;

    public CompleteForm(Dictionary<string, object> j, int stackIndex)
    {
        file = Api.Str(j, "file") ?? "";
        isFolder = Directory.Exists(file);
        string name = Api.Str(j, "filename") ?? Path.GetFileName(file);
        Text = Program.L("Download complete", "اكتمل التحميل");
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(430, 150);
        var area = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(area.Right - Width - 12, area.Bottom - (Height + 10) * (stackIndex + 1));

        var icon = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(40, 40), Location = new Point(16, 18) };
        try { icon.Image = isFolder ? Program.Logo() : Icon.ExtractAssociatedIcon(file).ToBitmap(); } catch { icon.Image = Program.Logo(); }
        var ok = new Label { Text = Program.L("✓ Download complete", "✓ اكتمل التحميل"), AutoSize = true, ForeColor = Color.FromArgb(30, 158, 85), Font = new Font("Segoe UI Semibold", 9.5f), Location = new Point(68, 14) };
        var nm = new Label { Text = name, AutoEllipsis = true, AutoSize = false, Size = new Size(345, 22), Font = new Font("Segoe UI", 10.5f, FontStyle.Bold), ForeColor = Ink, Location = new Point(68, 34) };
        double size = j.ContainsKey("size") && j["size"] != null ? Convert.ToDouble(j["size"]) : 0;
        var where = new Label
        {
            Text = (size > 0 ? Program.FormatBytes(size) + "  ·  " : "") + (isFolder ? file : Path.GetDirectoryName(file)),
            AutoEllipsis = true, AutoSize = false, Size = new Size(345, 20), ForeColor = Muted, Font = new Font("Segoe UI", 8.75f), Location = new Point(68, 58),
        };
        new ToolTip().SetToolTip(where, where.Text);
        var open = MakeButton(isFolder ? Program.L("Open folder", "افتح الفولدر") : Program.L("Open", "افتح"), true);
        var folderBtn = MakeButton(Program.L("Show in folder", "اعرض في الفولدر"));
        var close = MakeButton(Program.L("Close", "اقفل"));
        var row = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Location = new Point(10, 100), Size = new Size(408, 40), WrapContents = false };
        row.Controls.Add(close);
        if (!isFolder) row.Controls.Add(folderBtn);
        row.Controls.Add(open);
        Controls.AddRange(new Control[] { icon, ok, nm, where, row });

        open.Click += delegate { Launch(file); Close(); };
        folderBtn.Click += delegate { Process.Start("explorer.exe", "/select,\"" + file + "\""); Close(); };
        close.Click += delegate { Close(); };
        timer.Tick += delegate
        {
            if (Bounds.Contains(Cursor.Position)) return; // stays while the mouse is on it
            if (--secondsLeft <= 0) Close();
        };
        Shown += delegate { timer.Start(); };
        FormClosed += delegate { timer.Dispose(); };
        PerformAutoScale();
        var a2 = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(a2.Right - Width - 12, a2.Bottom - (Height + 10) * (stackIndex + 1));
    }

    static void Launch(string path)
    {
        try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
        catch (Exception ex) { MessageBox.Show("Could not open the file:\n" + ex.Message, Program.Title); }
    }

    protected override bool ShowWithoutActivation { get { return true; } } // don't steal focus from your work
}

// ====================================================================== clipboard monitor
// A message-only window that Windows tells about every clipboard change (no polling).
class ClipboardWatcher : NativeWindow
{
    const int WM_CLIPBOARDUPDATE = 0x031D;
    readonly Action changed;
    DateTime last = DateTime.MinValue;

    public ClipboardWatcher(Action changed)
    {
        this.changed = changed;
        CreateHandle(new CreateParams { Parent = new IntPtr(-3) /* HWND_MESSAGE */ });
        if (!Native.AddClipboardFormatListener(Handle)) Program.Log("clipboard monitor could not start");
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_CLIPBOARDUPDATE)
        {
            // some apps write the clipboard several times in a row
            if ((DateTime.Now - last).TotalMilliseconds > 300) { last = DateTime.Now; try { changed(); } catch { } }
        }
        base.WndProc(ref m);
    }
}

// ====================================================================== Win32
static class Native
{
    [DllImport("user32.dll", SetLastError = true)] public static extern bool AddClipboardFormatListener(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool SetDllDirectory(string path);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr h, bool invert);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
    [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);

    /** Windows 11 rounded corners for a window without the Windows frame (ignored on Windows 10). */
    public static void RoundCorners(IntPtr h)
    {
        int v = 2; // DWMWCP_ROUND
        try { DwmSetWindowAttribute(h, 33, ref v, 4); } catch { }
    }

    public static void UseDarkTitleBar(IntPtr h, bool dark)
    {
        int v = dark ? 1 : 0;
        try { DwmSetWindowAttribute(h, 20, ref v, 4); } catch { }
    }

    public static bool SystemUsesDarkMode()
    {
        try
        {
            object v = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
            return v is int && (int)v == 0;
        }
        catch { return false; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
}
