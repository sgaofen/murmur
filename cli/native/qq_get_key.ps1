<#
.SYNOPSIS
    Finds the LEA instruction and function RVA that reference the nt_sqlite3_key_v2 string in wrapper.node,
    and launches QQ with a debugger to extract the encryption key.

.DESCRIPTION
    This script analyzes a wrapper.node PE64 file to find:
    1. The RVA of the target string "nt_sqlite3_key_v2: db=%p zDb=%s" in .rdata
    2. The LEA instruction in .text that references this string (RIP-relative addressing)
    3. The function containing this LEA instruction (via exception directory)

    It can automatically detect installed QQ and locate the wrapper.node file.
    By default, it launches QQ with a debugger attached to extract the encryption key.
    Use -NoDebugForKey to skip debugging and perform only static analysis.

    Compatible with Windows PowerShell 5.0 and PowerShell Core 7.0.

.PARAMETER WrapperNodePath
    Path to the wrapper.node file. If not specified, auto-detects from installed QQ.

.PARAMETER NoDebugForKey
    If specified, skips launching QQ.exe with a debugger. Only performs static analysis.

.PARAMETER TimeoutSeconds
    Hard limit for the whole debugging session. QQ is terminated when it elapses.

.PARAMETER SettleSeconds
    After the first plausible 16-char candidate is seen, keep collecting for this
    many more seconds (the message-DB key usually shows up after login.db's), then stop.

.PARAMETER MaxHits
    Stop after this many breakpoint hits.

.NOTES (Murmur, issue #5)
    The breakpointed function is not always the real sqlite3_key_v2: on some
    wrapper.node builds it is a logging wrapper and R8 holds zDb or the global
    login.db key instead of pKey. So we do NOT stop at the first hit and do NOT
    trust a single register. Every hit, we read printable ASCII from the
    pointers in RCX/RDX/R8/R9 and the stack argument slots, and print each
    distinct string as
        MURMUR_KEY_CANDIDATE source=<where> len=<n> hex=<ascii-as-hex>
    The Python side (cli/qq_decrypt.py) HMAC-verifies every candidate against
    nt_msg.db page 1 and keeps only the one that decrypts.

.EXAMPLE
    .\v2.ps1
    # Auto-detects installed QQ, analyzes wrapper.node, and extracts the encryption key

.EXAMPLE
    .\v2.ps1 -WrapperNodePath "C:\QQ\wrapper.node"
    # Analyzes a specific wrapper.node file and extracts the encryption key

.EXAMPLE
    .\v2.ps1 -NoDebugForKey
    # Auto-detects QQ, analyzes wrapper.node, but skips debugging to extract the key

.OUTPUTS
    PSCustomObject with FunctionRVA, LeaInstructionRVA and Candidates (unverified key candidates).

.NOTES
    This script uses Write-Host intentionally for interactive colored output.
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive script requiring colored console output')]
param(
    [Parameter(Position = 0)]
    [string]$WrapperNodePath,

    [Parameter()]
    [switch]$NoDebugForKey,

    [Parameter()]
    [int]$TimeoutSeconds = 180,

    [Parameter()]
    [int]$SettleSeconds = 20,

    [Parameter()]
    [int]$MaxHits = 400
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

#region Reload Script as UTF-8, if running locally
if ($PSVersionTable.PSVersion.Major -le 5) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} else {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    if ([Console]::InputEncoding) { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 }
}
$currentCommand = $MyInvocation.MyCommand
if ($PSVersionTable.PSVersion.Major -le 5 -and 
    $currentCommand.CommandType -eq 'ExternalScript' -and 
    $currentCommand.Path) {
    try {
        $scriptContent = [System.IO.File]::ReadAllText($currentCommand.Path, [System.Text.Encoding]::UTF8)
        $scriptBlock = [scriptblock]::Create($scriptContent)
        & $scriptBlock @PSBoundParameters
        exit $LASTEXITCODE
    }
    catch {
        Write-Warning "UTF-8 Auto-Reload Failed: $_"
    }
}
#endregion

#region P/Invoke Definitions for Debugging

$DebugApiCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DebugApi
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct STARTUPINFOW
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    // DEBUG_EVENT structure for x64
    // Layout: dwDebugEventCode (4) + dwProcessId (4) + dwThreadId (4) + padding (4) + union (160)
    // Total: 176 bytes
    // We use a byte array for the union and manually parse it to avoid CLR alignment issues
    [StructLayout(LayoutKind.Sequential)]
    internal struct DEBUG_EVENT
    {
        public uint dwDebugEventCode;
        public uint dwProcessId;
        public uint dwThreadId;
        private uint _padding; // 4 bytes padding for 8-byte alignment of union
        // Union as byte array - we'll parse manually
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 160)]
        public byte[] u;
    }

    // Helper class for parsing DEBUG_EVENT union data
    internal static class DebugEventParser
    {
        // EXCEPTION_DEBUG_INFO: ExceptionRecord starts at offset 0
        // EXCEPTION_RECORD layout on x64:
        //   0: ExceptionCode (4)
        //   4: ExceptionFlags (4)
        //   8: ExceptionRecord pointer (8)
        //  16: ExceptionAddress pointer (8)
        //  24: NumberParameters (4)
        //  28: padding (4)
        //  32: ExceptionInformation[15] (120)
        public static uint GetExceptionCode(byte[] u)
        {
            return BitConverter.ToUInt32(u, 0);
        }

        public static ulong GetExceptionAddress(byte[] u)
        {
            return BitConverter.ToUInt64(u, 16);
        }

        // CREATE_PROCESS_DEBUG_INFO / LOAD_DLL_DEBUG_INFO: hFile is at offset 0
        public static IntPtr GetFileHandle(byte[] u)
        {
            return (IntPtr)BitConverter.ToInt64(u, 0);
        }

        // EXIT_PROCESS_DEBUG_INFO: dwExitCode is at offset 0
        public static uint GetExitCode(byte[] u)
        {
            return BitConverter.ToUInt32(u, 0);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct MODULEENTRY32W
    {
        public uint dwSize;
        public uint th32ModuleID;
        public uint th32ProcessID;
        public uint GlblcntUsage;
        public uint ProccntUsage;
        public IntPtr modBaseAddr;
        public uint modBaseSize;
        public IntPtr hModule;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szModule;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExePath;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 16)]
    internal struct CONTEXT64
    {
        public ulong P1Home;
        public ulong P2Home;
        public ulong P3Home;
        public ulong P4Home;
        public ulong P5Home;
        public ulong P6Home;
        public uint ContextFlags;
        public uint MxCsr;
        public ushort SegCs;
        public ushort SegDs;
        public ushort SegEs;
        public ushort SegFs;
        public ushort SegGs;
        public ushort SegSs;
        public uint EFlags;
        public ulong Dr0;
        public ulong Dr1;
        public ulong Dr2;
        public ulong Dr3;
        public ulong Dr6;
        public ulong Dr7;
        public ulong Rax;
        public ulong Rcx;
        public ulong Rdx;
        public ulong Rbx;
        public ulong Rsp;
        public ulong Rbp;
        public ulong Rsi;
        public ulong Rdi;
        public ulong R8;
        public ulong R9;
        public ulong R10;
        public ulong R11;
        public ulong R12;
        public ulong R13;
        public ulong R14;
        public ulong R15;
        public ulong Rip;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 512)]
        public byte[] FltSave;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 26)]
        public ulong[] VectorRegister;
        public ulong VectorControl;
        public ulong DebugControl;
        public ulong LastBranchToRip;
        public ulong LastBranchFromRip;
        public ulong LastExceptionToRip;
        public ulong LastExceptionFromRip;
    }

    internal static class Native
    {
        public const int DEBUG_ONLY_THIS_PROCESS = 0x00000002;
        public const uint INFINITE = 0xFFFFFFFF;

        public const uint EXCEPTION_DEBUG_EVENT = 1;
        public const uint CREATE_THREAD_DEBUG_EVENT = 2;
        public const uint CREATE_PROCESS_DEBUG_EVENT = 3;
        public const uint EXIT_THREAD_DEBUG_EVENT = 4;
        public const uint EXIT_PROCESS_DEBUG_EVENT = 5;
        public const uint LOAD_DLL_DEBUG_EVENT = 6;
        public const uint UNLOAD_DLL_DEBUG_EVENT = 7;
        public const uint OUTPUT_DEBUG_STRING_EVENT = 8;
        public const uint RIP_EVENT = 9;

        public const uint EXCEPTION_BREAKPOINT = 0x80000003;
        public const uint EXCEPTION_SINGLE_STEP = 0x80000004;

        public const uint DBG_CONTINUE = 0x00010002;
        public const uint DBG_EXCEPTION_NOT_HANDLED = 0x80010001;

        public const uint CONTEXT_AMD64 = 0x00100000;
        public const uint CONTEXT_CONTROL = CONTEXT_AMD64 | 0x0001;
        public const uint CONTEXT_INTEGER = CONTEXT_AMD64 | 0x0002;
        public const uint CONTEXT_FULL = CONTEXT_CONTROL | CONTEXT_INTEGER | (CONTEXT_AMD64 | 0x0008);
        public const uint CONTEXT_ALL = CONTEXT_FULL | (CONTEXT_AMD64 | 0x0004) | (CONTEXT_AMD64 | 0x0010);

        public const uint TH32CS_SNAPMODULE = 0x00000008;
        public const uint TH32CS_SNAPMODULE32 = 0x00000010;
        public const uint THREAD_ALL_ACCESS = 0x1FFFFF;

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(
            string lpApplicationName,
            IntPtr lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            int dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFOW lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WaitForDebugEvent(out DEBUG_EVENT lpDebugEvent, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ContinueDebugEvent(uint dwProcessId, uint dwThreadId, uint dwContinueStatus);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, int uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadProcessMemory(
            IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer,
            UIntPtr nSize, out UIntPtr lpNumberOfBytesRead);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WriteProcessMemory(
            IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer,
            UIntPtr nSize, out UIntPtr lpNumberOfBytesWritten);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FlushInstructionCache(IntPtr hProcess, IntPtr lpBaseAddress, UIntPtr dwSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenThread(uint dwDesiredAccess, bool bInheritHandle, uint dwThreadId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetThreadContext(IntPtr hThread, ref CONTEXT64 lpContext);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetThreadContext(IntPtr hThread, ref CONTEXT64 lpContext);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool Module32FirstW(IntPtr hSnapshot, ref MODULEENTRY32W lpme);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool Module32NextW(IntPtr hSnapshot, ref MODULEENTRY32W lpme);
    }

    /// <summary>
    /// High-level debugger class that extracts the encryption key from QQ process.
    /// All P/Invoke calls are handled internally to avoid PowerShell marshaling issues.
    /// </summary>
    public sealed class KeyExtractor
    {
        private readonly string _qqExePath;
        private readonly ulong _functionRva;
        private readonly Action<string> _log;
        private readonly Action<string> _logVerbose;

        private IntPtr _hProcess = IntPtr.Zero;
        private IntPtr _hThread = IntPtr.Zero;
        private uint _processId;
        private ulong _wrapperBase;
        private ulong _breakpointAddress;
        private byte _originalByte;
        private bool _breakpointActive;
        private Dictionary<uint, ulong> _steppingThreads = new Dictionary<uint, ulong>();

        // Candidate collection (issue #5): never stop at the first hit.
        private const string LoginDbFixedKey = "BD156D6710D54D8782F4";
        private const int MaxCandidates = 300;
        private readonly int _timeoutMs;
        private readonly int _settleMs;
        private readonly int _maxHits;
        private readonly List<string> _candidates = new List<string>();
        private readonly HashSet<string> _seen = new HashSet<string>();
        private readonly Dictionary<string, int> _hitCountOf = new Dictionary<string, int>();
        private readonly Dictionary<string, int> _lastHitOf = new Dictionary<string, int>();
        private readonly System.Diagnostics.Stopwatch _clock = new System.Diagnostics.Stopwatch();
        private long _firstUsefulMs = -1;
        private int _hits;

        public KeyExtractor(string qqExePath, ulong functionRva, Action<string> log, Action<string> logVerbose)
            : this(qqExePath, functionRva, log, logVerbose, 180, 20, 400)
        {
        }

        public KeyExtractor(string qqExePath, ulong functionRva, Action<string> log, Action<string> logVerbose,
                            int timeoutSeconds, int settleSeconds, int maxHits)
        {
            _qqExePath = qqExePath;
            _functionRva = functionRva;
            _log = log ?? (s => { });
            _logVerbose = logVerbose ?? (s => { });
            _timeoutMs = Math.Max(10, timeoutSeconds) * 1000;
            _settleMs = Math.Max(1, settleSeconds) * 1000;
            _maxHits = Math.Max(1, maxHits);
        }

        public int HitCount { get { return _hits; } }

        /// <summary>
        /// Launch QQ under the debugger and collect every distinct ASCII string
        /// seen at the breakpoint. Returns them all; the caller verifies which
        /// one is the real key (HMAC check against nt_msg.db).
        /// </summary>
        public string[] ExtractCandidates()
        {
            _log("正在启动 QQ 进程并附加调试器...");
            _log("QQ.exe 路径: " + _qqExePath);
            _log("目标函数 RVA: 0x" + _functionRva.ToString("X"));

            if (!StartDebugProcess())
            {
                throw new Exception("启动 QQ 进程并附加调试器失败。错误: " + Marshal.GetLastWin32Error());
            }

            _log("QQ 进程已启动。PID: " + _processId);
            _log("等待 wrapper.node 加载...");
            _log("请在 QQ 窗口中登录目标 QQ 账号。登录后等聊天列表加载出来，脚本会再收集 "
                 + (_settleMs / 1000) + " 秒后自动结束（最长 " + (_timeoutMs / 1000) + " 秒）。");

            _clock.Start();
            try
            {
                DebugLoop();
                return _candidates.ToArray();
            }
            finally
            {
                Cleanup();
            }
        }

        private bool StartDebugProcess()
        {
            STARTUPINFOW si = new STARTUPINFOW();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
            PROCESS_INFORMATION pi;

            bool result = Native.CreateProcessW(
                _qqExePath,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                Native.DEBUG_ONLY_THIS_PROCESS,
                IntPtr.Zero,
                null,
                ref si,
                out pi);

            if (result)
            {
                _hProcess = pi.hProcess;
                _hThread = pi.hThread;
                _processId = (uint)pi.dwProcessId;
            }

            return result;
        }

        private ulong GetModuleBaseAddress(string moduleName)
        {
            // Use both flags like the Rust implementation
            IntPtr snapshot = Native.CreateToolhelp32Snapshot(
                Native.TH32CS_SNAPMODULE | Native.TH32CS_SNAPMODULE32, _processId);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
                return 0;

            try
            {
                MODULEENTRY32W entry = new MODULEENTRY32W();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(MODULEENTRY32W));

                if (Native.Module32FirstW(snapshot, ref entry))
                {
                    do
                    {
                        if (string.Equals(entry.szModule, moduleName, StringComparison.OrdinalIgnoreCase))
                        {
                            return (ulong)entry.modBaseAddr;
                        }
                    } while (Native.Module32NextW(snapshot, ref entry));
                }
            }
            finally
            {
                Native.CloseHandle(snapshot);
            }

            return 0;
        }

        private bool SetBreakpoint()
        {
            _breakpointAddress = _wrapperBase + _functionRva;
            _log("在以下地址设置断点: 0x" + _breakpointAddress.ToString("X"));

            byte[] buffer = new byte[1];
            UIntPtr bytesRead;
            if (!Native.ReadProcessMemory(_hProcess, (IntPtr)_breakpointAddress, buffer, new UIntPtr(1), out bytesRead) || bytesRead != new UIntPtr(1))
            {
                _log("读取原始字节失败");
                return false;
            }

            _originalByte = buffer[0];

            byte[] int3 = new byte[] { 0xCC };
            UIntPtr bytesWritten;
            if (!Native.WriteProcessMemory(_hProcess, (IntPtr)_breakpointAddress, int3, new UIntPtr(1), out bytesWritten) || bytesWritten != new UIntPtr(1))
            {
                _log("写入断点失败");
                return false;
            }

            Native.FlushInstructionCache(_hProcess, (IntPtr)_breakpointAddress, new UIntPtr(1));
            _breakpointActive = true;
            _log("断点设置成功");
            return true;
        }

        private void RestoreOriginalByte()
        {
            byte[] orig = new byte[] { _originalByte };
            UIntPtr written;
            Native.WriteProcessMemory(_hProcess, (IntPtr)_breakpointAddress, orig, new UIntPtr(1), out written);
            Native.FlushInstructionCache(_hProcess, (IntPtr)_breakpointAddress, new UIntPtr(1));
        }

        private void ReinstallBreakpoint()
        {
            byte[] int3 = new byte[] { 0xCC };
            UIntPtr written;
            Native.WriteProcessMemory(_hProcess, (IntPtr)_breakpointAddress, int3, new UIntPtr(1), out written);
            Native.FlushInstructionCache(_hProcess, (IntPtr)_breakpointAddress, new UIntPtr(1));
            _breakpointActive = true;
        }

        private void DebugLoop()
        {
            DEBUG_EVENT debugEvent;
            bool shouldContinue = true;
            bool terminating = false;
            long terminateRequestedMs = 0;

            while (shouldContinue)
            {
                // Decide whether we have collected enough. Unlike the upstream
                // script we never stop at the first hit: the first hits are
                // login.db (global fixed key) and, on some builds, R8 is not
                // pKey at all (issue #5).
                if (!terminating)
                {
                    string why = StopReason();
                    if (why != null)
                    {
                        _log(why + "，结束 QQ 进程（共命中断点 " + _hits + " 次，收集到 " + _candidates.Count + " 个候选值）。");
                        Native.TerminateProcess(_hProcess, 0);
                        terminating = true;
                        terminateRequestedMs = _clock.ElapsedMilliseconds;
                    }
                }
                else if (_clock.ElapsedMilliseconds - terminateRequestedMs > 15000)
                {
                    _log("等待 QQ 进程退出超时，直接结束调试。");
                    break;
                }

                // Short wait so the time-based stop conditions above are checked often.
                if (!Native.WaitForDebugEvent(out debugEvent, 1000))
                {
                    int error = Marshal.GetLastWin32Error();
                    // Timeout (ERROR_SEM_TIMEOUT = 121) is normal, continue waiting
                    if (error != 121)
                        _logVerbose("WaitForDebugEvent failed with error: " + error);
                    continue;
                }

                uint continueStatus = Native.DBG_CONTINUE;

                switch (debugEvent.dwDebugEventCode)
                {
                    case Native.CREATE_PROCESS_DEBUG_EVENT:
                        _logVerbose("进程已创建。PID: " + debugEvent.dwProcessId);
                        // Close the file handle from CREATE_PROCESS_DEBUG_INFO
                        IntPtr hFile = DebugEventParser.GetFileHandle(debugEvent.u);
                        if (hFile != IntPtr.Zero && hFile != new IntPtr(-1))
                            Native.CloseHandle(hFile);
                        break;

                    case Native.CREATE_THREAD_DEBUG_EVENT:
                        _logVerbose("线程已创建: " + debugEvent.dwThreadId);
                        break;

                    case Native.EXIT_THREAD_DEBUG_EVENT:
                        _logVerbose("线程已退出: " + debugEvent.dwThreadId);
                        break;

                    case Native.LOAD_DLL_DEBUG_EVENT:
                        // Close the file handle from LOAD_DLL_DEBUG_INFO
                        IntPtr dllFileHandle = DebugEventParser.GetFileHandle(debugEvent.u);
                        if (dllFileHandle != IntPtr.Zero && dllFileHandle != new IntPtr(-1))
                            Native.CloseHandle(dllFileHandle);

                        // Check for wrapper.node if not found yet
                        if (_wrapperBase == 0)
                        {
                            ulong baseAddr = GetModuleBaseAddress("wrapper.node");
                            if (baseAddr != 0)
                            {
                                _wrapperBase = baseAddr;
                                _log("wrapper.node 已加载到: 0x" + _wrapperBase.ToString("X"));
                                ulong targetAddr = _wrapperBase + _functionRva;
                                _log("目标函数位于: 0x" + targetAddr.ToString("X"));
                                SetBreakpoint();
                            }
                        }
                        break;

                    case Native.UNLOAD_DLL_DEBUG_EVENT:
                        _logVerbose("DLL 已卸载");
                        break;

                    case Native.OUTPUT_DEBUG_STRING_EVENT:
                        // Just continue, we don't care about debug strings
                        break;

                    case Native.EXCEPTION_DEBUG_EVENT:
                        uint exceptionCode = DebugEventParser.GetExceptionCode(debugEvent.u);
                        ulong exceptionAddress = DebugEventParser.GetExceptionAddress(debugEvent.u);

                        if (exceptionCode == Native.EXCEPTION_BREAKPOINT)
                        {
                            // Check if this is our breakpoint
                            if (_breakpointActive && exceptionAddress == _breakpointAddress)
                            {
                                _logVerbose("软件断点在 0x" + exceptionAddress.ToString("X") + " 处被触发");

                                // Restore the original byte, harvest candidates, then
                                // single-step over the instruction and re-arm the
                                // breakpoint (see EXCEPTION_SINGLE_STEP below).
                                RestoreOriginalByte();
                                HandleBreakpoint(debugEvent.dwThreadId);
                            }
                            // System breakpoint or other breakpoints - just continue
                        }
                        else if (exceptionCode == Native.EXCEPTION_SINGLE_STEP)
                        {
                            if (_steppingThreads.ContainsKey(debugEvent.dwThreadId))
                            {
                                _logVerbose("线程 " + debugEvent.dwThreadId + " 中发生单步异常");
                                ClearTrapFlag(debugEvent.dwThreadId);
                                if (!terminating)
                                    ReinstallBreakpoint();
                                _steppingThreads.Remove(debugEvent.dwThreadId);
                                _logVerbose("断点已恢复到 0x" + _breakpointAddress.ToString("X"));
                            }
                        }
                        else
                        {
                            // Pass unhandled exceptions to the debuggee
                            continueStatus = Native.DBG_EXCEPTION_NOT_HANDLED;
                        }
                        break;

                    case Native.EXIT_PROCESS_DEBUG_EVENT:
                        uint exitCode = DebugEventParser.GetExitCode(debugEvent.u);
                        _log("进程已退出，退出代码: " + exitCode);
                        shouldContinue = false;
                        break;

                    case Native.RIP_EVENT:
                        _logVerbose("收到 RIP 事件");
                        break;

                    default:
                        _logVerbose("未知调试事件: " + debugEvent.dwDebugEventCode);
                        break;
                }

                Native.ContinueDebugEvent(debugEvent.dwProcessId, debugEvent.dwThreadId, continueStatus);
            }

            _log("调试结束：共命中断点 " + _hits + " 次，收集到 " + _candidates.Count + " 个候选值。");
        }

        private string StopReason()
        {
            long now = _clock.ElapsedMilliseconds;
            if (now >= _timeoutMs)
                return "已到总超时 " + (_timeoutMs / 1000) + " 秒";
            if (_hits >= _maxHits)
                return "断点命中次数达到上限 " + _maxHits;
            if (_candidates.Count >= MaxCandidates)
                return "候选值数量达到上限 " + MaxCandidates;
            if (_firstUsefulMs >= 0 && now - _firstUsefulMs >= _settleMs)
                return "16 位候选在多次命中中重复出现后，已继续收集 " + (_settleMs / 1000) + " 秒";
            return null;
        }

        private static bool LooksLikeNonKey(string s)
        {
            // login.db's global key (or a prefix of it) and 20-hex zDb names
            // are never the message-DB key.
            if (s.Length >= 8 && LoginDbFixedKey.StartsWith(s, StringComparison.Ordinal)) return true;
            if (s.Length != 20) return false;
            foreach (char c in s)
            {
                bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
                if (!hex) return false;
            }
            return true;
        }

        private void Emit(string source, byte[] buf, int len, bool countsForSettle)
        {
            if (len <= 0 || len > buf.Length) return;
            for (int i = 0; i < len; i++)
            {
                if (buf[i] < 0x20 || buf[i] > 0x7E) return;
            }
            string s = Encoding.ASCII.GetString(buf, 0, len);
            if (_seen.Add(s))
            {
                _candidates.Add(s);
                StringBuilder hex = new StringBuilder(len * 2);
                for (int i = 0; i < len; i++) hex.Append(buf[i].ToString("X2"));
                // Machine-readable line parsed by cli/qq_decrypt.py. Printed as soon
                // as it is found so a killed/timed-out run still yields candidates.
                _log("MURMUR_KEY_CANDIDATE source=" + source + " len=" + len + " hex=" + hex.ToString());
            }

            // Settle trigger: after login QQ opens several DBs (nt_msg, profile_info,
            // group_info, ...) with the same key, so a plausible 16-char value that
            // shows up in two different hits means the key has been seen. A single
            // stray string before login must not end the session early.
            if (!countsForSettle || len != 16 || LooksLikeNonKey(s)) return;
            int last;
            if (_lastHitOf.TryGetValue(s, out last) && last == _hits) return;
            _lastHitOf[s] = _hits;
            int count;
            _hitCountOf.TryGetValue(s, out count);
            count++;
            _hitCountOf[s] = count;
            if (count >= 2 && _firstUsefulMs < 0)
            {
                _firstUsefulMs = _clock.ElapsedMilliseconds;
                _log("已多次看到同一个 16 位候选值，再收集 " + (_settleMs / 1000) + " 秒后结束。");
            }
        }

        private bool TryRead(ulong ptr, byte[] buf, out int got)
        {
            got = 0;
            // Only plausible user-mode pointers; small integers (e.g. nKey) are skipped.
            if (ptr < 0x10000 || ptr > 0x7FFFFFFFFFFFUL) return false;
            UIntPtr read;
            if (Native.ReadProcessMemory(_hProcess, new IntPtr((long)ptr), buf, new UIntPtr((uint)buf.Length), out read)
                && (ulong)read > 0)
            {
                got = (int)(ulong)read;
                return true;
            }
            // The full read may cross into an unmapped page: retry up to the page end.
            int toPageEnd = (int)(0x1000 - (ptr & 0xFFF));
            if (toPageEnd >= buf.Length) return false;
            if (Native.ReadProcessMemory(_hProcess, new IntPtr((long)ptr), buf, new UIntPtr((uint)toPageEnd), out read)
                && (ulong)read > 0)
            {
                got = (int)(ulong)read;
                return true;
            }
            return false;
        }

        private void CollectFromPointer(string source, ulong ptr, ulong nKeyHint)
        {
            byte[] buf = new byte[128];
            int got;
            if (!TryRead(ptr, buf, out got)) return;

            // 1) Bounded by the following argument when it looks like nKey.
            if (nKeyHint >= 8 && nKeyHint <= 64 && (int)nKeyHint <= got)
                Emit(source + "/nKey", buf, (int)nKeyHint, true);

            // 2) NUL-terminated string of plausible length.
            int nul = Array.IndexOf(buf, (byte)0, 0, got);
            if (nul >= 8 && nul <= 64)
                Emit(source, buf, nul, true);

            // 3) The passphrase is 16 ASCII bytes and need not be NUL-terminated,
            //    so also take the first 16 bytes -- unless the whole string is a
            //    known non-key (login.db constant / 20-hex zDb name).
            bool knownNonKey = nul == 20 && LooksLikeNonKey(Encoding.ASCII.GetString(buf, 0, 20));
            if (got >= 16 && (nul < 0 || nul > 16) && !knownNonKey)
                Emit(source + "/16", buf, 16, false);
        }

        private ulong ReadStackSlot(ulong rsp, int offset)
        {
            byte[] b = new byte[8];
            UIntPtr read;
            if (!Native.ReadProcessMemory(_hProcess, new IntPtr((long)(rsp + (ulong)offset)), b, new UIntPtr(8), out read)
                || (ulong)read != 8)
                return 0;
            return BitConverter.ToUInt64(b, 0);
        }

        private void HandleBreakpoint(uint threadId)
        {
            _hits++;
            IntPtr hThread = Native.OpenThread(Native.THREAD_ALL_ACCESS, false, threadId);
            if (hThread == IntPtr.Zero)
                return;

            try
            {
                CONTEXT64 ctx = new CONTEXT64();
                ctx.ContextFlags = Native.CONTEXT_ALL;
                ctx.FltSave = new byte[512];
                ctx.VectorRegister = new ulong[26];

                if (!Native.GetThreadContext(hThread, ref ctx))
                {
                    _logVerbose("获取线程上下文失败");
                    return;
                }

                // Decrement RIP to point back to original instruction
                ctx.Rip = ctx.Rip - 1;

                // At function entry: RCX, RDX, R8, R9 are args 1-4; [RSP] is the
                // return address, [RSP+0x08..0x20] the shadow space, and args 5/6
                // live at [RSP+0x28]/[RSP+0x30]. We don't know which slot holds
                // pKey on this build, so read them all; each slot's successor is
                // used as an nKey hint.
                string[] names = new string[] { "RCX", "RDX", "R8", "R9", "RSP+20", "RSP+28", "RSP+30" };
                ulong[] vals = new ulong[]
                {
                    ctx.Rcx, ctx.Rdx, ctx.R8, ctx.R9,
                    ReadStackSlot(ctx.Rsp, 0x20), ReadStackSlot(ctx.Rsp, 0x28), ReadStackSlot(ctx.Rsp, 0x30)
                };
                _logVerbose("命中 #" + _hits + ": RCX=0x" + ctx.Rcx.ToString("X") + " RDX=0x" + ctx.Rdx.ToString("X")
                            + " R8=0x" + ctx.R8.ToString("X") + " R9=0x" + ctx.R9.ToString("X"));

                try
                {
                    for (int i = 0; i < vals.Length; i++)
                    {
                        ulong hint = (i + 1 < vals.Length) ? vals[i + 1] : 0;
                        CollectFromPointer(names[i], vals[i], hint);
                    }
                }
                finally
                {
                    // Always let the debuggee continue: write back the
                    // decremented RIP, step over the original instruction, and
                    // re-arm the breakpoint on EXCEPTION_SINGLE_STEP.
                    SetSingleStep(hThread, ref ctx, threadId);
                }
            }
            finally
            {
                Native.CloseHandle(hThread);
            }
        }

        private void SetSingleStep(IntPtr hThread, ref CONTEXT64 ctx, uint threadId)
        {
            ctx.EFlags = ctx.EFlags | 0x100;
            Native.SetThreadContext(hThread, ref ctx);
            _steppingThreads[threadId] = _breakpointAddress;
            _breakpointActive = false;
        }

        private void ClearTrapFlag(uint threadId)
        {
            IntPtr hThread = Native.OpenThread(Native.THREAD_ALL_ACCESS, false, threadId);
            if (hThread == IntPtr.Zero) return;

            try
            {
                CONTEXT64 ctx = new CONTEXT64();
                ctx.ContextFlags = Native.CONTEXT_ALL;
                ctx.FltSave = new byte[512];
                ctx.VectorRegister = new ulong[26];

                if (Native.GetThreadContext(hThread, ref ctx))
                {
                    ctx.EFlags = ctx.EFlags & ~0x100u;
                    Native.SetThreadContext(hThread, ref ctx);
                }
            }
            finally
            {
                Native.CloseHandle(hThread);
            }
        }

        private void Cleanup()
        {
            if (_hProcess != IntPtr.Zero)
            {
                Native.CloseHandle(_hProcess);
                _hProcess = IntPtr.Zero;
            }
            if (_hThread != IntPtr.Zero)
            {
                Native.CloseHandle(_hThread);
                _hThread = IntPtr.Zero;
            }
        }
    }
}
'@

#endregion

#region Helper Functions

function Read-UInt16 {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToUInt16($Bytes, $Offset)
}

function Read-UInt32 {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToUInt32($Bytes, $Offset)
}

function Read-UInt64 {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToUInt64($Bytes, $Offset)
}

function Read-Int32 {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToInt32($Bytes, $Offset)
}

function Find-BytePattern {
    param(
        [byte[]]$Data,
        [byte[]]$Pattern,
        [int]$StartOffset = 0,
        [int]$EndOffset = -1
    )

    if ($EndOffset -lt 0) {
        $EndOffset = $Data.Length
    }

    $patternLength = $Pattern.Length
    $searchEnd = $EndOffset - $patternLength

    for ($i = $StartOffset; $i -le $searchEnd; $i++) {
        $found = $true
        for ($j = 0; $j -lt $patternLength; $j++) {
            if ($Data[$i + $j] -ne $Pattern[$j]) {
                $found = $false
                break
            }
        }
        if ($found) {
            return $i
        }
    }
    return -1
}

function Get-InstalledQQInfo {
    <#
    .SYNOPSIS
        Detects installed QQ and returns installation info.
    .OUTPUTS
        Hashtable with InstallDir, Version, QQExePath, WrapperNodePath
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()

    $reg = $null

    # Try WOW6432Node first (32-bit or upgraded from 32-bit legacy QQ)
    try {
        $regPath = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ"
        if (Test-Path $regPath) {
            $reg = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
        }
    }
    catch {
        Write-Verbose "WOW6432Node QQ registry key not found"
    }

    # Try NTQQ registry key
    if (-not $reg -or -not $reg.UninstallString) {
        try {
            $regPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\NTQQ"
            if (Test-Path $regPath) {
                $reg = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-Verbose "NTQQ registry key not found"
        }
    }

    if (-not $reg -or -not $reg.UninstallString) {
        throw "QQ installation not found in registry"
    }

    $uninstallString = $reg.UninstallString
    Write-Verbose "UninstallString: $uninstallString"

    # Extract install directory from UninstallString
    # Handle quoted paths
    if ($uninstallString.StartsWith('"')) {
        $endQuote = $uninstallString.IndexOf('"', 1)
        if ($endQuote -gt 0) {
            $uninstallPath = $uninstallString.Substring(1, $endQuote - 1)
        }
        else {
            $uninstallPath = $uninstallString.Trim('"')
        }
    }
    else {
        # Unquoted path - find .exe extension to handle paths with spaces
        $exeIndex = $uninstallString.ToLower().IndexOf('.exe')
        if ($exeIndex -gt 0) {
            $uninstallPath = $uninstallString.Substring(0, $exeIndex + 4)
        }
        else {
            # Fallback: take everything before first space (legacy behavior)
            $uninstallPath = $uninstallString.Split(' ')[0]
        }
    }

    $installDir = Split-Path -Parent $uninstallPath
    Write-Verbose "Install directory: $installDir"

    if (-not (Test-Path $installDir)) {
        throw "QQ install directory not found: $installDir"
    }

    # Get version
    $version = $null
    try {
        $qqntRegPath = "HKCU:\Software\Tencent\QQNT"
        if (Test-Path $qqntRegPath) {
            $qqntReg = Get-ItemProperty -Path $qqntRegPath -ErrorAction SilentlyContinue
            if ($qqntReg -and $qqntReg.Version) {
                $version = $qqntReg.Version
            }
        }
    }
    catch {
        Write-Verbose "Could not read QQNT version from registry"
    }

    # Find version directory
    $versionsDir = Join-Path $installDir "versions"
    $versionDir = $null

    if ($version) {
        $versionDir = Join-Path $versionsDir $version
        if (-not (Test-Path $versionDir)) {
            Write-Verbose "Version directory $versionDir not found, trying alternatives"
            $versionDir = $null
        }
    }

    if (-not $versionDir) {
        # Try config.json
        $configJson = Join-Path $installDir "config.json"
        if (Test-Path $configJson) {
            try {
                $configContent = Get-Content $configJson -Raw
                if ($configContent -match '"curVersion"\s*:\s*"([^"]+)"') {
                    $version = $Matches[1]
                    $versionDir = Join-Path $versionsDir $version
                    Write-Verbose "Found version from config.json: $version"
                }
            }
            catch {
                Write-Verbose "Could not parse config.json"
            }
        }
    }

    if (-not $versionDir -or -not (Test-Path $versionDir)) {
        # Fall back to single directory in versions folder
        if (Test-Path $versionsDir) {
            $dirs = @(Get-ChildItem -Path $versionsDir -Directory -ErrorAction SilentlyContinue)
            if ($dirs.Count -eq 1) {
                $versionDir = $dirs[0].FullName
                $version = $dirs[0].Name
                Write-Verbose "Using single version directory: $versionDir"
            }
            elseif ($dirs.Count -gt 1) {
                throw "Multiple version directories found in $versionsDir. Please specify WrapperNodePath manually."
            }
            else {
                throw "No version directories found in $versionsDir"
            }
        }
        else {
            throw "Versions directory not found: $versionsDir"
        }
    }

    $wrapperNode = Join-Path $versionDir "resources\app\wrapper.node"
    if (-not (Test-Path $wrapperNode)) {
        throw "wrapper.node not found at: $wrapperNode"
    }

    $qqExe = Join-Path $installDir "QQ.exe"
    if (-not (Test-Path $qqExe)) {
        throw "QQ.exe not found at: $qqExe"
    }

    return @{
        InstallDir      = $installDir
        Version         = $version
        QQExePath       = $qqExe
        WrapperNodePath = $wrapperNode
    }
}

#endregion

#region Main Script

# Detect installed QQ if no path specified
$qqInfo = $null
if (-not $WrapperNodePath) {
    Write-Host "正在自动检测已安装的QQ..." -ForegroundColor Yellow
    $qqInfo = Get-InstalledQQInfo
    $WrapperNodePath = $qqInfo.WrapperNodePath
    Write-Host "找到QQ安装信息:" -ForegroundColor Green
    Write-Host "  安装目录: $($qqInfo.InstallDir)" -ForegroundColor Cyan
    Write-Host "  版本: $($qqInfo.Version)" -ForegroundColor Cyan
    Write-Host "  wrapper.node: $WrapperNodePath" -ForegroundColor Cyan
    Write-Host ""
}

# Resolve the path
$resolvedPath = Resolve-Path -Path $WrapperNodePath -ErrorAction Stop
Write-Verbose "Analyzing file: $resolvedPath"

# Read the entire file
$FileBytes = [System.IO.File]::ReadAllBytes($resolvedPath.Path)
Write-Verbose "File size: $($FileBytes.Length) bytes"

# Target pattern to search for
$TargetPattern = [System.Text.Encoding]::ASCII.GetBytes("nt_sqlite3_key_v2: db=%p zDb=%s")

#region Parse DOS Header
$e_magic = Read-UInt16 $FileBytes 0
if ($e_magic -ne 0x5A4D) {
    throw "Not a valid PE file (invalid DOS header, expected MZ)"
}
$e_lfanew = Read-UInt32 $FileBytes 0x3C
Write-Verbose "PE header offset: 0x$($e_lfanew.ToString('X'))"
#endregion

#region Parse PE Header
$peSignature = Read-UInt32 $FileBytes $e_lfanew
if ($peSignature -ne 0x00004550) {
    throw "Not a valid PE file (invalid PE signature)"
}

$coffHeaderOffset = $e_lfanew + 4
$machine = Read-UInt16 $FileBytes $coffHeaderOffset
$numberOfSections = Read-UInt16 $FileBytes ($coffHeaderOffset + 2)
$sizeOfOptionalHeader = Read-UInt16 $FileBytes ($coffHeaderOffset + 16)

Write-Verbose "Machine: 0x$($machine.ToString('X'))"
Write-Verbose "Number of sections: $numberOfSections"

$optionalHeaderOffset = $coffHeaderOffset + 20
$magic = Read-UInt16 $FileBytes $optionalHeaderOffset

if ($magic -ne 0x20B) {
    throw "Only PE32+ (64-bit) files are supported. Found magic: 0x$($magic.ToString('X'))"
}
#endregion

#region Parse Optional Header (PE32+)
$imageBase = Read-UInt64 $FileBytes ($optionalHeaderOffset + 24)
Write-Verbose "Image base: 0x$($imageBase.ToString('X'))"

# Data directories start at offset 112 in PE32+ optional header
$dataDirectoriesOffset = $optionalHeaderOffset + 112

# Exception directory is at index 3 (0-indexed)
$exceptionDirRVA = Read-UInt32 $FileBytes ($dataDirectoriesOffset + 3 * 8)
$exceptionDirSize = Read-UInt32 $FileBytes ($dataDirectoriesOffset + 3 * 8 + 4)
Write-Verbose "Exception directory RVA: 0x$($exceptionDirRVA.ToString('X')), Size: 0x$($exceptionDirSize.ToString('X'))"
#endregion

#region Parse Section Headers
$sectionHeadersOffset = $optionalHeaderOffset + $sizeOfOptionalHeader
$sections = @{}

for ($i = 0; $i -lt $numberOfSections; $i++) {
    $sectionOffset = $sectionHeadersOffset + ($i * 40)

    # Read section name (8 bytes, null-padded)
    $nameBytes = New-Object byte[] 8
    [Array]::Copy($FileBytes, $sectionOffset, $nameBytes, 0, 8)
    $name = [System.Text.Encoding]::ASCII.GetString($nameBytes).TrimEnd([char]0)

    $virtualSize = Read-UInt32 $FileBytes ($sectionOffset + 8)
    $virtualAddress = Read-UInt32 $FileBytes ($sectionOffset + 12)
    $sizeOfRawData = Read-UInt32 $FileBytes ($sectionOffset + 16)
    $pointerToRawData = Read-UInt32 $FileBytes ($sectionOffset + 20)

    $sections[$name] = @{
        Name             = $name
        VirtualAddress   = $virtualAddress
        VirtualSize      = $virtualSize
        PointerToRawData = $pointerToRawData
        SizeOfRawData    = $sizeOfRawData
    }

    Write-Verbose ("Section {0}: VA=0x{1:X}, VSize=0x{2:X}, RawPtr=0x{3:X}, RawSize=0x{4:X}" -f `
            $name, $virtualAddress, $virtualSize, $pointerToRawData, $sizeOfRawData)
}
#endregion

#region Find target string in .rdata section
$rdata = $sections[".rdata"]
if (-not $rdata) {
    throw ".rdata section not found"
}

$rdataStart = [int]$rdata.PointerToRawData
$rdataEnd = $rdataStart + [int]$rdata.SizeOfRawData

Write-Verbose "Searching for target pattern in .rdata section..."
$patternFileOffset = Find-BytePattern -Data $FileBytes -Pattern $TargetPattern -StartOffset $rdataStart -EndOffset $rdataEnd

if ($patternFileOffset -lt 0) {
    throw "Target pattern 'nt_sqlite3_key_v2: db=%p zDb=%s' not found in .rdata section"
}

# Calculate RVA of the string
$stringRVA = [uint64]$rdata.VirtualAddress + ([uint64]$patternFileOffset - [uint64]$rdata.PointerToRawData)

Write-Verbose "Target string found at file offset: 0x$($patternFileOffset.ToString('X'))"
Write-Host "目标字符串 RVA: 0x$($stringRVA.ToString('X'))" -ForegroundColor Cyan
#endregion

#region Search .text section for LEA instruction
$text = $sections[".text"]
if (-not $text) {
    throw ".text section not found"
}

$textStart = [int]$text.PointerToRawData
$textSize = [int]$text.SizeOfRawData
$textRVA = [uint64]$text.VirtualAddress

Write-Verbose "Searching for LEA instruction in .text section..."
Write-Verbose ".text section: fileOffset=0x$($textStart.ToString('X')), size=0x$($textSize.ToString('X')), RVA=0x$($textRVA.ToString('X'))"

$leaInstructionRVA = $null

for ($i = 1; $i -lt ($textSize - 6); $i++) {
    $fileOffset = $textStart + $i

    if ($FileBytes[$fileOffset] -ne 0x8D) {
        continue
    }

    $rex = $FileBytes[$fileOffset - 1]
    if (($rex -band 0xF8) -ne 0x48) {
        continue
    }

    $modrm = $FileBytes[$fileOffset + 1]
    if (($modrm -band 0xC7) -ne 0x05) {
        continue
    }

    $disp = Read-Int32 $FileBytes ($fileOffset + 2)

    $instrRVA = $textRVA + ($i - 1)
    $instrLen = 7
    $targetRVA = $instrRVA + $instrLen + $disp

    if ($targetRVA -eq $stringRVA) {
        $leaInstructionRVA = $instrRVA
        Write-Verbose "Found LEA instruction at file offset: 0x$(($textStart + $i - 1).ToString('X'))"
        break
    }
}

if ($null -eq $leaInstructionRVA) {
    throw "LEA instruction referencing target string not found in .text section"
}

Write-Host "LEA 指令 RVA: 0x$($leaInstructionRVA.ToString('X'))" -ForegroundColor Cyan
#endregion

#region Find function via exception directory
$exceptionSection = $null
foreach ($section in $sections.Values) {
    if ($exceptionDirRVA -ge $section.VirtualAddress -and
        $exceptionDirRVA -lt ($section.VirtualAddress + $section.VirtualSize)) {
        $exceptionSection = $section
        break
    }
}

if ($null -eq $exceptionSection) {
    throw "Could not find section containing exception directory"
}

Write-Verbose "Exception directory is in section: $($exceptionSection.Name)"

$exceptionDirFileOffset = [int]$exceptionSection.PointerToRawData + ([int]$exceptionDirRVA - [int]$exceptionSection.VirtualAddress)

$entrySize = 12
$numEntries = [int]($exceptionDirSize / $entrySize)

Write-Verbose "Exception directory: $numEntries entries at file offset 0x$($exceptionDirFileOffset.ToString('X'))"

$left = 0
$right = $numEntries - 1
$functionBeginRVA = $null
$targetRVA_uint32 = [uint32]$leaInstructionRVA

while ($left -le $right) {
    $mid = [int][Math]::Floor(($left + $right) / 2)
    $entryOffset = $exceptionDirFileOffset + ($mid * $entrySize)

    $beginAddr = Read-UInt32 $FileBytes $entryOffset
    $endAddr = Read-UInt32 $FileBytes ($entryOffset + 4)

    if ($targetRVA_uint32 -lt $beginAddr) {
        $right = $mid - 1
    }
    elseif ($targetRVA_uint32 -ge $endAddr) {
        $left = $mid + 1
    }
    else {
        $functionBeginRVA = $beginAddr
        Write-Verbose "Found function at entry index $mid : begin=0x$($beginAddr.ToString('X')), end=0x$($endAddr.ToString('X'))"
        break
    }
}

if ($null -eq $functionBeginRVA) {
    throw "Could not find function containing LEA instruction in exception directory"
}

Write-Host "函数 RVA: 0x$($functionBeginRVA.ToString('X'))" -ForegroundColor Green
#endregion

#region Output results
$result = [PSCustomObject]@{
    FunctionRVA       = $functionBeginRVA
    LeaInstructionRVA = [uint64]$leaInstructionRVA
    Candidates        = @()
}

Write-Host ""
Write-Host "=== 静态分析结果 ===" -ForegroundColor Yellow
Write-Host "函数 RVA:        0x$($result.FunctionRVA.ToString('X'))" -ForegroundColor Green
Write-Host "LEA 指令 RVA: 0x$($result.LeaInstructionRVA.ToString('X'))" -ForegroundColor Green
#endregion

#region Debug for key (default behavior, skip with -NoDebugForKey)
if ($NoDebugForKey) {
    return $result
}

Write-Host ""
Write-Host "=== 动态调试QQ进程 ===" -ForegroundColor Yellow

# Add the debug API type if not already added
if (-not ([System.Management.Automation.PSTypeName]'DebugApi.KeyExtractor').Type) {
    Add-Type -TypeDefinition $DebugApiCode -Language CSharp
}

if (-not $qqInfo) {
    $qqInfo = Get-InstalledQQInfo
}

# Create log delegates that write to host with appropriate colors
$logAction = [Action[string]] { param($msg) Write-Host $msg -ForegroundColor Cyan }
$logVerboseAction = [Action[string]] { param($msg) Write-Verbose $msg }

# Create and run the key extractor. It keeps QQ running after the first hit
# and collects candidates until -SettleSeconds after the first plausible one,
# -MaxHits, or -TimeoutSeconds; the caller HMAC-verifies them (issue #5).
$extractor = New-Object DebugApi.KeyExtractor(
    $qqInfo.QQExePath,
    [uint64]$functionBeginRVA,
    $logAction,
    $logVerboseAction,
    [int]$TimeoutSeconds,
    [int]$SettleSeconds,
    [int]$MaxHits
)

try {
    $candidates = $extractor.ExtractCandidates()
    $result.Candidates = $candidates
    Write-Host ""
    Write-Host "=== 最终结果 ===" -ForegroundColor Yellow
    Write-Host "函数 RVA:        0x$($result.FunctionRVA.ToString('X'))" -ForegroundColor Green
    Write-Host "LEA 指令 RVA: 0x$($result.LeaInstructionRVA.ToString('X'))" -ForegroundColor Green
    Write-Host "MURMUR_KEY_SUMMARY hits=$($extractor.HitCount) candidates=$($candidates.Count)" -ForegroundColor Green
    if ($candidates.Count -eq 0) {
        Write-Host "没有收集到任何候选值（断点没有命中，或 QQ 没有登录完成）" -ForegroundColor Red
    }
    else {
        Write-Host "候选值已输出（MURMUR_KEY_CANDIDATE 行），需要用 nt_msg.db 做 HMAC 校验才能确定哪个是真 key。" -ForegroundColor Green
    }
}
catch {
    Write-Host "密钥提取过程中出错: $_" -ForegroundColor Red
}
#endregion

return $result
