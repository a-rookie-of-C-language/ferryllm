use std::{
    collections::VecDeque,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_LOG_LINES: usize = 1_000;

struct DesktopState {
    runtime: Mutex<RuntimeState>,
}

#[derive(Default)]
struct RuntimeState {
    child: Option<Child>,
    executable: String,
    config_path: String,
    logs: VecDeque<LogEntry>,
}

#[derive(Debug, Clone, Serialize)]
struct ConfigFile {
    name: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct ConfigDocument {
    path: String,
    raw: String,
    config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct ProcessStatus {
    running: bool,
    executable: String,
    config_path: String,
    pid: Option<u32>,
    logs: Vec<LogEntry>,
}

#[derive(Debug, Clone, Serialize)]
struct CommandResult {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, Serialize)]
struct SaveResult {
    path: String,
    validation: CommandResult,
    reloaded: bool,
}

#[derive(Debug, Clone, Serialize)]
struct LogEntry {
    ts_ms: u128,
    stream: String,
    line: String,
}

#[derive(Debug, Deserialize)]
struct SaveConfigRequest {
    path: String,
    config: serde_json::Value,
    executable: Option<String>,
    hot_reload: bool,
}

#[derive(Debug, Deserialize)]
struct LaunchRequest {
    directory: String,
    listen: String,
    provider_type: String,
    #[serde(default = "default_tool")]
    tool: String,
}

fn default_tool() -> String {
    "codex".into()
}

#[derive(Debug, Deserialize)]
struct SyncConfigRequest {
    config: serde_json::Value,
}

#[tauri::command]
fn write_config_to_default(request: SyncConfigRequest) -> Result<String, String> {
    let dir = dirs::config_dir()
        .ok_or("cannot find config directory")?
        .join("ferryllm");
    fs::create_dir_all(&dir).map_err(string_error)?;
    let path = dir.join("config.toml");
    let toml = toml::to_string_pretty(&request.config).map_err(string_error)?;
    fs::write(&path, toml).map_err(string_error)?;
    Ok(path_to_string(&path))
}

#[tauri::command]
fn save_config_to_default(request: SyncConfigRequest) -> Result<(), String> {
    let dir = dirs::config_dir()
        .ok_or("cannot find config directory")?
        .join("ferryllm");
    fs::create_dir_all(&dir).map_err(string_error)?;
    let path = dir.join("config.json");
    let json = serde_json::to_string_pretty(&request.config).map_err(string_error)?;
    fs::write(&path, json).map_err(string_error)?;
    Ok(())
}

#[tauri::command]
fn load_config_from_default() -> Result<Option<String>, String> {
    let path = dirs::config_dir()
        .ok_or("cannot find config directory")?
        .join("ferryllm")
        .join("config.json");
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(string_error)?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Deserialize)]
struct ServerRequest {
    executable: Option<String>,
    config_path: String,
}

#[tauri::command]
fn launch_cli(request: LaunchRequest) -> Result<(), String> {
    let base_url = format_base_url(&request.listen, &request.provider_type);
    let (key_name, base_name) = env_var_names(&request.provider_type);
    let cli_cmd = if request.tool == "claude" { "claude" } else { "codex" };

    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", cli_cmd])
            .current_dir(&request.directory)
            .env(key_name, "ferryllm")
            .env(base_name, &base_url)
            .spawn()
            .map_err(|e| format!("failed to launch CLI: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("sh")
            .args(["-c", &format!("cd '{}' && {}", request.directory, cli_cmd)])
            .env(key_name, "ferryllm")
            .env(base_name, &base_url)
            .spawn()
            .map_err(|e| format!("failed to launch CLI: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn launch_vscode(request: LaunchRequest) -> Result<(), String> {
    let base_url = format_base_url(&request.listen, &request.provider_type);
    let (key_name, base_name) = env_var_names(&request.provider_type);

    Command::new("code")
        .arg(&request.directory)
        .env(key_name, "ferryllm")
        .env(base_name, &base_url)
        .spawn()
        .map_err(|e| format!("failed to launch VS Code: {}", e))?;
    Ok(())
}

fn format_base_url(listen: &str, provider_type: &str) -> String {
    let host = if listen.starts_with("0.0.0.0") {
        listen.replace("0.0.0.0", "127.0.0.1")
    } else {
        listen.to_string()
    };
    match provider_type {
        "anthropic" => format!("http://{}", host),
        _ => format!("http://{}/v1", host),
    }
}

fn env_var_names(provider_type: &str) -> (&'static str, &'static str) {
    match provider_type {
        "anthropic" => ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"),
        "gemini" => ("GEMINI_API_KEY", "GEMINI_BASE_URL"),
        _ => ("OPENAI_API_KEY", "OPENAI_BASE_URL"),
    }
}

#[tauri::command]
fn list_config_files() -> Result<Vec<ConfigFile>, String> {
    let mut files = Vec::new();
    let examples_dir = repo_root()?.join("examples").join("config");
    if examples_dir.exists() {
        for entry in fs::read_dir(&examples_dir).map_err(string_error)? {
            let entry = entry.map_err(string_error)?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("toml") {
                files.push(ConfigFile {
                    name: path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("config.toml")
                        .to_string(),
                    path: path_to_string(&path),
                });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
fn discover_ferryllm(app: AppHandle) -> Result<String, String> {
    // 1. Check for bundled sidecar in resource directory
    let resource_dir = app.path().resource_dir().map_err(string_error)?;
    let exe_name = if cfg!(windows) { "ferryllm-x86_64-pc-windows-msvc.exe" } else { "ferryllm-x86_64-unknown-linux-gnu" };
    let bundled = resource_dir.join(exe_name);
    if bundled.exists() {
        return Ok(path_to_string(&bundled));
    }

    // 2. Check system PATH
    if let Some(path) = find_in_path("ferryllm") {
        return Ok(path_to_string(&path));
    }

    // 3. Check local target/debug directory (dev mode)
    let exe = if cfg!(windows) { "ferryllm.exe" } else { "ferryllm" };
    let local = repo_root()?.join("target").join("debug").join(exe);
    if local.exists() {
        return Ok(path_to_string(&local));
    }

    Ok("ferryllm".into())
}

#[tauri::command]
fn read_config_file(path: String) -> Result<ConfigDocument, String> {
    let raw = fs::read_to_string(&path).map_err(string_error)?;
    let value: toml::Value = toml::from_str(&raw).map_err(string_error)?;
    let config = serde_json::to_value(value).map_err(string_error)?;
    Ok(ConfigDocument { path, raw, config })
}

#[tauri::command]
fn save_config_file(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: SaveConfigRequest,
) -> Result<SaveResult, String> {
    let toml = toml::to_string_pretty(&request.config).map_err(string_error)?;
    fs::write(&request.path, toml).map_err(string_error)?;

    let executable = normalized_executable(request.executable.as_deref());
    let validation = validate_with(&executable, &request.path);
    let mut reloaded = false;

    if request.hot_reload && validation.ok && is_running(&state) {
        restart_with(&app, &state, executable, request.path.clone())?;
        reloaded = true;
    }

    Ok(SaveResult {
        path: request.path,
        validation,
        reloaded,
    })
}

#[tauri::command]
fn validate_config_file(executable: Option<String>, config_path: String) -> CommandResult {
    validate_with(&normalized_executable(executable.as_deref()), &config_path)
}

#[tauri::command]
fn start_server(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: ServerRequest,
) -> Result<ProcessStatus, String> {
    start_with(
        &app,
        &state,
        normalized_executable(request.executable.as_deref()),
        request.config_path,
    )?;
    status_inner(&state)
}

#[tauri::command]
fn stop_server(state: State<'_, DesktopState>) -> Result<ProcessStatus, String> {
    stop_inner(&state)?;
    status_inner(&state)
}

#[tauri::command]
fn restart_server(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: ServerRequest,
) -> Result<ProcessStatus, String> {
    restart_with(
        &app,
        &state,
        normalized_executable(request.executable.as_deref()),
        request.config_path,
    )?;
    status_inner(&state)
}

#[tauri::command]
fn server_status(state: State<'_, DesktopState>) -> Result<ProcessStatus, String> {
    status_inner(&state)
}

fn start_with(
    app: &AppHandle,
    state: &State<'_, DesktopState>,
    executable: String,
    config_path: String,
) -> Result<(), String> {
    let mut runtime = state.runtime.lock().map_err(lock_error)?;
    reap_if_exited(&mut runtime);
    if runtime.child.is_some() {
        return Err("ferryllm is already running".into());
    }

    let mut child = Command::new(&executable)
        .arg("serve")
        .arg("--config")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to start '{}': {}", executable, err))?;

    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(app.clone(), "stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(app.clone(), "stderr", stderr);
    }

    push_log(
        &mut runtime,
        "system",
        format!("started ferryllm with config {}", config_path),
    );
    runtime.executable = executable;
    runtime.config_path = config_path;
    runtime.child = Some(child);
    Ok(())
}

fn stop_inner(state: &State<'_, DesktopState>) -> Result<(), String> {
    let mut runtime = state.runtime.lock().map_err(lock_error)?;
    if let Some(mut child) = runtime.child.take() {
        let _ = child.kill();
        let _ = child.wait();
        push_log(&mut runtime, "system", "stopped ferryllm");
    }
    Ok(())
}

fn restart_with(
    app: &AppHandle,
    state: &State<'_, DesktopState>,
    executable: String,
    config_path: String,
) -> Result<(), String> {
    stop_inner(state)?;
    start_with(app, state, executable, config_path)
}

fn status_inner(state: &State<'_, DesktopState>) -> Result<ProcessStatus, String> {
    let mut runtime = state.runtime.lock().map_err(lock_error)?;
    reap_if_exited(&mut runtime);
    let pid = runtime.child.as_ref().map(Child::id);
    Ok(ProcessStatus {
        running: runtime.child.is_some(),
        executable: runtime.executable.clone(),
        config_path: runtime.config_path.clone(),
        pid,
        logs: runtime.logs.iter().cloned().collect(),
    })
}

fn validate_with(executable: &str, config_path: &str) -> CommandResult {
    match Command::new(executable)
        .arg("check-config")
        .arg("--config")
        .arg(config_path)
        .output()
    {
        Ok(output) => CommandResult {
            ok: output.status.success(),
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(err) => CommandResult {
            ok: false,
            code: None,
            stdout: String::new(),
            stderr: format!("failed to run '{}': {}", executable, err),
        },
    }
}

fn is_running(state: &State<'_, DesktopState>) -> bool {
    state
        .runtime
        .lock()
        .map(|mut runtime| {
            reap_if_exited(&mut runtime);
            runtime.child.is_some()
        })
        .unwrap_or(false)
}

fn spawn_log_reader<R>(app: AppHandle, stream: &'static str, reader: R)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            let entry = LogEntry {
                ts_ms: unix_ms(),
                stream: stream.to_string(),
                line,
            };
            if let Some(state) = app.try_state::<DesktopState>() {
                if let Ok(mut runtime) = state.runtime.lock() {
                    push_entry(&mut runtime, entry.clone());
                }
            }
            let _ = app.emit("server-log", entry);
        }
    });
}

fn push_log(runtime: &mut RuntimeState, stream: &str, line: impl Into<String>) {
    push_entry(
        runtime,
        LogEntry {
            ts_ms: unix_ms(),
            stream: stream.to_string(),
            line: line.into(),
        },
    );
}

fn push_entry(runtime: &mut RuntimeState, entry: LogEntry) {
    if runtime.logs.len() >= MAX_LOG_LINES {
        runtime.logs.pop_front();
    }
    runtime.logs.push_back(entry);
}

fn reap_if_exited(runtime: &mut RuntimeState) {
    if let Some(child) = runtime.child.as_mut() {
        if matches!(child.try_wait(), Ok(Some(_))) {
            runtime.child = None;
        }
    }
}

fn normalized_executable(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("ferryllm")
        .to_string()
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    let candidates = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };

    for dir in env::split_paths(&paths) {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn repo_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve repository root".to_string())
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "desktop state lock is poisoned".into()
}

fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState {
            runtime: Mutex::new(RuntimeState::default()),
        })
        .invoke_handler(tauri::generate_handler![
            list_config_files,
            discover_ferryllm,
            read_config_file,
            save_config_file,
            validate_config_file,
            start_server,
            stop_server,
            restart_server,
            server_status,
            launch_cli,
            launch_vscode,
            write_config_to_default,
            save_config_to_default,
            load_config_from_default
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
