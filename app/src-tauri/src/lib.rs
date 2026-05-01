// Murmur 微语 — Tauri shell
//
// Boots the backend in one of two ways:
//   (a) bundled mode — uses the PyInstaller `etcli` binary in
//       Contents/Resources/backend/etcli (production .app). NO Python required.
//   (b) dev mode     — falls back to `python3 cli/etcli.py serve` so HMR works.
// On window close we kill the child so no orphan backend lingers.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct ServeProcess(Mutex<Option<Child>>);

fn find_bundled_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let candidates = [
        // macOS .app: Contents/MacOS/Murmur → Contents/Resources/backend/etcli
        exe_dir.join("../Resources/backend/etcli"),
        // Generic sibling layouts
        exe_dir.join("backend/etcli"),
        exe_dir.join("etcli"),
    ];
    for c in &candidates {
        if c.exists() {
            return Some(c.canonicalize().unwrap_or_else(|_| c.clone()));
        }
    }
    None
}

fn find_dev_etcli_py() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut search = exe.parent().map(PathBuf::from)?;
    for _ in 0..6 {
        let candidate = search.join("cli").join("etcli.py");
        if candidate.exists() {
            return Some(candidate);
        }
        let alt = search.join("..").join("cli").join("etcli.py");
        if alt.exists() {
            return alt.canonicalize().ok();
        }
        match search.parent() {
            Some(p) => search = p.to_path_buf(),
            None => break,
        }
    }
    None
}

fn spawn_serve() -> Option<Child> {
    // Production: bundled PyInstaller binary (no Python on the user's machine needed)
    if let Some(bin) = find_bundled_binary() {
        let mut cmd = Command::new(&bin);
        cmd.arg("serve").arg("--port").arg("9100");
        cmd.env("PYTHONIOENCODING", "utf-8");
        // Pin a stable working dir so the backend can locate user paths reliably
        if let Some(home) = std::env::var_os("HOME") {
            cmd.current_dir(&home);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // Pipe backend logs to ~/Library/Logs/Murmur/backend.log so we can debug
        // launch failures (PyInstaller bootloader errors, port-bind failures, etc.)
        if let Some(home) = std::env::var_os("HOME") {
            let log_dir = std::path::PathBuf::from(&home).join("Library/Logs/Murmur");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join("backend.log");
            if let Ok(f) = std::fs::OpenOptions::new()
                .create(true).append(true).open(&log_path)
            {
                let dup = f.try_clone().ok();
                cmd.stdout(Stdio::from(f));
                if let Some(d) = dup { cmd.stderr(Stdio::from(d)); } else { cmd.stderr(Stdio::null()); }
            } else {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        } else {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
        return cmd.spawn().ok();
    }

    // Dev fallback: launch `python3 cli/etcli.py serve`
    let etcli = find_dev_etcli_py()?;
    let cli_dir = etcli.parent()?;
    let py = if cfg!(target_os = "windows") { "python" } else { "python3" };
    let mut cmd = Command::new(py);
    cmd.current_dir(cli_dir);
    cmd.arg(&etcli).arg("serve").arg("--port").arg("9100");
    cmd.env("PYTHONIOENCODING", "utf-8");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let serve_child = spawn_serve();

    tauri::Builder::default()
        .manage(ServeProcess(Mutex::new(serve_child)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
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
