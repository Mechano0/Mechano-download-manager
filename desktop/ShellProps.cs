// Shared by Mechano DM.exe and Setup.exe (compiled into both).
// Gives shortcuts and windows the app's taskbar ID (AppUserModelID), so the taskbar
// always finds the Mechano DM icon instead of showing a blank one.
using System;
using System.Runtime.InteropServices;

static class ShellProps
{
    public const string AppId = "Mechano.DownloadManager";

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, [Out] PropVariant value);
        void SetValue(ref PropertyKey key, [In] PropVariant value);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Sequential)]
    class PropVariant
    {
        public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2;
        public static PropVariant Text(string s) { return new PropVariant { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(s) }; }
        public void Free() { if (p != IntPtr.Zero) { Marshal.FreeCoTaskMem(p); p = IntPtr.Zero; } }
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile
    {
        void GetClassID(out Guid clsid);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string file, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
        void GetCurFile(out IntPtr file);
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }

    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    static readonly Guid AppUserModelFmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    static PropertyKey Key(uint pid) { return new PropertyKey { fmtid = AppUserModelFmt, pid = pid }; }
    const uint PidRelaunchCommand = 2, PidRelaunchIcon = 3, PidRelaunchName = 4, PidId = 5;

    static void Set(IPropertyStore store, uint pid, string value)
    {
        var k = Key(pid);
        var v = PropVariant.Text(value);
        try { store.SetValue(ref k, v); } finally { v.Free(); }
    }

    /** Writes the taskbar ID into an existing .lnk file. */
    public static void StampShortcut(string lnk)
    {
        object o = new ShellLink();
        try
        {
            ((IPersistFile)o).Load(lnk, 2 /* STGM_READWRITE */);
            var store = (IPropertyStore)o;
            Set(store, PidId, AppId);
            store.Commit();
            ((IPersistFile)o).Save(lnk, true);
        }
        finally { Marshal.ReleaseComObject(o); }
    }

    /** Tells the taskbar which app, icon and name a window belongs to (works even with an old shortcut). */
    public static void StampWindow(IntPtr hwnd, string exe, string name)
    {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        if (SHGetPropertyStoreForWindow(hwnd, ref iid, out store) != 0 || store == null) return;
        try
        {
            // The relaunch values must be set before the ID (Windows reads them when the ID arrives).
            Set(store, PidRelaunchCommand, "\"" + exe + "\"");
            Set(store, PidRelaunchIcon, exe + ",0");
            Set(store, PidRelaunchName, name);
            Set(store, PidId, AppId);
        }
        finally { Marshal.ReleaseComObject(store); }
    }
}
