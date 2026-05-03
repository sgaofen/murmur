// Murmur 微语 — Tauri shell
//
// Boots the backend in one of three ways:
//   (a) production: bundled PyInstaller `etcli{.exe}` from Contents/Resources/etcli/
//       (or the equivalent for other platforms). NO Python required.
//   (b) dev fallback: `python3 cli/etcli.py serve` if no bundle is found —
//       lets `npm run tauri:dev` work without rebuilding the backend.
//
// All backend stdout/stderr is piped to a log file under
//   ~/Documents/Murmur/logs/{tauri-shell.log,serve.log}     (macOS / Linux)
//   %USERPROFILE%/Documents/Murmur/logs/...                  (Windows)
// so we can debug PyInstaller bootloader / port-bind / TCC failures.
//
// On window close the spawned backend child is killed cleanly.

use std::fs::OpenOptions;
use std::io::{Read as _, Write as _};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent};

struct ServeProcess(Mutex<Option<Child>>);

#[derive(serde::Serialize)]
struct LogTail {
    logs_dir: String,
    serve: String,
    tauri_shell: String,
}

/// Set to true by `stop_etcli_serve` so the watchdog stops attempting to
/// respawn the backend after the user closes the window or quits the app.
/// Without this, the watchdog races with shutdown and may resurrect a child
/// that the cleanup just killed.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let p = PathBuf::from(home).join("Documents").join("Murmur").join("logs");
    std::fs::create_dir_all(&p).ok()?;
    Some(p)
}

fn log_line(s: &str) {
    if let Some(d) = log_dir() {
        if let Ok(mut f) = OpenOptions::new()
            .create(true).append(true).open(d.join("tauri-shell.log"))
        {
            let _ = writeln!(f, "{}", s);
        }
    }
}

fn tail_text(path: PathBuf, max_lines: usize, max_bytes: u64) -> String {
    let mut f = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    if size > max_bytes {
        let _ = std::io::Seek::seek(&mut f, std::io::SeekFrom::Start(size - max_bytes));
    }
    let mut buf = Vec::new();
    let _ = f.take(max_bytes).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }
    lines.join("\n")
}

#[tauri::command]
fn read_log_tail(lines: Option<usize>) -> LogTail {
    let max_lines = lines.unwrap_or(80).clamp(20, 200);
    let dir = log_dir();
    match dir {
        Some(d) => LogTail {
            logs_dir: d.to_string_lossy().to_string(),
            serve: tail_text(d.join("serve.log"), max_lines, 64_000),
            tauri_shell: tail_text(d.join("tauri-shell.log"), max_lines, 64_000),
        },
        None => LogTail {
            logs_dir: String::new(),
            serve: String::new(),
            tauri_shell: String::new(),
        },
    }
}

fn locate_etcli_exe(app: &AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") { "etcli.exe" } else { "etcli" };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("etcli").join(exe_name);
        log_line(&format!(
            "trying resource_dir/etcli/{}: {:?} exists={}",
            exe_name, candidate, candidate.exists()
        ));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let mut search = exe.parent().map(PathBuf::from)?;
    for _ in 0..6 {
        for sub in &["etcli", "_up_/etcli", "../etcli", "../Resources/etcli"] {
            let candidate = search.join(sub).join(exe_name);
            log_line(&format!(
                "trying walk-up {}: {:?} exists={}",
                sub, candidate, candidate.exists()
            ));
            if candidate.exists() {
                return Some(candidate);
            }
        }
        match search.parent() {
            Some(p) => search = p.to_path_buf(),
            None => break,
        }
    }
    None
}

fn locate_dev_etcli_py() -> Option<PathBuf> {
    // Dev mode: walk up from the target/ binary to find <repo>/cli/etcli.py
    let exe = std::env::current_exe().ok()?;
    let mut search = exe.parent().map(PathBuf::from)?;
    for _ in 0..6 {
        let candidate = search.join("cli").join("etcli.py");
        if candidate.exists() {
            return Some(candidate);
        }
        match search.parent() {
            Some(p) => search = p.to_path_buf(),
            None => break,
        }
    }
    None
}

/// Kill any leftover etcli process from a previous Murmur run that didn't shut
/// down cleanly (force-quit, crash, killed from Task Manager, etc.).
///
/// Why this matters: `_run_server` uses `ThreadingHTTPServer((host, port), …)`
/// which raises `OSError [Errno 10048]` on a port-already-in-use bind. The
/// Python process then exits non-zero, BUT `cmd.spawn()` here returns Ok
/// regardless — Tauri has no way to notice the child died. The webview then
/// fetches `http://127.0.0.1:9100` and gets a confusing "fail to fetch".
///
/// This was the most-reported "一点开始立马 fail" symptom in 0.2.5–0.2.10.
/// `our_pid` is excluded from the kill so we don't accidentally kill ourselves
/// on Windows where some confused state might match the image filter.
fn kill_stale_etcli() {
    let our_pid = std::process::id();
    log_line(&format!("kill_stale_etcli (our pid={})", our_pid));

    #[cfg(target_os = "windows")]
    {
        let r = Command::new("taskkill")
            .args(["/F", "/IM", "etcli.exe", "/T", "/FI", &format!("PID ne {}", our_pid)])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status();
        log_line(&format!("  taskkill /IM etcli.exe: {:?}", r));
    }
    #[cfg(not(target_os = "windows"))]
    {
        // pgrep -f matches the full command line, so this catches both the
        // PyInstaller bundle (`.../etcli serve …`) and the dev-mode invocation
        // (`python3 cli/etcli.py serve …`). We can't easily exclude our own
        // pid here — but pkill -f 'etcli.*serve' won't match the Murmur app
        // binary, so it's fine.
        let _ = Command::new("pkill")
            .args(["-f", "etcli.*serve"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status();
        log_line("  pkill -f 'etcli.*serve' done");
    }

    // Give the OS ~400ms to actually release port 9100. Without this, the
    // immediately-following bind can still race and fail.
    std::thread::sleep(Duration::from_millis(400));
}

/// Background watchdog that respawns etcli if it dies unexpectedly.
///
/// Polls `Child::try_wait()` every 3 seconds. If the child exited and we are
/// not in the middle of a shutdown, kills any zombie + spawns a fresh etcli +
/// updates the managed state.
///
/// Throttles restarts: max 5 in any 60-second window. Beyond that, sleeps 60s
/// before trying again — protects against tight crash loops (e.g. wx_key.dll
/// missing → every spawn dies in 200ms → would otherwise burn CPU and spam logs).
///
/// This is the answer to "如果 etcli 挂了怎么办". 90% coverage of crash modes
/// (segfault, OOM, uncaught Python exception). Doesn't catch true hangs
/// (deadlock without exit) — for that we'd need an HTTP health probe, which
/// is a much bigger lift.
fn start_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        let mut restart_window: Vec<Instant> = Vec::new();
        let mut backoff_until: Option<Instant> = None;

        loop {
            std::thread::sleep(Duration::from_secs(3));

            if SHUTTING_DOWN.load(Ordering::Relaxed) {
                log_line("watchdog: shutdown flagged, exiting");
                return;
            }

            if let Some(until) = backoff_until {
                if Instant::now() < until {
                    continue;
                }
                backoff_until = None;
                restart_window.clear();
                log_line("watchdog: backoff window over, resuming health checks");
            }

            let needs_restart = match app.try_state::<ServeProcess>() {
                Some(state) => match state.0.lock() {
                    Ok(mut guard) => match guard.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(Some(status)) => {
                                let pid = child.id();
                                log_line(&format!(
                                    "watchdog: etcli pid={} exited unexpectedly with {}",
                                    pid, status
                                ));
                                *guard = None;
                                true
                            }
                            Ok(None) => false, // healthy
                            Err(e) => {
                                log_line(&format!("watchdog: try_wait err: {}", e));
                                false
                            }
                        },
                        // Slot empty + not shutting down = either (a) the
                        // initial spawn at startup failed, or (b) a previous
                        // watchdog cycle's respawn returned None. Either way,
                        // try again. Throttle below prevents tight loops.
                        None => true,
                    },
                    Err(e) => {
                        log_line(&format!("watchdog: state lock poisoned: {}", e));
                        false
                    }
                },
                None => {
                    log_line("watchdog: app state gone, exiting");
                    return;
                }
            };

            if !needs_restart {
                continue;
            }

            // Re-check shutdown flag after detection — user may have quit
            // while we were noticing the crash.
            if SHUTTING_DOWN.load(Ordering::Relaxed) {
                log_line("watchdog: shutdown flagged after crash detect, NOT restarting");
                return;
            }

            // Throttle: drop restart entries older than 60s, then check count.
            let now = Instant::now();
            restart_window.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
            if restart_window.len() >= 5 {
                log_line(
                    "watchdog: 5+ restarts in last 60s — entering 60s backoff. \
                     etcli is crash-looping; user should check serve.log."
                );
                backoff_until = Some(now + Duration::from_secs(60));
                continue;
            }
            restart_window.push(now);

            log_line(&format!(
                "watchdog: respawning etcli (restart #{} this minute)",
                restart_window.len()
            ));
            let new_child = spawn_etcli_serve(&app);
            if let Some(state) = app.try_state::<ServeProcess>() {
                if let Ok(mut g) = state.0.lock() {
                    *g = new_child;
                }
            }
        }
    });
}

fn open_log_for_serve() -> (Stdio, Stdio) {
    let log_path = log_dir().map(|d| d.join("serve.log"));
    let stdout: Stdio = log_path
        .as_ref()
        .and_then(|p| std::fs::File::create(p).ok())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let stderr: Stdio = log_path
        .as_ref()
        .and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    (stdout, stderr)
}

fn spawn_etcli_serve(app: &AppHandle) -> Option<Child> {
    // First, evict any stale backend that's still squatting port 9100. See
    // `kill_stale_etcli` for the race this resolves. Safe to call on every
    // (re)spawn — taskkill returns silently if no match.
    kill_stale_etcli();

    // Path A: bundled PyInstaller binary
    if let Some(etcli) = locate_etcli_exe(app) {
        log_line(&format!("etcli located: {:?}", etcli));
        let work_dir = etcli.parent()?;
        let (stdout, stderr) = open_log_for_serve();

        let mut cmd = Command::new(&etcli);
        cmd.current_dir(work_dir);
        cmd.arg("serve").arg("--port").arg("9100");
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        return match cmd.spawn() {
            Ok(child) => { log_line(&format!("spawn OK pid={}", child.id())); Some(child) }
            Err(e)    => { log_line(&format!("spawn err: {}", e));            None }
        };
    }

    // Path B: dev fallback — python3 cli/etcli.py serve
    let etcli_py = locate_dev_etcli_py()?;
    let cli_dir = etcli_py.parent()?;
    log_line(&format!("dev fallback: python3 {:?}", etcli_py));
    let py = if cfg!(target_os = "windows") { "python" } else { "python3" };
    let (stdout, stderr) = open_log_for_serve();

    let mut cmd = Command::new(py);
    cmd.current_dir(cli_dir);
    cmd.arg(&etcli_py).arg("serve").arg("--port").arg("9100");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().ok()
}

fn stop_etcli_serve(app: &AppHandle, reason: &str) {
    log_line(&format!("stopping etcli: {}", reason));
    // Tell the watchdog to stop trying to respawn. Must be set BEFORE we
    // take the child out of the mutex, otherwise the watchdog could observe
    // the empty slot and respawn before noticing the shutdown.
    SHUTTING_DOWN.store(true, Ordering::Relaxed);
    if let Some(state) = app.try_state::<ServeProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let pid = child.id();
                match child.try_wait() {
                    Ok(Some(status)) => {
                        log_line(&format!("etcli pid={} already exited: {}", pid, status));
                    }
                    Ok(None) => {
                        log_line(&format!("killing etcli pid={}", pid));
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    Err(e) => {
                        log_line(&format!("etcli pid={} status check failed: {}", pid, e));
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            } else {
                log_line("no managed etcli process to stop");
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServeProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![read_log_tail])
        .setup(|app| {
            log_line("=== Murmur startup ===");
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let child = spawn_etcli_serve(app.handle());
            if let Some(state) = app.try_state::<ServeProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = child;
                }
            }
            // Watchdog: respawn etcli if it dies (segfault / OOM / Python
            // uncaught exception). Keep it OUTSIDE the spawn match so the
            // watchdog still runs even if the initial spawn failed — it'll
            // notice the empty slot, run kill_stale_etcli, and retry.
            start_watchdog(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                stop_etcli_serve(window.app_handle(), "window destroyed");
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } => stop_etcli_serve(app, "exit requested"),
            RunEvent::Exit => stop_etcli_serve(app, "event loop exit"),
            _ => {}
        });
}
