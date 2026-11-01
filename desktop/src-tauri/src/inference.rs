//! Local models for the Delphi desktop node (Hermes-style "Local Models").
//!
//! - Detects RAM and GPUs so the app can show green / amber / red per model.
//! - Installs the official llama.cpp build: downloads the pinned release archive, checks its sha256, extracts it.
//! - Downloads model files (resumable) and refuses any file whose sha256 differs from the pinned one.
//! - Runs llama-server on 127.0.0.1 only, with an API key, a 64K context and one slot.
//! - Keeps this node's X25519 secret (end-to-end encryption) in the app's data folder.
//!
//! The pins (URLs, sizes, sha256) live in the shared TypeScript catalog (app/lib/inference/catalog.ts); this side
//! enforces them: only allowlisted hosts, exact hashes, sanitized file names.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "huggingface.co",
    "cdn-lfs.huggingface.co",
    "cas-bridge.xethub.hf.co",
    "arweave.net",
];

#[derive(Default)]
pub struct InferState {
    child: Mutex<Option<Child>>,
    running: Mutex<Option<Running>>,
    log: Arc<Mutex<VecDeque<String>>>,
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
pub struct Running {
    port: u16,
    model_file: String,
    started: u64,
}

#[derive(Serialize)]
pub struct Gpu {
    name: String,
    vendor: String,
    #[serde(rename = "vramBytes")]
    vram_bytes: Option<u64>,
}

#[derive(Serialize)]
pub struct Hardware {
    os: String,
    arch: String,
    #[serde(rename = "ramBytes")]
    ram_bytes: u64,
    gpus: Vec<Gpu>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Settings {
    #[serde(rename = "modelDir")]
    model_dir: Option<String>,
    #[serde(rename = "runtimeId")]
    runtime_id: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    port: Option<u16>,
}

#[derive(Deserialize)]
pub struct Asset {
    url: String,
    file: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    done: u64,
    total: u64,
    stage: String,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(err)?.join("inference");
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base_dir(app)?.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    fs::write(settings_path(app)?, serde_json::to_vec_pretty(s).map_err(err)?).map_err(err)
}

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let s = load_settings(app);
    let d = match s.model_dir {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => base_dir(app)?.join("models"),
    };
    fs::create_dir_all(&d).map_err(|e| format!("can't use model folder {}: {e}", d.display()))?;
    Ok(d)
}

fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if ok { Ok(name) } else { Err(format!("bad file name {name}")) }
}

fn check_url(url: &str) -> Result<(), String> {
    let rest = url.strip_prefix("https://").ok_or("only https downloads")?;
    let host = rest.split(['/', ':', '?']).next().unwrap_or("");
    if ALLOWED_HOSTS.contains(&host) { Ok(()) } else { Err(format!("downloads from {host} aren't allowed")) }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex(n: usize) -> Result<String, String> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).map_err(err)?;
    Ok(hex(&b))
}

#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

// ---------------------------------------------------------------- hardware

fn nvidia_gpus() -> Vec<Gpu> {
    let mut cmd = Command::new("nvidia-smi");
    quiet(&mut cmd).args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    let Ok(out) = cmd.output() else { return vec![] };
    if !out.status.success() {
        return vec![];
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (name, mib) = l.rsplit_once(',')?;
            Some(Gpu { name: name.trim().into(), vendor: "nvidia".into(), vram_bytes: mib.trim().parse::<u64>().ok().map(|m| m * 1024 * 1024) })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn other_gpus() -> Vec<Gpu> {
    let mut v = vec![];
    if let Ok(rd) = fs::read_dir("/sys/class/drm") {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("card") || name.contains('-') {
                continue;
            }
            let dev = e.path().join("device");
            let vendor_id = fs::read_to_string(dev.join("vendor")).unwrap_or_default();
            let vendor = match vendor_id.trim() {
                "0x1002" => "amd",
                "0x8086" => "intel",
                _ => continue, // nvidia is covered by nvidia-smi
            };
            let vram = fs::read_to_string(dev.join("mem_info_vram_total")).ok().and_then(|s| s.trim().parse::<u64>().ok());
            v.push(Gpu { name: format!("{} GPU", vendor.to_uppercase()), vendor: vendor.into(), vram_bytes: vram.filter(|b| *b > 512 * 1024 * 1024) });
        }
    }
    v
}

#[cfg(target_os = "windows")]
fn other_gpus() -> Vec<Gpu> {
    let mut cmd = Command::new("powershell");
    quiet(&mut cmd).args(["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }"]);
    let Ok(out) = cmd.output() else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.to_lowercase().contains("nvidia") && !l.to_lowercase().contains("basic display"))
        .map(|name| {
            let lower = name.to_lowercase();
            let vendor = if lower.contains("amd") || lower.contains("radeon") { "amd" } else if lower.contains("intel") { "intel" } else { "other" };
            // Windows doesn't report VRAM above 4 GB reliably; leave it unknown and let the fit check be cautious
            Gpu { name, vendor: vendor.into(), vram_bytes: None }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn other_gpus() -> Vec<Gpu> {
    if cfg!(target_arch = "aarch64") {
        vec![Gpu { name: "Apple GPU (unified memory)".into(), vendor: "apple".into(), vram_bytes: None }]
    } else {
        vec![]
    }
}

#[tauri::command]
pub async fn infer_hardware() -> Result<Hardware, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let mut gpus = if cfg!(target_os = "macos") { vec![] } else { nvidia_gpus() };
        gpus.extend(other_gpus());
        Hardware {
            os: if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" }.into(),
            arch: if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }.into(),
            ram_bytes: sys.total_memory(),
            gpus,
        }
    })
    .await
    .map_err(err)
}

// ---------------------------------------------------------------- settings

#[derive(Serialize)]
pub struct SettingsView {
    #[serde(rename = "modelDir")]
    model_dir: String,
    #[serde(rename = "defaultModelDir")]
    default_model_dir: String,
    #[serde(rename = "runtimeId")]
    runtime_id: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: String,
    port: u16,
}

#[tauri::command]
pub fn infer_settings(app: AppHandle) -> Result<SettingsView, String> {
    let mut s = load_settings(&app);
    if s.api_key.is_none() {
        s.api_key = Some(format!("delphi-{}", random_hex(16)?));
        save_settings(&app, &s)?;
    }
    Ok(SettingsView {
        model_dir: model_dir(&app)?.display().to_string(),
        default_model_dir: base_dir(&app)?.join("models").display().to_string(),
        runtime_id: s.runtime_id.clone(),
        api_key: s.api_key.clone().unwrap_or_default(),
        port: s.port.unwrap_or(8790),
    })
}

#[tauri::command]
pub fn infer_set_model_dir(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    let mut s = load_settings(&app);
    if let Some(d) = dir.as_deref().filter(|d| !d.is_empty()) {
        let p = PathBuf::from(d);
        if !p.is_absolute() {
            return Err("choose a full folder path".into());
        }
        fs::create_dir_all(&p).map_err(|e| format!("can't use {d}: {e}"))?;
        let probe = p.join(".delphi-write-test");
        fs::write(&probe, b"ok").map_err(|e| format!("can't write to {d}: {e}"))?;
        let _ = fs::remove_file(probe);
    }
    s.model_dir = dir.filter(|d| !d.is_empty());
    save_settings(&app, &s)
}

// ---------------------------------------------------------------- downloads

/// Streams `url` into `dest` (resuming a .part file), hashing as it goes. Only a file whose sha256 matches is kept.
async fn download_verified(app: &AppHandle, state: &InferState, id: &str, url: &str, dest: &Path, size: u64, sha256: &str) -> Result<(), String> {
    use futures_util::StreamExt;
    check_url(url)?;
    let want = sha256.to_lowercase();
    if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("bad pinned hash".into());
    }
    let part = dest.with_extension(format!("{}.part", dest.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancel.lock().unwrap().insert(id.to_string(), cancel.clone());

    let mut hasher = Sha256::new();
    let mut have: u64 = 0;
    if let Ok(mut f) = fs::File::open(&part) {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
        if have > size {
            hasher = Sha256::new();
            have = 0;
            let _ = fs::remove_file(&part);
        }
    }

    let client = reqwest::Client::builder().user_agent("delphi-node").build().map_err(err)?;
    let mut req = client.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(err)?;
    let status = resp.status();
    if have > 0 && status.as_u16() != 206 {
        // server ignored the range: start over
        hasher = Sha256::new();
        have = 0;
    }
    if !status.is_success() {
        return Err(format!("download failed: HTTP {status}"));
    }
    let mut out = fs::OpenOptions::new().create(true).write(true).append(have > 0).truncate(have == 0).open(&part).map_err(err)?;
    let mut stream = resp.bytes_stream();
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(err)?;
        out.write_all(&chunk).map_err(|e| format!("can't write the download (disk full?): {e}"))?;
        hasher.update(&chunk);
        have += chunk.len() as u64;
        if have > size {
            return Err("download is larger than the pinned size; stopped".into());
        }
        if last_emit.elapsed().as_millis() > 250 {
            last_emit = std::time::Instant::now();
            let _ = app.emit("infer-progress", Progress { id: id.into(), done: have, total: size, stage: "download".into() });
        }
    }
    out.flush().map_err(err)?;
    drop(out);
    state.cancel.lock().unwrap().remove(id);
    let got = hex(&hasher.finalize());
    if have != size || got != want {
        let _ = fs::remove_file(&part);
        return Err(format!("file didn't match its pinned hash (got {got}); deleted it"));
    }
    fs::rename(&part, dest).map_err(err)?;
    let _ = app.emit("infer-progress", Progress { id: id.into(), done: size, total: size, stage: "verified".into() });
    Ok(())
}

#[tauri::command]
pub fn infer_cancel(state: State<'_, InferState>, id: String) {
    if let Some(c) = state.cancel.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- runtime (llama.cpp)

fn server_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}

fn find_file(dir: &Path, name: &str, depth: u32) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_file() && p.file_name().map(|n| n == name).unwrap_or(false) {
            return Some(p);
        }
        if p.is_dir() && depth > 0 {
            if let Some(f) = find_file(&p, name, depth - 1) {
                return Some(f);
            }
        }
    }
    None
}

fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let name = archive.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".zip") {
        let mut z = zip::ZipArchive::new(fs::File::open(archive).map_err(err)?).map_err(err)?;
        for i in 0..z.len() {
            let mut f = z.by_index(i).map_err(err)?;
            let Some(rel) = f.enclosed_name() else { continue }; // refuses ../ paths
            let out = into.join(rel);
            if f.is_dir() {
                fs::create_dir_all(&out).map_err(err)?;
                continue;
            }
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(err)?;
            }
            let mut w = fs::File::create(&out).map_err(err)?;
            std::io::copy(&mut f, &mut w).map_err(err)?;
            #[cfg(unix)]
            if let Some(mode) = f.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o755));
            }
        }
        Ok(())
    } else if name.ends_with(".tar.gz") {
        let gz = flate2::read::GzDecoder::new(fs::File::open(archive).map_err(err)?);
        let mut t = tar::Archive::new(gz);
        for e in t.entries().map_err(err)? {
            let mut e = e.map_err(err)?;
            e.unpack_in(into).map_err(err)?; // refuses paths outside `into`
        }
        Ok(())
    } else {
        Err("unknown archive type".into())
    }
}

fn runtime_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(base_dir(app)?.join("runtime").join(safe_name(id)?))
}

#[tauri::command]
pub fn infer_runtime_path(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let d = runtime_dir(&app, &id)?;
    if !d.join(".installed").exists() {
        return Ok(None);
    }
    Ok(find_file(&d, server_name(), 3).map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn infer_install_runtime(app: AppHandle, state: State<'_, InferState>, id: String, assets: Vec<Asset>) -> Result<String, String> {
    let dir = runtime_dir(&app, &id)?;
    let tmp = base_dir(&app)?.join("downloads");
    fs::create_dir_all(&tmp).map_err(err)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(err)?;
    }
    fs::create_dir_all(&dir).map_err(err)?;
    for a in &assets {
        let file = safe_name(&a.file)?;
        let archive = tmp.join(file);
        if !archive.exists() {
            download_verified(&app, &state, &format!("runtime:{id}"), &a.url, &archive, a.size, &a.sha256).await?;
        }
        let _ = app.emit("infer-progress", Progress { id: format!("runtime:{id}"), done: a.size, total: a.size, stage: "extract".into() });
        let (archive2, dir2) = (archive.clone(), dir.clone());
        tauri::async_runtime::spawn_blocking(move || extract(&archive2, &dir2)).await.map_err(err)??;
        let _ = fs::remove_file(&archive);
    }
    let server = find_file(&dir, server_name(), 3).ok_or("llama-server wasn't in the download")?;
    fs::write(dir.join(".installed"), b"ok").map_err(err)?;
    let mut s = load_settings(&app);
    s.runtime_id = Some(id);
    save_settings(&app, &s)?;
    Ok(server.display().to_string())
}

// ---------------------------------------------------------------- models

#[derive(Deserialize)]
pub struct ModelFile {
    file: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize)]
pub struct ModelFileStatus {
    file: String,
    ready: bool,
    partial: u64,
}

fn verified_marker(p: &Path) -> PathBuf {
    p.with_extension("gguf.verified")
}

#[tauri::command]
pub fn infer_models_status(app: AppHandle, files: Vec<ModelFile>) -> Result<Vec<ModelFileStatus>, String> {
    let dir = model_dir(&app)?;
    Ok(files
        .into_iter()
        .map(|m| {
            let p = dir.join(&m.file);
            let size_ok = fs::metadata(&p).map(|md| md.len() == m.size).unwrap_or(false);
            let marker = fs::read_to_string(verified_marker(&p)).unwrap_or_default();
            let partial = fs::metadata(p.with_extension("gguf.part")).map(|m| m.len()).unwrap_or(0);
            ModelFileStatus { ready: size_ok && marker.trim() == m.sha256.to_lowercase(), file: m.file, partial }
        })
        .collect())
}

#[tauri::command]
pub async fn infer_download_model(app: AppHandle, state: State<'_, InferState>, id: String, url: String, file: String, size: u64, sha256: String) -> Result<(), String> {
    let dir = model_dir(&app)?;
    let dest = dir.join(safe_name(&file)?);
    if !file.ends_with(".gguf") {
        return Err("models must be .gguf files".into());
    }
    download_verified(&app, &state, &id, &url, &dest, size, &sha256).await?;
    fs::write(verified_marker(&dest), sha256.to_lowercase()).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn infer_delete_model(app: AppHandle, state: State<'_, InferState>, file: String) -> Result<(), String> {
    if state.running.lock().unwrap().as_ref().map(|r| r.model_file == file).unwrap_or(false) {
        return Err("stop the model first".into());
    }
    let p = model_dir(&app)?.join(safe_name(&file)?);
    let _ = fs::remove_file(verified_marker(&p));
    let _ = fs::remove_file(p.with_extension("gguf.part"));
    if p.exists() {
        fs::remove_file(&p).map_err(err)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- llama-server

fn free_port(preferred: u16) -> u16 {
    if std::net::TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(preferred)
}

fn pipe_log<R: Read + Send + 'static>(r: R, log: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            let mut l = log.lock().unwrap();
            if l.len() >= 200 {
                l.pop_front();
            }
            l.push_back(line);
        }
    });
}

#[derive(Serialize)]
pub struct StartInfo {
    port: u16,
    #[serde(rename = "apiKey")]
    api_key: String,
}

#[tauri::command]
pub fn infer_start(app: AppHandle, state: State<'_, InferState>, runtime_id: String, file: String, sha256: String, ctx: u32) -> Result<StartInfo, String> {
    infer_stop(state.clone());
    let server = infer_runtime_path(app.clone(), runtime_id)?.ok_or("install the runtime first")?;
    let model = model_dir(&app)?.join(safe_name(&file)?);
    let marker = fs::read_to_string(verified_marker(&model)).unwrap_or_default();
    if marker.trim() != sha256.to_lowercase() {
        return Err("that model file isn't verified; download it again".into());
    }
    let settings = infer_settings(app.clone())?;
    let port = free_port(settings.port);
    let server_path = PathBuf::from(&server);
    let server_dir = server_path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut cmd = Command::new(&server_path);
    quiet(&mut cmd)
        .current_dir(&server_dir)
        .args(["-m", &model.display().to_string()])
        .args(["-c", &ctx.max(65_536).to_string()]) // Hermes and other agents need 64K
        .args(["-np", "1"]) // one slot, so the whole context belongs to the one request
        .args(["-ngl", "auto"]) // llama.cpp fits as many layers on the GPU as it can
        .arg("--jinja") // model's own chat template: needed for tool calling
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .args(["--api-key", &settings.api_key])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // libraries that ship next to the server (CUDA runtime, ggml backends)
    if cfg!(target_os = "linux") {
        cmd.env("LD_LIBRARY_PATH", &server_dir);
    } else if cfg!(windows) {
        let root = server_dir.ancestors().nth(1).map(Path::to_path_buf).unwrap_or_default();
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{};{};{}", server_dir.display(), root.display(), path));
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start llama-server: {e}"))?;
    state.log.lock().unwrap().clear();
    if let Some(o) = child.stdout.take() {
        pipe_log(o, state.log.clone());
    }
    if let Some(e) = child.stderr.take() {
        pipe_log(e, state.log.clone());
    }
    *state.child.lock().unwrap() = Some(child);
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    *state.running.lock().unwrap() = Some(Running { port, model_file: file, started });
    Ok(StartInfo { port, api_key: settings.api_key })
}

#[tauri::command]
pub fn infer_stop(state: State<'_, InferState>) {
    stop_child(&state);
}

pub fn stop_child(state: &InferState) {
    if let Some(mut c) = state.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    *state.running.lock().unwrap() = None;
}

#[derive(Serialize)]
pub struct Status {
    running: Option<Running>,
    exited: Option<String>,
    log: Vec<String>,
}

#[tauri::command]
pub fn infer_status(state: State<'_, InferState>) -> Status {
    let mut exited = None;
    let mut guard = state.child.lock().unwrap();
    if let Some(c) = guard.as_mut() {
        if let Ok(Some(st)) = c.try_wait() {
            exited = Some(format!("llama-server stopped ({st})"));
            *guard = None;
            *state.running.lock().unwrap() = None;
        }
    }
    drop(guard);
    let log = state.log.lock().unwrap();
    Status { running: state.running.lock().unwrap().clone(), exited, log: log.iter().rev().take(40).rev().cloned().collect() }
}

// ---------------------------------------------------------------- node encryption key

/// This node's X25519 secret for end-to-end encryption. Made once, kept in the app's data folder (owner-only on
/// macOS/Linux), never sent anywhere; only its public half is announced.
#[tauri::command]
pub fn infer_node_secret(app: AppHandle) -> Result<String, String> {
    let p = base_dir(&app)?.join("node-x25519.key");
    if let Ok(s) = fs::read_to_string(&p) {
        let s = s.trim().to_string();
        if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(s);
        }
    }
    let s = random_hex(32)?;
    fs::write(&p, &s).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(s)
}
