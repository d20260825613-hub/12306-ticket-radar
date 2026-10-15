// 12306 余票雷达 —— Windows 启动器
//
// 职责：定位 Node.js、防止重复启动、拉起本地服务、打开浏览器、**保证能干净退出**。
// 不做任何网络请求，也不参与查询逻辑（那些都在 src/ 里）。
//
// 关于进程生命周期（重要）：
//   Windows 不会因为父进程结束而结束子进程。若只用 Process.Start 拉起 Node，
//   用户点窗口的 × 时启动器死了、Node 服务却活着并占住端口 ——
//   下次启动就会看到"服务已在运行"，且进程永远清不掉。
//   解法是用 Job Object + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：
//   把子进程放进作业对象，作业句柄一关（含进程被杀/窗口被关），
//   Windows 内核会一并结束作业内所有进程。
//
// 编译：见 tools/build_exe.ps1（用 .NET Framework 自带的 csc.exe）

using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Launcher
{
    private const string Title = "12306 余票雷达";
    private const int DefaultPort = 12308;

    /** 作业对象句柄。必须保持存活，关闭它才会触发子进程连带退出。 */
    private static IntPtr jobHandle = IntPtr.Zero;
    private static Process child = null;
    private static volatile bool shuttingDown = false;

    private static int Main(string[] args)
    {
        // 控制台设置必须在"确实有控制台"时才做。
        // 输出被重定向（或无控制台句柄）时 Console.OutputEncoding 会抛
        // IOException("句柄无效")，曾导致启动器直接崩溃。
        InitConsole();

        string exePath = System.Reflection.Assembly.GetEntryAssembly().Location;
        string root = Path.GetDirectoryName(exePath);

        Banner();

        // ── 0. 先建立作业对象与退出钩子，之后拉起的子进程都纳入其中 ──
        try
        {
            jobHandle = CreateKillOnCloseJob();
        }
        catch (Exception ex)
        {
            Console.ForegroundColor = ConsoleColor.DarkYellow;
            Console.WriteLine("  ! 无法建立作业对象，退出时可能残留后台进程: " + ex.Message);
            Console.ResetColor();
        }

        Console.CancelKeyPress += OnCancelKeyPress;
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;

        // ── 1. 定位 Node.js（后面读配置、拉起服务都要用）──
        string node = FindNode(root);
        if (node == null)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("  [x] 没有找到 Node.js");
            Console.ResetColor();
            Console.WriteLine();
            Console.WriteLine("  本程序需要 Node.js 18 或更高版本。任选一种方式：");
            Console.WriteLine("    1) 到 https://nodejs.org 安装 LTS 版本");
            Console.WriteLine("    2) 把 node.exe 放到 runtime\\ 目录下");
            Console.WriteLine();
            ReleaseJob();
            Pause();
            return 1;
        }
        Console.WriteLine("  Node.js : " + node);

        // ── 2. 确定端口：命令行参数 > 环境变量 PORT > 配置文件 > 默认 ──
        int port = DefaultPort;
        string portSource = "默认值";
        bool portFixed = false;
        if (args.Length > 0)
        {
            int parsed;
            if (int.TryParse(args[0], out parsed) && parsed > 0 && parsed < 65536)
            {
                port = parsed;
                portSource = "命令行参数";
                portFixed = true;
            }
        }
        if (!portFixed)
        {
            string envPort = Environment.GetEnvironmentVariable("PORT");
            int parsed;
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out parsed) && parsed > 0 && parsed < 65536)
            {
                port = parsed;
                portSource = "环境变量 PORT";
                portFixed = true;
            }
        }
        if (!portFixed)
        {
            int cfgPort = ReadConfiguredPort(root, node);
            if (cfgPort > 0)
            {
                port = cfgPort;
                portSource = "配置文件";
            }
        }
        Console.WriteLine("  端口    : " + port + "（" + portSource + "）");
        Console.WriteLine();

        // ── 3. 已运行则直接打开面板 ──
        if (IsOurService(port))
        {
            Console.WriteLine("  服务已在运行，直接打开面板。");
            OpenBrowser("http://127.0.0.1:" + port + "/");
            Sleep(1500);
            ReleaseJob();
            return 0;
        }

        if (IsListening(port))
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("  [x] 端口 " + port + " 已被其它程序占用（响应不是本程序的接口）。");
            Console.ResetColor();
            Console.WriteLine();
            Console.WriteLine("  换一个端口启动，例如：");
            Console.WriteLine("      \"" + Path.GetFileName(exePath) + "\" 12309");
            Console.WriteLine();
            ReleaseJob();
            Pause();
            return 1;
        }

        // ── 4. 站点表自检（首次运行需要）──
        string stationFile = Path.Combine(root, Path.Combine("data", "station_name.js"));
        if (!File.Exists(stationFile))
        {
            Console.WriteLine("  首次运行：正在下载站点表…");
            if (RunBlocking(node, Quote(Path.Combine(root, Path.Combine("tools", "fetch_stations.js")))) != 0)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("  [x] 站点表下载失败，请检查网络后重试。");
                Console.ResetColor();
                ReleaseJob();
                Pause();
                return 1;
            }
        }

        // ── 5. 拉起服务 ──
        Console.WriteLine();
        Console.WriteLine("  正在启动本地服务…");
        Console.WriteLine("  ────────────────────────────────────────────");
        Console.WriteLine("  关闭本窗口即可退出程序。");
        Console.WriteLine();

        var psi = new ProcessStartInfo(node)
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true,
        };
        psi.Arguments = Quote(Path.Combine(root, Path.Combine("src", "server.js")));
        // 由本启动器负责开浏览器（它在端口就绪后开，更可靠）
        psi.EnvironmentVariables["NO_OPEN"] = "1";
        // 关键：必须把端口传给子进程。
        // 否则 server.js 会回退到默认 12308，命令行指定的端口形同虚设。
        psi.EnvironmentVariables["PORT"] = port.ToString();

        try
        {
            child = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("  [x] 启动失败: " + ex.Message);
            Console.ResetColor();
            ReleaseJob();
            Pause();
            return 1;
        }

        if (child == null)
        {
            Console.WriteLine("  [x] 启动失败：无法创建服务进程。");
            ReleaseJob();
            Pause();
            return 1;
        }

        // 纳入作业对象：本进程一结束，Node 也随之结束
        AssignToJob(child);

        child.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
        {
            if (e.Data != null) Console.WriteLine("  " + e.Data);
        };
        child.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
        {
            if (e.Data != null)
            {
                Console.ForegroundColor = ConsoleColor.DarkYellow;
                Console.WriteLine("  ! " + e.Data);
                Console.ResetColor();
            }
        };
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();

        if (WaitForPort(port, 15000))
        {
            OpenBrowser("http://127.0.0.1:" + port + "/");
        }
        else
        {
            Console.ForegroundColor = ConsoleColor.DarkYellow;
            Console.WriteLine("  ! 服务在 15 秒内没有就绪，请手动访问 http://127.0.0.1:" + port + "/");
            Console.ResetColor();
        }

        // ── 5. 等待子进程；它退出即收工 ──
        // 说明：点窗口的 × 时，Windows 先结束本进程，作业对象随即结束子进程。
        child.WaitForExit();

        if (!shuttingDown)
        {
            Console.WriteLine();
            Console.WriteLine("  服务已退出。");
        }

        ReleaseJob();
        Environment.Exit(child.ExitCode);
        return child.ExitCode;
    }

    /* ══════════════ 控制台初始化 ══════════════ */

    /**
     * 安全地初始化控制台。
     * 每一项都可能失败（无控制台、句柄被重定向），失败不能影响启动。
     */
    private static void InitConsole()
    {
        try
        {
            if (!HasConsole()) return;
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            try { Console.Title = Title; } catch { }
        }
        catch
        {
            // 控制台不可用：后续 Console.Write 会静默丢弃，不影响功能
        }
    }

    /** 当前进程是否连着控制台。 */
    private static bool HasConsole()
    {
        try
        {
            return GetConsoleWindow() != IntPtr.Zero || GetStdHandle(-11) != IntPtr.Zero;
        }
        catch
        {
            return false;
        }
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    /* ══════════════ 退出处理 ══════════════ */

    private static void OnCancelKeyPress(object sender, ConsoleCancelEventArgs e)
    {
        // 拦下 Ctrl+C，先自己把子进程收干净，避免留下占端口的孤儿进程
        e.Cancel = true;
        Shutdown("收到 Ctrl+C");
    }

    private static void OnProcessExit(object sender, EventArgs e)
    {
        // 兜底：进程正常退出路径也要收尾
        KillChild();
        ReleaseJob();
    }

    /** 统一退出路径：结束子进程 → 释放作业对象 → 退出。 */
    private static void Shutdown(string reason)
    {
        if (shuttingDown) return;
        shuttingDown = true;

        Console.WriteLine();
        Console.WriteLine("  正在退出（" + reason + "）…");

        KillChild();
        Sleep(300);       // 给子进程一点时间释放端口
        ReleaseJob();

        Environment.Exit(0);
    }

    private static void KillChild()
    {
        try
        {
            if (child != null && !child.HasExited)
            {
                child.Kill();
                child.WaitForExit(3000);
            }
        }
        catch
        {
            // 已经退出或无权结束，忽略
        }
    }

    /* ══════════════ Job Object ══════════════ */

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    /**
     * 建立一个"句柄关闭即结束所有成员进程"的作业对象。
     * 这是 Windows 上保证父子进程同生共死的标准做法。
     */
    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject 失败");
        }

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        int length = Marshal.SizeOf(info);
        IntPtr ptr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length))
            {
                int err = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new System.ComponentModel.Win32Exception(err, "SetInformationJobObject 失败");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
        return job;
    }

    private static void AssignToJob(Process p)
    {
        if (jobHandle == IntPtr.Zero || p == null) return;
        try
        {
            if (!AssignProcessToJobObject(jobHandle, p.Handle))
            {
                int err = Marshal.GetLastWin32Error();
                Console.ForegroundColor = ConsoleColor.DarkYellow;
                Console.WriteLine("  ! 未能将服务进程纳入作业对象（错误 " + err + "），退出时请确认没有残留进程。");
                Console.ResetColor();
            }
        }
        catch (Exception ex)
        {
            Console.ForegroundColor = ConsoleColor.DarkYellow;
            Console.WriteLine("  ! 作业对象分配异常: " + ex.Message);
            Console.ResetColor();
        }
    }

    private static void ReleaseJob()
    {
        if (jobHandle == IntPtr.Zero) return;
        IntPtr h = jobHandle;
        jobHandle = IntPtr.Zero;
        try
        {
            // 关闭句柄即触发 KILL_ON_JOB_CLOSE，作业内所有进程被结束
            CloseHandle(h);
        }
        catch
        {
            // 忽略
        }
    }

    /* ══════════════ 工具方法 ══════════════ */

    private static void Banner()
    {
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("  ┌──────────────────────────────────────────┐");
        Console.WriteLine("  │            12306 余票雷达                │");
        Console.WriteLine("  └──────────────────────────────────────────┘");
        Console.ResetColor();
        Console.WriteLine("  只读查询余票与微信提醒；下单请用 12306 官方渠道。");
        Console.WriteLine("  不登录账号 · 不识别验证码 · 不自动下单 · 不支付");
        Console.WriteLine();
    }

    /**
     * 定位 node.exe。
     * 顺序：捆绑运行时 → 用户显式指定 → 常见安装位置 → PATH。
     * 捆绑运行时优先，这样随目录分发的 Node 不会被用户机器上
     * 可能存在的不兼容旧版本顶掉。
     */
    private static string FindNode(string root)
    {
        // 1) 随程序分发的运行时，优先级最高
        string bundled = Path.Combine(root, Path.Combine("runtime", "node.exe"));
        if (File.Exists(bundled)) return bundled;

        var explicitCandidates = new System.Collections.Generic.List<string>();

        // 2) 用户显式指定
        string env = Environment.GetEnvironmentVariable("TICKET_RADAR_NODE");
        if (!string.IsNullOrEmpty(env)) explicitCandidates.Add(env);

        // 3) 常见安装位置
        string pf = Environment.GetEnvironmentVariable("ProgramFiles");
        string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
        string lad = Environment.GetEnvironmentVariable("LocalAppData");

        if (!string.IsNullOrEmpty(pf)) explicitCandidates.Add(Path.Combine(pf, Path.Combine("nodejs", "node.exe")));
        if (!string.IsNullOrEmpty(pf86)) explicitCandidates.Add(Path.Combine(pf86, Path.Combine("nodejs", "node.exe")));
        if (!string.IsNullOrEmpty(lad)) explicitCandidates.Add(Path.Combine(lad, Path.Combine("Programs", Path.Combine("nodejs", "node.exe"))));
        explicitCandidates.Add(@"D:\nodejs\node.exe");
        explicitCandidates.Add(@"C:\nodejs\node.exe");

        foreach (string c in explicitCandidates)
        {
            if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c;
        }

        // 4) PATH
        string path = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(path))
        {
            foreach (string dir in path.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string full = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(full)) return full;
                }
                catch { /* 路径非法则跳过 */ }
            }
        }
        return null;
    }

    /**
     * 读取 data/config.json 里的 httpPort。
     *
     * 读不出来就返回 0（交给调用方用默认值）—— 这一步失败绝不能影响启动。
     * 用 Node 解析 JSON 而不是自己写解析器：配置偶尔会被手工编辑，
     * 而且 Node 本来就在手边，这样能保证和 server.js 的读法完全一致。
     */
    private static int ReadConfiguredPort(string root, string node)
    {
        if (string.IsNullOrEmpty(node)) return 0;

        string cfgFile = Path.Combine(root, Path.Combine("data", "config.json"));
        if (!File.Exists(cfgFile)) return 0;

        string tmp = Path.Combine(Path.GetTempPath(), "radar-port-" + Guid.NewGuid().ToString("N") + ".txt");
        string js =
            "const fs=require('fs');" +
            "try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));" +
            "fs.writeFileSync(process.argv[2],String(c.httpPort||''))}catch(e){}";

        try
        {
            var psi = new ProcessStartInfo(node)
            {
                Arguments = "-e \"" + js.Replace("\"", "\\\"") + "\" \"" + cfgFile + "\" \"" + tmp + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process p = Process.Start(psi);
            if (p == null) return 0;

            if (!p.WaitForExit(4000))
            {
                try { p.Kill(); } catch { }
                return 0;
            }

            if (!File.Exists(tmp)) return 0;
            string text = File.ReadAllText(tmp).Trim();
            int parsed;
            if (int.TryParse(text, out parsed) && parsed > 0 && parsed < 65536) return parsed;
        }
        catch
        {
            // 读配置失败按"没有配置"处理
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
        return 0;
    }

    private static bool IsListening(int port)
    {
        try
        {
            var client = new TcpClient();
            var task = client.ConnectAsync("127.0.0.1", port);
            bool ok = task.Wait(600) && client.Connected;
            client.Close();
            return ok;
        }
        catch
        {
            return false;
        }
    }

    /**
     * 判断该端口上跑的到底是不是本程序。
     * 只看端口通不通不够 —— 别的软件占用同一端口时不能误开浏览器。
     * 依据是 /api/state 返回里带有本程序特有的字段。
     */
    private static bool IsOurService(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/state");
            req.Method = "GET";
            req.Timeout = 2500;
            req.ReadWriteTimeout = 2500;
            req.Proxy = null;

            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var stream = resp.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                string body = reader.ReadToEnd();
                return resp.StatusCode == HttpStatusCode.OK
                    && body.IndexOf("stationCount", StringComparison.Ordinal) >= 0
                    && body.IndexOf("diagnostics", StringComparison.Ordinal) >= 0;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool WaitForPort(int port, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (IsListening(port)) return true;
            Thread.Sleep(250);
        }
        return false;
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            Console.WriteLine("  请手动在浏览器打开: " + url);
        }
    }

    private static int RunBlocking(string exe, string arguments)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo(exe)
            {
                Arguments = arguments,
                UseShellExecute = false,
            });
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Console.WriteLine("  ! 执行失败: " + ex.Message);
            return 1;
        }
    }

    private static string Quote(string s)
    {
        return "\"" + s + "\"";
    }

    private static void Sleep(int ms)
    {
        Thread.Sleep(ms);
    }

    private static void Pause()
    {
        Console.WriteLine("  按回车键退出…");
        try { Console.ReadLine(); } catch { }
    }
}
