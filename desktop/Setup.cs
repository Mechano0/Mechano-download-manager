// Mechano DM Setup: a one-file installer for Mechano Download Manager.
//
// The program files are stored inside this exe as a Windows cabinet (LZX compression, made by
// makecab) and are unpacked with Windows' own setupapi.dll, so nothing extra is needed.
// It installs for the current user only (no admin rights): %LOCALAPPDATA%\Programs\Mechano DM,
// adds Start-menu / desktop icons and an entry in Settings > Apps, then opens the program.
//
// build-setup.ps1 compiles this file twice:
//   with the payload    -> "Mechano DM Setup.exe"
//   without the payload -> "Uninstall.exe" (shipped inside the install folder)
//
// Command line (handy for testing):
//   Setup.exe /silent [/dir=<folder>] [/nolaunch] [/nodesktop]     install without the window
//   Uninstall.exe [/silent]                                         remove the program
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Mechano Download Manager Setup")]
[assembly: AssemblyProduct("Mechano Download Manager")]
[assembly: AssemblyCompany("Mechano")]

static class Setup
{
    public const string AppName = "Mechano Download Manager";
    public const string ExeName = "Mechano DM.exe";
    public const string FolderName = "Mechano DM";
    public const string LinkName = AppName + ".lnk";
    public const string Manifest = "install-files.txt";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\MechanoDM";

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        bool silent = HasArg(args, "/silent");
        bool hasPayload = Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.cab") != null;
        if (!hasPayload || HasArg(args, "/uninstall")) return Uninstall(silent);

        if (silent)
        {
            // Install without any window (used for testing and scripted installs).
            string dir = DefaultDir();
            foreach (string a in args) if (a.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase)) dir = NormalizeDir(a.Substring(5).Trim('"'));
            try
            {
                Install(dir, !HasArg(args, "/nodesktop"), delegate (int p, string s) { });
                if (!HasArg(args, "/nolaunch")) Launch(dir);
                return 0;
            }
            catch (Exception ex) { WriteError(ex.Message); return 1; }
        }

        Application.Run(new SetupForm());
        return 0;
    }

    static bool HasArg(string[] args, string name)
    {
        foreach (string a in args) if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    static void WriteError(string msg)
    {
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "MechanoDM-setup.log"), DateTime.Now.ToString("s") + "  " + msg + Environment.NewLine); } catch { }
    }

    // ---------- small helpers ----------

    // Reads "key=value" lines from the info.txt resource (version, total size).
    public static string Info(string key)
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("info.txt"))
        {
            if (s == null) return "";
            using (var r = new StreamReader(s))
            {
                string line;
                while ((line = r.ReadLine()) != null)
                    if (line.StartsWith(key + "=")) return line.Substring(key.Length + 1).Trim();
            }
        }
        return "";
    }

    public static Image Logo()
    {
        try
        {
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png");
            return s == null ? null : Image.FromStream(s);
        }
        catch { return null; }
    }

    // Where to install: the previous install folder if there is one, otherwise the per-user Programs folder.
    public static string DefaultDir()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                string old = k == null ? null : k.GetValue("InstallLocation") as string;
                if (!string.IsNullOrEmpty(old) && File.Exists(Path.Combine(old, ExeName))) return old;
            }
        }
        catch { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", FolderName);
    }

    // Always install into a folder of our own: picking "D:\Apps" means "D:\Apps\Mechano DM".
    // (This also keeps the uninstaller from ever touching a folder that holds other things.)
    public static string NormalizeDir(string input)
    {
        string p = Path.GetFullPath(input.Trim()).TrimEnd('\\');
        if (p.Length <= 3) p = p.TrimEnd('\\') + "\\";
        bool ours = string.Equals(Path.GetFileName(p), FolderName, StringComparison.OrdinalIgnoreCase) || File.Exists(Path.Combine(p, ExeName));
        return ours ? p : Path.Combine(p, FolderName);
    }

    static string LinkPath(Environment.SpecialFolder folder)
    {
        return Path.Combine(Environment.GetFolderPath(folder), LinkName);
    }

    // Closes Mechano DM (and the tools it runs) when it is running from this folder,
    // so its files can be replaced or removed.
    static void CloseRunningApp(string dir)
    {
        string full = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        foreach (string name in new[] { "Mechano DM", "node", "yt-dlp", "ffmpeg" })
        {
            foreach (Process p in Process.GetProcessesByName(name))
            {
                try
                {
                    if (p.MainModule.FileName.StartsWith(full, StringComparison.OrdinalIgnoreCase))
                    {
                        p.Kill();
                        p.WaitForExit(5000);
                    }
                }
                catch { }
                finally { p.Dispose(); }
            }
        }
    }

    static void MakeLink(string linkPath, string exe, string dir, string arguments)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { exe });
        lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { arguments });
        lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { exe + ",0" });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { dir });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { AppName });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        // Same taskbar ID as the running app, so the taskbar shows its icon (not a blank one).
        try { ShellProps.StampShortcut(linkPath); } catch { }
    }

    public static void Launch(string dir)
    {
        Process.Start(new ProcessStartInfo(Path.Combine(dir, ExeName)) { WorkingDirectory = dir, UseShellExecute = true });
    }

    // ---------- install ----------

    public static void Install(string dir, bool desktopLink, Action<int, string> progress)
    {
        // 1) Make sure we can write there (Program Files, for example, needs admin rights).
        try
        {
            Directory.CreateDirectory(dir);
            string probe = Path.Combine(dir, ".write-test");
            File.WriteAllText(probe, "");
            File.Delete(probe);
        }
        catch
        {
            throw new Exception("Setup can't write to this folder:\n" + dir + "\n\nChoose another folder (the suggested one works without admin rights).");
        }

        // 2) An open copy of the program would lock its files.
        progress(0, "Closing Mechano DM if it is open...");
        CloseRunningApp(dir);

        // 3) Unpack the program. Your settings and history (data\) are never touched.
        string cab = Path.Combine(Path.GetTempPath(), "MechanoDM-" + Guid.NewGuid().ToString("N") + ".cab");
        try
        {
            progress(0, "Preparing...");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.cab"))
            using (FileStream f = File.Create(cab)) s.CopyTo(f);
            long total;
            long.TryParse(Info("bytes"), out total);
            List<string> files = Extract(cab, dir, total, progress);
            File.WriteAllLines(Path.Combine(dir, Manifest), files.ToArray());
        }
        finally { try { File.Delete(cab); } catch { } }

        // 4) Icons in the Start menu (and on the desktop), and an entry in Settings > Apps.
        progress(100, "Creating icons...");
        string exe = Path.Combine(dir, ExeName);
        MakeLink(LinkPath(Environment.SpecialFolder.Programs), exe, dir, "");
        if (desktopLink) MakeLink(LinkPath(Environment.SpecialFolder.DesktopDirectory), exe, dir, "");
        Register(dir);
        try
        {
            // Refreshes Windows' icon cache so the new icons show right away.
            Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "ie4uinit.exe"), "-show") { CreateNoWindow = true, UseShellExecute = false });
        }
        catch { }
        progress(100, "Done");
    }

    static void Register(string dir)
    {
        long bytes;
        long.TryParse(Info("bytes"), out bytes);
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", AppName);
            k.SetValue("DisplayVersion", Info("version"));
            k.SetValue("Publisher", "Mechano");
            k.SetValue("DisplayIcon", Path.Combine(dir, ExeName) + ",0");
            k.SetValue("InstallLocation", dir);
            k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\"");
            k.SetValue("QuietUninstallString", "\"" + Path.Combine(dir, "Uninstall.exe") + "\" /silent");
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("EstimatedSize", (int)(bytes / 1024), RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    // --- cabinet unpacking with setupapi.dll ---
    delegate uint FileCallback(IntPtr context, uint notification, IntPtr param1, IntPtr param2);

    [DllImport("setupapi.dll", EntryPoint = "SetupIterateCabinetW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetupIterateCabinet(string cabinetFile, uint reserved, FileCallback callback, IntPtr context);

    const uint SPFILENOTIFY_FILEINCABINET = 0x11, SPFILENOTIFY_NEEDNEWCABINET = 0x12, SPFILENOTIFY_FILEEXTRACTED = 0x13;
    const uint FILEOP_ABORT = 0, FILEOP_DOCOPY = 1;

    static List<string> Extract(string cab, string dir, long total, Action<int, string> progress)
    {
        var files = new List<string>();
        string error = null, current = null;
        long done = 0;
        int last = -1;
        // FILE_IN_CABINET_INFO_W: NameInCabinet (pointer), FileSize, Win32Error, DosDate, DosTime, DosAttribs,
        // then FullTargetName[260]. setupapi.h packs it to 8 bytes on 64-bit and 1 byte on 32-bit.
        int sizeOffset = IntPtr.Size, targetOffset = IntPtr.Size + 14;

        FileCallback cb = delegate (IntPtr ctx, uint n, IntPtr p1, IntPtr p2)
        {
            try
            {
                if (n == SPFILENOTIFY_FILEINCABINET)
                {
                    string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p1));
                    long size = (uint)Marshal.ReadInt32(p1, sizeOffset);
                    string target = Path.Combine(dir, name);
                    if (target.Length >= 259) { error = "The install folder path is too long. Choose a shorter folder."; return FILEOP_ABORT; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
                    char[] chars = (target + "\0").ToCharArray();
                    Marshal.Copy(chars, 0, IntPtr.Add(p1, targetOffset), chars.Length);
                    files.Add(name);
                    current = name;
                    done += size;
                    return FILEOP_DOCOPY;
                }
                if (n == SPFILENOTIFY_FILEEXTRACTED)
                {
                    // FILEPATHS_W: Target, Source (pointers), Win32Error, Flags
                    int err = Marshal.ReadInt32(p1, 2 * IntPtr.Size);
                    if (err != 0)
                    {
                        error = "Could not write " + current + " (Windows error " + err + ").\nClose Mechano DM and try again.";
                        return (uint)err;
                    }
                    int pct = total > 0 ? (int)Math.Min(100, done * 100 / total) : 0;
                    if (pct != last) { last = pct; progress(pct, "Installing... " + pct + "%"); }
                    return 0;
                }
                if (n == SPFILENOTIFY_NEEDNEWCABINET) { error = "This setup file is damaged. Please get a fresh copy."; return 1; }
                return 0;
            }
            catch (Exception ex) { error = ex.Message; return FILEOP_ABORT; }
        };

        bool ok = SetupIterateCabinet(cab, 0, cb, IntPtr.Zero);
        int win32 = Marshal.GetLastWin32Error();
        GC.KeepAlive(cb);
        if (error != null) throw new Exception(error);
        if (!ok) throw new Exception("Unpacking failed (Windows error " + win32 + "). This setup file may be damaged.");
        return files;
    }

    // ---------- uninstall ----------

    static int Uninstall(bool silent)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string self = Application.ExecutablePath;
        if (!File.Exists(Path.Combine(dir, ExeName)))
        {
            if (!silent) MessageBox.Show("Mechano Download Manager is not installed in this folder.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
        if (!silent && MessageBox.Show(
                "Remove Mechano Download Manager from this PC?\n\nThe files you downloaded (Downloads\\M.DM) are kept.",
                AppName + " - Uninstall", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            return 1;

        CloseRunningApp(dir);

        foreach (Environment.SpecialFolder f in new[] { Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.Programs, Environment.SpecialFolder.Startup })
            TryDeleteFile(LinkPath(f));
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }

        // Delete only what Setup put here (listed in install-files.txt) plus the program's own data folder.
        var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "data" };
        string manifest = Path.Combine(dir, Manifest);
        if (File.Exists(manifest))
        {
            foreach (string rel in File.ReadAllLines(manifest))
            {
                if (rel.Length == 0 || rel.Contains("..") || Path.IsPathRooted(rel)) continue;
                int slash = rel.IndexOf('\\');
                if (slash > 0) folders.Add(rel.Substring(0, slash));
                else if (!string.Equals(rel, Path.GetFileName(self), StringComparison.OrdinalIgnoreCase)) TryDeleteFile(Path.Combine(dir, rel));
            }
        }
        else TryDeleteFile(Path.Combine(dir, ExeName));
        foreach (string f in folders)
        {
            try { string p = Path.Combine(dir, f); if (Directory.Exists(p)) Directory.Delete(p, true); } catch { }
        }
        TryDeleteFile(manifest);

        // This exe can't delete itself while it runs: a hidden command removes it (and the folder, if empty) after we exit.
        try
        {
            string cmd = "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\" & rmdir \"" + dir + "\"";
            Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false, WorkingDirectory = Path.GetTempPath() });
        }
        catch { }

        if (!silent) MessageBox.Show("Mechano Download Manager was removed.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }

    static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) { File.SetAttributes(path, FileAttributes.Normal); File.Delete(path); } } catch { }
    }

    // ---------- browser button help ----------

    static string AppPath(string exe)
    {
        foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            try
            {
                using (RegistryKey k = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                {
                    string p = k == null ? null : k.GetValue("") as string;
                    if (!string.IsNullOrEmpty(p) && File.Exists(p.Trim('"'))) return p.Trim('"');
                }
            }
            catch { }
        }
        return null;
    }

    // Opens the browser's extensions page and copies the extension folder path, then explains the 3 clicks.
    public static void OpenBrowserSetup(IWin32Window owner, string dir)
    {
        string ext = Path.Combine(dir, "extension");
        try { Clipboard.SetText(ext); } catch { }
        string browser = AppPath("chrome.exe"), page = "chrome://extensions";
        if (browser == null) { browser = AppPath("msedge.exe"); page = "edge://extensions"; }
        try { if (browser != null) Process.Start(browser, page); } catch { }
        MessageBox.Show(owner,
            "In the browser page that opened (" + page + "):\n" +
            "1. Turn on \"Developer mode\" (top corner).\n" +
            "2. Click \"Load unpacked\".\n" +
            "3. In the folder box press Ctrl+V (the folder is already copied), then click \"Select Folder\".\n\n" +
            "The Download button then shows on videos.\n\n" +
            "في صفحة المتصفح اللي اتفتحت:\n" +
            "1. شغّل Developer mode.\n" +
            "2. دوس Load unpacked.\n" +
            "3. في خانة الفولدر دوس Ctrl+V (المسار متنسخ جاهز)، وبعدين Select Folder.\n\n" +
            "بعدها زرار التحميل هيظهر فوق الفيديوهات.\n\n" +
            "Folder: " + ext,
            "Add the Download button to the browser", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}

// ---------- the setup window ----------

class SetupForm : Form
{
    static readonly Color Green = Color.FromArgb(22, 163, 74);
    static readonly Color Gray = Color.FromArgb(100, 116, 139);

    readonly TextBox dirBox = new TextBox();
    readonly CheckBox desktop = new CheckBox(), openNow = new CheckBox();
    readonly ProgressBar bar = new ProgressBar();
    readonly Label status = new Label();
    readonly Button install = new Button(), cancel = new Button(), browse = new Button(), finish = new Button(), browserBtn = new Button();
    readonly List<Control> page1 = new List<Control>(), page2 = new List<Control>();
    string dir;
    bool busy;

    public SetupForm()
    {
        Text = Setup.AppName + " Setup";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        Font = new Font("Segoe UI", 10F);
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(560, 340);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        // Header: logo, name, version
        var header = new Panel { Location = new Point(0, 0), Size = new Size(560, 96), BackColor = Color.FromArgb(240, 253, 244) };
        header.Controls.Add(new PictureBox { Location = new Point(24, 16), Size = new Size(64, 64), SizeMode = PictureBoxSizeMode.Zoom, Image = Setup.Logo() });
        header.Controls.Add(new Label { Location = new Point(102, 18), AutoSize = true, Text = Setup.AppName, Font = new Font("Segoe UI Semibold", 15F), ForeColor = Color.FromArgb(15, 23, 42) });
        header.Controls.Add(new Label { Location = new Point(104, 56), AutoSize = true, ForeColor = Gray, Font = new Font("Segoe UI", 9.5F),
            Text = "Version " + Setup.Info("version") + "   ·   YouTube, Facebook, Instagram, TikTok and more" });
        Controls.Add(header);

        // Page 1: where to install
        dir = Setup.DefaultDir();
        page1.Add(new Label { Location = new Point(24, 114), AutoSize = true, Text = "Install to:" });
        dirBox.SetBounds(24, 138, 420, 28);
        dirBox.Text = dir;
        page1.Add(dirBox);
        browse.SetBounds(452, 136, 84, 30);
        browse.Text = "Change...";
        browse.Click += delegate { PickFolder(); };
        page1.Add(browse);
        desktop.SetBounds(24, 178, 400, 26);
        desktop.Text = "Put an icon on the desktop";
        desktop.Checked = true;
        page1.Add(desktop);
        page1.Add(new Label { Location = new Point(24, 208), AutoSize = true, ForeColor = Gray, Font = new Font("Segoe UI", 9F),
            Text = "Everything is included (Node.js, yt-dlp, ffmpeg). No admin rights, no internet needed to install." });
        bar.SetBounds(24, 246, 512, 10);
        bar.Visible = false;
        page1.Add(bar);
        status.SetBounds(24, 262, 512, 22);
        status.ForeColor = Gray;
        page1.Add(status);
        cancel.SetBounds(300, 290, 104, 36);
        cancel.Text = "Cancel";
        cancel.Click += delegate { Close(); };
        page1.Add(cancel);
        StyleMain(install, "Install");
        install.Click += delegate { StartInstall(); };
        page1.Add(install);

        // Page 2: done
        page2.Add(new Label { Location = new Point(24, 114), AutoSize = true, Text = "✓  Installed", ForeColor = Green, Font = new Font("Segoe UI Semibold", 14F) });
        page2.Add(new Label { Location = new Point(26, 150), Size = new Size(510, 44), ForeColor = Gray,
            Text = "Mechano DM is ready. Open it any time from the Start menu or the desktop icon." });
        openNow.SetBounds(26, 196, 400, 26);
        openNow.Text = "Open Mechano DM now";
        openNow.Checked = true;
        page2.Add(openNow);
        browserBtn.SetBounds(26, 232, 330, 32);
        browserBtn.Text = "Add the Download button to Chrome / Edge...";
        browserBtn.Click += delegate { Setup.OpenBrowserSetup(this, dir); };
        page2.Add(browserBtn);
        StyleMain(finish, "Finish");
        finish.Click += delegate { if (openNow.Checked) { try { Setup.Launch(dir); } catch { } } Close(); };
        page2.Add(finish);

        foreach (Control c in page1) Controls.Add(c);
        foreach (Control c in page2) { c.Visible = false; Controls.Add(c); }
        AcceptButton = install;
        CancelButton = cancel;

        FormClosing += delegate (object s, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
    }

    static void StyleMain(Button b, string text)
    {
        b.SetBounds(416, 290, 120, 36);
        b.Text = text;
        b.FlatStyle = FlatStyle.Flat;
        b.FlatAppearance.BorderSize = 0;
        b.BackColor = Green;
        b.ForeColor = Color.White;
        b.Font = new Font("Segoe UI Semibold", 10.5F);
        b.Cursor = Cursors.Hand;
    }

    void PickFolder()
    {
        using (var d = new FolderBrowserDialog { Description = "Choose where to install Mechano DM", ShowNewFolderButton = true })
        {
            if (d.ShowDialog(this) == DialogResult.OK) dirBox.Text = Setup.NormalizeDir(d.SelectedPath);
        }
    }

    void StartInstall()
    {
        try { dir = Setup.NormalizeDir(dirBox.Text); }
        catch { MessageBox.Show(this, "That folder path is not valid.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        dirBox.Text = dir;
        busy = true;
        install.Enabled = cancel.Enabled = browse.Enabled = dirBox.Enabled = desktop.Enabled = false;
        bar.Visible = true;
        bool wantDesktop = desktop.Checked;

        var t = new Thread(delegate ()
        {
            string error = null;
            try
            {
                Setup.Install(dir, wantDesktop, delegate (int pct, string msg)
                {
                    BeginInvoke((MethodInvoker)delegate { bar.Value = Math.Max(0, Math.Min(100, pct)); status.Text = msg; });
                });
            }
            catch (Exception ex) { error = ex.Message; }
            BeginInvoke((MethodInvoker)delegate { Finished(error); });
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA); // WScript.Shell (icons) is a COM object
        t.Start();
    }

    void Finished(string error)
    {
        busy = false;
        if (error != null)
        {
            bar.Visible = false;
            status.Text = "";
            install.Enabled = cancel.Enabled = browse.Enabled = dirBox.Enabled = desktop.Enabled = true;
            MessageBox.Show(this, error, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        foreach (Control c in page1) c.Visible = false;
        foreach (Control c in page2) c.Visible = true;
        AcceptButton = finish;
        CancelButton = finish;
        finish.Focus();
    }
}
