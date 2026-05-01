// Murmur 微语 — Tauri shell
//
// On startup we spawn `python etcli.py serve --port 9100` from the bundled `cli/`
// directory. The frontend talks to it via HTTP. On window close we kill the child.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct ServeProcess(Mutex<Option<Child>>);

fn spawn_python_serve() -> Option<Child> {
    // Locate cli/etcli.py — look upward from the executable's dir until we find it.
    let exe = std::env::current_exe().ok()?;
    let mut search = exe.parent().map(PathBuf::from)?;
    let mut etcli: Option<PathBuf> = None;
    for _ in 0..6 {
        let candidate = search.join("cli").join("etcli.py");
        if candidate.exists() {
            etcli = Some(candidate);
            break;
        }
        // Also try a sibling layout (dev mode): app/src-tauri/target/.. → ../../../cli
        let alt = search.join("..").join("cli").join("etcli.py");
        if alt.exists() {
            etcli = Some(alt);
            break;
        }
        match search.parent() {
            Some(p) => search = p.to_path_buf(),
            None => break,
        }
    }
    let etcli = etcli?;
    let cli_dir = etcli.parent()?;

    let py = if cfg!(target_os = "windows") { "python" } else { "python3" };
    let mut cmd = Command::new(py);
    cmd.current_dir(cli_dir);
    cmd.arg(&etcli);
    cmd.arg("serve");
    cmd.arg("--port");
    cmd.arg("9100");
    cmd.env("PYTHONIOENCODING", "utf-8");
    // Hide the console on Windows release builds
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.spawn().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let serve_child = spawn_python_serve();

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
