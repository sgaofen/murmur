// Murmur 微语 — Tauri shell
//
// On startup we spawn the bundled `etcli.exe serve --port 9100` (PyInstaller
// one-folder build, fully self-contained). The frontend talks to it via HTTP.
// On window close we kill the child.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

struct ServeProcess(Mutex<Option<Child>>);

fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let p = PathBuf::from(home).join("Documents").join("Murmur").join("logs");
    std::fs::create_dir_all(&p).ok()?;
    Some(p)
}

fn log_line(s: &str) {
    if let Some(d) = log_dir() {
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(d.join("tauri-shell.log"))
        {
            let _ = writeln!(f, "{}", s);
        }
    }
}

fn locate_etcli_exe(app: &AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") { "etcli.exe" } else { "etcli" };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("etcli").join(exe_name);
        log_line(&format!(
            "trying resource_dir/etcli/{}: {:?} exists={}",
            exe_name,
            candidate,
            candidate.exists()
        ));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let mut search = exe.parent().map(PathBuf::from)?;
    for _ in 0..6 {
        for sub in &["etcli", "_up_/etcli", "../etcli"] {
            let candidate = search.join(sub).join(exe_name);
            log_line(&format!(
                "trying walk-up {}: {:?} exists={}",
                sub,
                candidate,
                candidate.exists()
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

fn spawn_etcli_serve(app: &AppHandle) -> Option<Child> {
    let etcli = match locate_etcli_exe(app) {
        Some(p) => p,
        None => {
            log_line("locate_etcli_exe FAILED — no etcli binary found");
            return None;
        }
    };
    log_line(&format!("etcli located: {:?}", etcli));
    let work_dir = etcli.parent()?;

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
    match cmd.spawn() {
        Ok(child) => {
            log_line(&format!("spawn OK pid={}", child.id()));
            Some(child)
        }
        Err(e) => {
            log_line(&format!("spawn err: {}", e));
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServeProcess(Mutex::new(None)))
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
                let app = window.app_handle();
                if let Some(state) = app.try_state::<ServeProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
