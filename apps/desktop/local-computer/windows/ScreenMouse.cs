using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class ScreenMouse
{
    private const uint Move = 0x0001;
    private const uint LeftDown = 0x0002, LeftUp = 0x0004;
    private const uint RightDown = 0x0008, RightUp = 0x0010;
    private const uint MiddleDown = 0x0020, MiddleUp = 0x0040;
    private const uint Wheel = 0x0800, HorizontalWheel = 0x1000;
    private const uint AbsoluteMove = Move | 0x2000 | 0x4000 | 0x8000;
    private static readonly int[] HeldInput = [1, 2, 4, 0x10, 0x11, 0x12, 0x5B, 0x5C];

    internal static Dictionary<string, object?> Probe(JsonElement input)
    {
        var (key, _) = Resolve(input);
        return new() { ["approved"] = true, ["accessibility"] = true, ["displayKey"] = key };
    }

    internal static Dictionary<string, object?> Act(JsonElement input)
    {
        var (key, bounds) = Resolve(input);
        if (!StringComparer.Ordinal.Equals(key, input.GetProperty("displayKey").GetString()))
            throw new ScreenMouseError("The selected display changed. Open a new local desktop session.");
        if (HeldInput.Any(code => (GetAsyncKeyState(code) & 0x8000) != 0))
            throw new ScreenMouseError("Release any mouse buttons or modifier keys and retry.");

        var virtualBounds = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77),
            GetSystemMetrics(78), GetSystemMetrics(79));
        if (!virtualBounds.Contains(bounds) || virtualBounds.Width > 65536 || virtualBounds.Height > 65536)
            throw new ScreenMouseError("Windows could not verify the current desktop geometry.");

        string? action = input.GetProperty("action").GetString();
        var points = action == "drag"
            ? input.GetProperty("path").EnumerateArray().Select(point => ScreenPoint(point, bounds)).ToArray()
            : [ScreenPoint(input, bounds)];
        if (points.Length is < 1 or > 32 || (action == "drag" && points.Length < 2))
            throw new ScreenMouseError("The mouse action contains an invalid drag path.");

        Input At(Point point) => new(AbsoluteMove,
            AbsoluteCoordinate(point.X - virtualBounds.X, virtualBounds.Width),
            AbsoluteCoordinate(point.Y - virtualBounds.Y, virtualBounds.Height));

        var events = new List<Input> { At(points[0]) };
        switch (action)
        {
            case "move":
                break;
            case "click":
                var (down, up) = input.GetProperty("button").GetString() switch
                {
                    "left" => (LeftDown, LeftUp),
                    "right" => (RightDown, RightUp),
                    "middle" => (MiddleDown, MiddleUp),
                    _ => throw new ScreenMouseError("The mouse button is unsupported."),
                };
                events.AddRange([new(down), new(up)]);
                break;
            case "double_click":
                events.AddRange([new(LeftDown), new(LeftUp), new(LeftDown), new(LeftUp)]);
                break;
            case "drag":
                events.Add(new(LeftDown));
                events.AddRange(points.Skip(1).Select(At));
                events.Add(new(LeftUp));
                break;
            case "scroll":
                AddWheel(events, HorizontalWheel, input.GetProperty("scrollX").GetInt32());
                AddWheel(events, Wheel, -input.GetProperty("scrollY").GetInt32());
                break;
            default:
                throw new ScreenMouseError("The local mouse action is unsupported.");
        }

        // SendInput orders the complete gesture, including button release, as one call.
        var count = SendInput((uint)events.Count, events.ToArray(), Marshal.SizeOf<Input>());
        if (count != events.Count)
        {
            ReleasePartialGesture(events, count);
            return new() { ["submitted"] = false };
        }
        var verified = false;
        if (action == "move")
        {
            for (var attempt = 0; attempt < 4 && !verified; attempt++)
            {
                Thread.Sleep(20);
                verified = GetCursorPos(out var position)
                    && Math.Abs(position.X - points[0].X) <= 2
                    && Math.Abs(position.Y - points[0].Y) <= 2;
            }
        }
        return new() { ["submitted"] = true, ["verified"] = verified };
    }

    private static void AddWheel(List<Input> events, uint flag, int delta)
    {
        if (delta is < -1500 or > 1500)
            throw new ScreenMouseError("The scroll distance is outside the supported range.");
        if (delta == 0) return;
        var ticks = Math.Clamp((int)Math.Round(Math.Abs(delta) / 100d), 1, 12);
        events.Add(new Input(flag, data: unchecked((uint)(Math.Sign(delta) * ticks * 120))));
    }

    private static void ReleasePartialGesture(List<Input> events, uint count)
    {
        uint release = 0;
        foreach (var sent in events.Take((int)count))
            release = sent.Mouse.Flags switch
            {
                LeftDown => LeftUp,
                RightDown => RightUp,
                MiddleDown => MiddleUp,
                LeftUp or RightUp or MiddleUp => 0,
                _ => release,
            };
        if (release != 0) SendInput(1, [new Input(release)], Marshal.SizeOf<Input>());
    }

    private static int AbsoluteCoordinate(int offset, int span) =>
        Math.Min(65535, (int)Math.Ceiling(offset * 65536d / span));

    private static Point ScreenPoint(JsonElement json, Rectangle bounds)
    {
        var x = json.GetProperty("x").GetDouble();
        var y = json.GetProperty("y").GetDouble();
        if (!(x >= 0 && x < 1 && y >= 0 && y < 1))
            throw new ScreenMouseError("The mouse position is outside the approved display.");
        return new Point(bounds.Left + (int)(x * bounds.Width), bounds.Top + (int)(y * bounds.Height));
    }

    private static (string Key, Rectangle Bounds) Resolve(JsonElement input)
    {
        if (!HasInteractiveDesktop())
            throw new ScreenMouseError("Unlock the Windows desktop before using the approved display.");
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)))
            throw new ScreenMouseError("Windows could not verify per-monitor coordinate scaling.");
        var bounds = input.GetProperty("bounds");
        var expected = new Rectangle(bounds.GetProperty("x").GetInt32(), bounds.GetProperty("y").GetInt32(),
            bounds.GetProperty("width").GetInt32(), bounds.GetProperty("height").GetInt32());
        var names = new List<string>();
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (handle, _, _, _) =>
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (GetMonitorInfo(handle, ref info) && info.Bounds.ToRectangle() == expected)
                names.Add(info.Name);
            return true;
        }, IntPtr.Zero) || names.Count != 1 || expected.Width <= 0 || expected.Height <= 0)
            throw new ScreenMouseError("Windows could not match the selected display.");

        string key = GetMonitorPath(names[0]);
        return (key.ToUpperInvariant(), expected);
    }

    private static string GetMonitorPath(string name)
    {
        // Join the active display path to the monitor's GDI source and reject cloned sources.
        const uint activePaths = 2;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (GetDisplayConfigBufferSizes(activePaths, out var pathCount, out var modeCount) != 0 ||
                pathCount is 0 or > 128 || modeCount is 0 or > 512) break;
            var paths = new DisplayPath[pathCount];
            var modes = Marshal.AllocHGlobal(checked((int)modeCount * 64)); // sizeof(DISPLAYCONFIG_MODE_INFO)
            try
            {
                var result = QueryDisplayConfig(activePaths, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
                if (result == 122) continue; // A display changed while enumerating.
                if (result != 0) break;
                var targets = new List<PathTarget>();
                foreach (var path in paths.Take((int)pathCount))
                {
                    var source = new SourceName
                    {
                        Header = new DeviceHeader(1, Marshal.SizeOf<SourceName>(), path.Source.Adapter, path.Source.Id),
                    };
                    if (GetSourceName(ref source) == 0 &&
                        StringComparer.OrdinalIgnoreCase.Equals(name, source.Name))
                        targets.Add(path.Target);
                }
                if (targets.Count != 1 || targets[0].Available == 0) break;
                var target = new TargetName
                {
                    Header = new DeviceHeader(2, Marshal.SizeOf<TargetName>(), targets[0].Adapter, targets[0].Id),
                };
                if (GetTargetName(ref target) == 0 && !string.IsNullOrWhiteSpace(target.Path)) return target.Path;
                break;
            }
            finally
            {
                Marshal.FreeHGlobal(modes);
            }
        }
        throw new ScreenMouseError("The display is disconnected, mirrored, or has no unique Windows monitor identity.");
    }

    private static bool HasInteractiveDesktop()
    {
        var handle = OpenInputDesktop(0, false, 0x0001);
        if (handle == IntPtr.Zero) return false;
        try
        {
            var name = new StringBuilder(128);
            return GetUserObjectInformation(handle, 2, name, name.Capacity * sizeof(char), out _) &&
                StringComparer.OrdinalIgnoreCase.Equals(name.ToString(), "Default");
        }
        finally
        {
            CloseDesktop(handle);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        internal int Left, Top, Right, Bottom;
        internal readonly Rectangle ToRectangle() => Rectangle.FromLTRB(Left, Top, Right, Bottom);
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        internal int Size;
        internal Rect Bounds, Work;
        internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string Name;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { internal uint Low; internal int High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Ratio { internal uint Numerator, Denominator; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PathSource { internal Luid Adapter; internal uint Id, Mode, Flags; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PathTarget
    {
        internal Luid Adapter;
        internal uint Id, Mode, Technology, Rotation, Scaling;
        internal Ratio Rate;
        internal uint ScanLineOrdering;
        internal int Available;
        internal uint Flags;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayPath { internal PathSource Source; internal PathTarget Target; internal uint Flags; }
    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceHeader(uint type, int size, Luid adapter, uint id)
    {
        internal uint Type = type;
        internal int Size = size;
        internal Luid Adapter = adapter;
        internal uint Id = id;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SourceName
    {
        internal DeviceHeader Header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string Name;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TargetName
    {
        internal DeviceHeader Header;
        internal uint Flags, Technology;
        internal ushort Vendor, Product;
        internal uint Connector;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] internal string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] internal string Path;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput(uint flags, int x, int y, uint data)
    {
        internal int X = x, Y = y;
        internal uint Data = data, Flags = flags, Time = 0;
        internal UIntPtr ExtraInfo = UIntPtr.Zero;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input(uint flags, int x = 0, int y = 0, uint data = 0)
    {
        internal uint Type = 0;
        internal MouseInput Mouse = new(flags, x, y, data);
    }

    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr rect, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")] private static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [Out] DisplayPath[] paths, ref uint modeCount, IntPtr modes, IntPtr topology);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")] private static extern int GetSourceName(ref SourceName request);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")] private static extern int GetTargetName(ref TargetName request);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int metric);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int length, out uint required);
}

internal sealed class ScreenMouseError(string message) : Exception(message);
