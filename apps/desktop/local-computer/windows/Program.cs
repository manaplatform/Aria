using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;
using System.Windows.Forms;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

internal static class Program
{
    private static Target? target;
    private static Surface? observed;
    private static string? elementId;
    private static int[]? observedElement;

    [STAThread]
    private static void Main()
    {
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        while (Console.ReadLine() is { Length: <= 20000 } line)
        {
            string? id = null;
            try
            {
                using var request = JsonDocument.Parse(line);
                var input = request.RootElement;
                id = input.GetProperty("id").GetString();
                if (!Guid.TryParse(id, out _)) continue;
                var result = input.GetProperty("operation").GetString() switch
                {
                    "pick" => Pick(),
                    "observe" => Observe(input.GetProperty("image").GetBoolean()),
                    "set_value" => SetValue(input),
                    _ => throw new InvalidOperationException(),
                };
                result["id"] = id;
                Console.WriteLine(JsonSerializer.Serialize(result));
            }
            catch (Exception)
            {
                if (id is not null) Console.WriteLine(JsonSerializer.Serialize(new { id, error = "The selected Notepad window is unavailable or no longer authorized." }));
            }
        }
    }

    private static Dictionary<string, object?> Pick()
    {
        if (!GraphicsCaptureSession.IsSupported()) throw new InvalidOperationException();
        var windows = new List<Target>();
        Native.EnumWindows((handle, _) =>
        {
            if (windows.Count < 24 && Identify(handle) is { } found) windows.Add(found);
            return true;
        }, IntPtr.Zero);
        using var dialog = new Form { Text = "Select a Notepad window for Aria", Width = 480, Height = 340, TopMost = true, StartPosition = FormStartPosition.CenterScreen };
        using var list = new ListBox { Dock = DockStyle.Fill, DisplayMember = nameof(Target.Title), AccessibleName = "Notepad windows" };
        using var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 44, FlowDirection = FlowDirection.RightToLeft };
        using var accept = new Button { Text = "Select", DialogResult = DialogResult.OK, Enabled = false };
        using var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
        foreach (var window in windows) list.Items.Add(window);
        list.SelectedIndexChanged += (_, _) => accept.Enabled = list.SelectedItem is Target;
        footer.Controls.Add(accept);
        footer.Controls.Add(cancel);
        dialog.Controls.Add(list);
        dialog.Controls.Add(footer);
        dialog.AcceptButton = accept;
        dialog.CancelButton = cancel;
        if (dialog.ShowDialog() != DialogResult.OK || list.SelectedItem is not Target selected) throw new InvalidOperationException();
        target = selected;
        if (Current().Editor is null) throw new InvalidOperationException();
        return new() { ["approved"] = true, ["accessibility"] = true };
    }

    private static Target? Identify(IntPtr handle)
    {
        if (!Native.IsWindowVisible(handle) || Native.IsIconic(handle)) return null;
        Native.GetWindowThreadProcessId(handle, out var pid);
        if (pid == 0) return null;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            var executable = process.MainModule?.FileName;
            if (executable is null || !Path.GetFileName(executable).Equals("Notepad.exe", StringComparison.OrdinalIgnoreCase)) return null;
            var system = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "Notepad.exe");
            if (!executable.Equals(system, StringComparison.OrdinalIgnoreCase))
            {
                var family = new StringBuilder(160);
                var length = family.Capacity;
                if (Native.GetPackageFamilyName(process.Handle, ref length, family) != 0 ||
                    family.ToString() != "Microsoft.WindowsNotepad_8wekyb3d8bbwe") return null;
            }
            var title = new StringBuilder(256);
            Native.GetWindowText(handle, title, title.Capacity);
            return new Target(handle, pid, process.StartTime.Ticks, title.Length == 0 ? "Notepad" : title.ToString());
        }
        catch (Exception) { return null; }
    }

    private static (Surface Surface, AutomationElement? Editor) Current()
    {
        if (target is null || Identify(target.Handle) is not { } current || current.Pid != target.Pid || current.Start != target.Start ||
            !Native.GetWindowRect(target.Handle, out var rectangle)) throw new InvalidOperationException();
        var scale = Native.GetDpiForWindow(target.Handle) / 96.0;
        if (scale <= 0) throw new InvalidOperationException();
        var surface = new Surface(rectangle.Left / scale, rectangle.Top / scale,
            (rectangle.Right - rectangle.Left) / scale, (rectangle.Bottom - rectangle.Top) / scale, scale);
        var root = AutomationElement.FromHandle(target.Handle);
        if (root.Current.ProcessId != target.Pid) throw new InvalidOperationException();
        var condition = new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
        var editors = root.FindAll(TreeScope.Descendants, condition).Cast<AutomationElement>().Where(element =>
            element.Current.ProcessId == target.Pid && !element.Current.IsPassword && element.Current.IsEnabled && !element.Current.IsOffscreen &&
            element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) && !((ValuePattern)pattern).Current.IsReadOnly).ToArray();
        return (surface, editors.Length == 1 ? editors[0] : null);
    }

    private static Dictionary<string, object?> Observe(bool image)
    {
        var (surface, editor) = Current();
        observed = surface;
        var identity = editor?.GetRuntimeId();
        if (identity is not null && (observedElement is null || !identity.SequenceEqual(observedElement))) elementId = Guid.NewGuid().ToString();
        observedElement = identity;
        var result = new Dictionary<string, object?> {
            ["surface"] = new { x = surface.X, y = surface.Y, width = surface.Width, height = surface.Height, scale = surface.Scale },
            ["title"] = "Notepad", ["editable"] = editor is not null,
        };
        if (identity is not null) result["elementId"] = elementId;
        if (image)
        {
            var capture = CaptureWindow.Read(target!.Handle).GetAwaiter().GetResult();
            if (Current().Surface != surface) throw new InvalidOperationException();
            result["image"] = capture.Encoded;
            result["imageWidth"] = capture.Width;
            result["imageHeight"] = capture.Height;
        }
        return result;
    }

    private static Dictionary<string, object?> SetValue(JsonElement input)
    {
        var (surface, editor) = Current();
        var text = input.GetProperty("text").GetString() ?? "";
        if (surface != observed || editor is null || observedElement is null || !editor.GetRuntimeId().SequenceEqual(observedElement) ||
            input.GetProperty("elementId").GetString() != elementId || text.Length > 4000 ||
            !editor.TryGetCurrentPattern(ValuePattern.Pattern, out var value)) throw new InvalidOperationException();
        ((ValuePattern)value).SetValue(text);
        return new() { ["submitted"] = true };
    }

    private sealed record Target(IntPtr Handle, uint Pid, long Start, string Title);
    private sealed record Surface(double X, double Y, double Width, double Height, double Scale);
}

internal static partial class Native
{
    internal delegate bool WindowCallback(IntPtr window, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] internal struct Rectangle { internal int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] internal static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr window, out Rectangle rectangle);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr awareness);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern int GetPackageFamilyName(IntPtr process, ref int length, StringBuilder family);
}

internal static class CaptureWindow
{
    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow(IntPtr window, in Guid id);
    }

    [DllImport("d3d11.dll")]
    private static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software,
        uint flags, IntPtr levels, uint levelCount, uint sdkVersion, out IntPtr device, IntPtr featureLevel, IntPtr context);
    [DllImport("d3d11.dll")]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr device, out IntPtr wrapper);

    private static IDirect3DDevice Device()
    {
        Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7,
            out var device, IntPtr.Zero, IntPtr.Zero));
        var dxgi = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
        try
        {
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, ref dxgi, out var graphics));
            try
            {
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(graphics, out var wrapper));
                try { return MarshalInterface<IDirect3DDevice>.FromAbi(wrapper); }
                finally { Marshal.Release(wrapper); }
            }
            finally { Marshal.Release(graphics); }
        }
        finally { Marshal.Release(device); }
    }

    internal static async Task<(string Encoded, uint Width, uint Height)> Read(IntPtr window)
    {
        var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
        var iid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
        var itemPointer = interop.CreateForWindow(window, iid);
        GraphicsCaptureItem item;
        try { item = MarshalInterface<GraphicsCaptureItem>.FromAbi(itemPointer); }
        finally { Marshal.Release(itemPointer); }
        using var device = Device();
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        var frames = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        pool.FrameArrived += (sender, _) =>
        {
            var frame = sender.TryGetNextFrame();
            if (frame is not null && !frames.TrySetResult(frame)) frame.Dispose();
        };
        session.StartCapture();
        using var captured = await frames.Task.WaitAsync(TimeSpan.FromSeconds(6)).ConfigureAwait(false);
        using var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(captured.Surface);
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetSoftwareBitmap(bitmap);
        var scale = Math.Min(1, 1024.0 / Math.Max(bitmap.PixelWidth, bitmap.PixelHeight));
        var width = (uint)Math.Max(1, Math.Floor(bitmap.PixelWidth * scale));
        var height = (uint)Math.Max(1, Math.Floor(bitmap.PixelHeight * scale));
        encoder.BitmapTransform.ScaledWidth = width;
        encoder.BitmapTransform.ScaledHeight = height;
        await encoder.FlushAsync();
        if (stream.Size is 0 or > 1048576) throw new InvalidOperationException();
        stream.Seek(0);
        using var reader = new DataReader(stream);
        var size = (uint)stream.Size;
        if (await reader.LoadAsync(size) != size) throw new InvalidOperationException();
        var bytes = new byte[size];
        reader.ReadBytes(bytes);
        return (Convert.ToBase64String(bytes), width, height);
    }
}
