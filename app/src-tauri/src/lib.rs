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
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent};

struct ServeProcess(Mutex<Option<Child>>);

#[derive(serde::Serialize)]
struct LogTail {
    logs_dir: String,
    serve: String,
    tauri_shell: String,
}

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
