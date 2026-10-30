use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

use crate::project_storage::resolve_project_storage;

pub(crate) const MAX_CONCURRENT_COMPILATIONS: usize = 3;

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning TeXLive/Tectonic child processes from the GUI app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String,
}

#[derive(Clone)]
pub struct LatexCompilerState {
    last_builds: Arc<Mutex<HashMap<String, BuildInfo>>>,
    /// Per-project locks to prevent concurrent compilations on the same build directory.
    project_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    semaphore: Arc<Semaphore>,
}

impl Default for LatexCompilerState {
    fn default() -> Self {
        Self {
            last_builds: Arc::new(Mutex::new(HashMap::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_COMPILATIONS)),
        }
    }
}

#[derive(serde::Serialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

#[derive(serde::Serialize)]
pub struct SynctexViewResult {
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

pub use crate::compile_diagnostics::CompileDiagnostic;
use crate::compile_diagnostics::{extract_compile_diagnostics, project_locations};

pub struct CompiledLatex {
    pub actual_engine: Option<&'static str>,
    pub pdf_bytes: Vec<u8>,
    pub diagnostics: Vec<CompileDiagnostic>,
}

#[derive(Debug, serde::Serialize)]
pub struct CompileFailure {
    pub actual_engine: Option<&'static str>,
    pub message: String,
    pub diagnostics: Vec<CompileDiagnostic>,
}

impl From<String> for CompileFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            diagnostics: Vec::new(),
            actual_engine: None,
        }
    }
}

// --- Helpers ---

fn extract_error_lines(log: &str) -> String {
    if log.is_empty() {
        return String::new();
    }

    let lines: Vec<&str> = log.lines().collect();

    let mut blocks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() && blocks.len() < 5 {
        let line = lines[i];
        let is_error_start =
            line.starts_with('!') || line.contains("Error:") || line.contains("error:");

        if is_error_start {
            let end = (i + 14).min(lines.len());
            blocks.push(lines[i..end].join("\n"));
            i = end;
            continue;
        }

        i += 1;
    }

    if !blocks.is_empty() {
        let mut result = blocks.join("\n\n");
        result.push_str("\n\n---- Engine output ----\n");
        let tail_start = lines.len().saturating_sub(20);
        result.push_str(&lines[tail_start..].join("\n"));
        return result;
    }

    if lines.iter().any(|l| l.contains("No pages of output")) {
        return "No pages of output. Add visible content to the document body.".to_string();
    }

    // Fallback: return tail of log
    let start = log.len().saturating_sub(500);
    log[start..].to_string()
}

/// Check if the log contains real TeX errors (! lines or Error: messages).
fn has_real_errors(log: &str) -> bool {
    log.lines()
        .any(|l| l.starts_with('!') || l.contains("Error:"))
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TexEngine {
    #[serde(rename = "pdflatex", alias = "latex")]
    Latex,
    XeLaTeX,
    LuaLaTeX,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompilerBackend {
    Tectonic,
    Latexmk,
}

/// Detect TeX engine from `% !TEX program = <engine>` magic comment in the first 20 lines.
fn detect_tex_engine(content: &str) -> Option<TexEngine> {
    for line in content.lines().take(20) {
        let normalized = line.trim().to_ascii_lowercase();
        if let Some(rest) = normalized.strip_prefix('%') {
            let rest = rest.trim();
            if let Some(rest) = rest.strip_prefix("!tex") {
                let rest = rest.trim();
                if let Some(rest) = rest.strip_prefix("program") {
                    let rest = rest.trim();
                    if let Some(rest) = rest.strip_prefix('=') {
                        let engine = rest.trim().to_lowercase();
                        return match engine.as_str() {
                            "xelatex" => Some(TexEngine::XeLaTeX),
                            "lualatex" => Some(TexEngine::LuaLaTeX),
                            "pdflatex" | "latex" => Some(TexEngine::Latex),
                            _ => None,
                        };
                    }
                }
            }
        }
    }
    None
}

fn resolve_latexmk_engine(
    detected_engine: Option<TexEngine>,
    preferred_engine: Option<TexEngine>,
) -> TexEngine {
    preferred_engine
        .or(detected_engine)
        .unwrap_or(TexEngine::Latex)
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, PartialEq)]
enum BibTool {
    Biber,
    BibTeX,
    None,
}

/// Detect which bibliography tool is needed by scanning .tex content.
#[cfg_attr(not(test), allow(dead_code))]
fn detect_bib_tool(content: &str) -> BibTool {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\usepackage") && trimmed.contains("biblatex") {
            return BibTool::Biber;
        }
    }
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\bibliography{") || trimmed.contains("\\addbibresource{") {
            return BibTool::BibTeX;
        }
    }
    BibTool::None
}

/// Resolve a TeXLive engine binary to its full path.
/// GUI apps on macOS lack the user's shell PATH, so we check standard
/// TeXLive installation locations and fall back to a login-shell query.
fn find_texlive_binary(name: &str) -> Result<PathBuf, String> {
    // 1. Try PATH (works when launched from terminal)
    if let Ok(path) = which::which(name) {
        return Ok(path);
    }

    // 2. Check standard TeXLive locations
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = [
            format!("/Library/TeX/texbin/{}", name),
            format!("/usr/local/texlive/2025/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2024/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2025/bin/x86_64-linux/{}", name),
            format!("/usr/local/texlive/2024/bin/x86_64-linux/{}", name),
            format!("/opt/homebrew/bin/{}", name),
            format!("/usr/bin/{}", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let standard_paths = [
            format!("C:\\texlive\\2025\\bin\\windows\\{}.exe", name),
            format!("C:\\texlive\\2024\\bin\\windows\\{}.exe", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // 3. macOS: ask login shell for PATH
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &format!("which {}", name)])
            .output()
        {
            if output.status.success() {
                let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let p = PathBuf::from(&resolved);
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }

    Err(format!(
        "{} not found. Install TeXLive or add it to your PATH.",
        name
    ))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    copy_dir_recursive_inner(src, dst, true)
}

fn copy_dir_recursive_inner(src: &Path, dst: &Path, is_project_root: bool) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            // Skip hidden directories (.git, legacy .catalex, etc.)
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            copy_dir_recursive_inner(&src_path, &dst_path, false)?;
        } else {
            if is_project_root && crate::comments::is_sidecar(&entry.file_name().to_string_lossy())
            {
                continue;
            }
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Sync only source files (.tex, .bib, .sty, .cls, .bst, images, .pdf figures) from project to build dir.
/// Skips build artifacts (.aux, .log, .toc, .synctex.gz, etc.) to preserve them.
/// Note: .pdf is NOT skipped — figure PDFs must be synced. The output PDF is managed by compile_latex.
fn sync_source_files(src: &Path, dst: &Path) -> std::io::Result<()> {
    sync_source_files_inner(src, dst, true)
}

fn sync_source_files_inner(src: &Path, dst: &Path, is_project_root: bool) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        if src_path.is_dir() {
            let name = file_name.to_string_lossy();
            if name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target" | "dist")
            {
                continue;
            }
            sync_source_files_inner(&src_path, &dst_path, false)?;
        } else {
            if is_project_root && crate::comments::is_sidecar(&file_name.to_string_lossy()) {
                continue;
            }
            let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let is_artifact = matches!(
                ext,
                "aux"
                    | "log"
                    | "toc"
                    | "lof"
                    | "lot"
                    | "out"
                    | "nav"
                    | "snm"
                    | "vrb"
                    | "bbl"
                    | "blg"
                    | "fls"
                    | "fdb_latexmk"
                    | "synctex"
                    | "idx"
                    | "ind"
                    | "ilg"
                    | "glo"
                    | "gls"
                    | "glg"
                    | "fmt"
                    | "xdv"
            );
            let is_synctex = src_path.to_string_lossy().ends_with(".synctex.gz");
            if !is_artifact && !is_synctex {
                // Cloud storage (Dropbox/iCloud) may keep files as online-only
                // placeholders with 0 bytes. Reading the file forces a download.
                let metadata = std::fs::metadata(&src_path)?;

                if metadata.len() > 0 {
                    if let Ok(dst_meta) = std::fs::metadata(&dst_path) {
                        if metadata.len() == dst_meta.len() {
                            if let (Ok(src_m), Ok(dst_m)) =
                                (metadata.modified(), dst_meta.modified())
                            {
                                if src_m == dst_m {
                                    continue;
                                }
                            }
                        }
                    }
                }

                if metadata.len() == 0 {
                    // Attempt to materialize the file by reading it
                    let data = std::fs::read(&src_path)?;
                    if !data.is_empty() {
                        std::fs::write(&dst_path, &data)?;
                    } else {
                        std::fs::copy(&src_path, &dst_path)?;
                    }
                } else {
                    std::fs::copy(&src_path, &dst_path)?;
                }
            }
        }
    }
    Ok(())
}

/// Persistent, rebuildable output under Catalex's per-project app cache.
fn persistent_build_dir(project_cache_dir: &Path) -> PathBuf {
    project_cache_dir.join("latex-build")
}

// --- Thread priority ---

/// Lower the current thread's scheduling priority so CPU-heavy compilation
/// does not starve the WebView's main thread (and thus the UI / typing).
fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        // QOS_CLASS_UTILITY (0x11) — lower than default, appropriate for long-running work.
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        unsafe { pthread_set_qos_class_self_np(0x11, 0) };
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        extern "C" {
            fn nice(inc: i32) -> i32;
        }
        unsafe { nice(10) };
    }
}

// --- Tectonic Compilation ---

pub(crate) fn compile_with_tectonic(work_dir: &Path, main_file: &str) -> Result<(), String> {
    use tectonic::config::PersistentConfig;
    use tectonic::driver::{OutputFormat, PassSetting, ProcessingSessionBuilder};
    use tectonic::status::NoopStatusBackend;

    let mut status = NoopStatusBackend {};

    let config = PersistentConfig::open(false)
        .map_err(|e| format!("Failed to open tectonic config: {}", e))?;

    let bundle = config.default_bundle(false, &mut status).map_err(|e| {
        format!(
            "Failed to load tectonic bundle (check network connection): {}",
            e
        )
    })?;

    let format_cache = config
        .format_cache_path()
        .map_err(|e| format!("Failed to get format cache path: {}", e))?;

    let mut builder = ProcessingSessionBuilder::default();
    builder
        .bundle(bundle)
        .primary_input_path(work_dir.join(main_file))
        .tex_input_name(main_file)
        .filesystem_root(work_dir)
        .output_dir(work_dir)
        .format_name("latex")
        .format_cache_path(format_cache)
        .output_format(OutputFormat::Pdf)
        .pass(PassSetting::Default)
        .synctex(true)
        .keep_intermediates(true)
        .keep_logs(true);

    let mut session = builder
        .create(&mut status)
        .map_err(|e| format!("Failed to create tectonic session: {}", e))?;

    session.run(&mut status).map_err(|e| format!("{}", e))?;

    Ok(())
}

/// Run tectonic compilation in an isolated subprocess.
///
/// This avoids the font cache assertion failure (`font_cache.fonts == NULL`)
/// that occurs when tectonic is called multiple times in the same process.
/// The C-level static `font_cache` in `dpx-pdffont.c` is not cleaned up
/// on compilation failure, causing subsequent calls to abort.
///
/// By spawning a subprocess, each compilation gets a fresh process with
/// clean global state, and cleanup happens automatically on process exit.
fn compile_with_tectonic_subprocess(work_dir: &Path, main_file: &str, actual_engine: &mut Option<&'static str>) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {}", e))?;

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["--tectonic-compile", &work_dir.to_string_lossy(), main_file])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to spawn tectonic subprocess: {}", e))?;

    *actual_engine = Some("xetex");
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().to_string())
    }
}

// --- MacTeX / latexmk Compilation ---

/// Build a PATH that includes the TeX toolchain bin directory.
/// GUI apps on macOS have a minimal PATH that doesn't include MacTeX.
fn toolchain_env_path(binary: &Path) -> String {
    let texbin = binary
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let current_path = std::env::var("PATH").unwrap_or_default();
    if current_path.contains(&texbin) {
        current_path
    } else {
        #[cfg(target_os = "windows")]
        {
            format!("{};{}", texbin, current_path)
        }
        #[cfg(not(target_os = "windows"))]
        {
            format!("{}:{}", texbin, current_path)
        }
    }
}

fn compile_with_latexmk(
    work_dir: &Path,
    main_file: &str,
    engine: TexEngine,
    installation: Option<String>,
    actual_engine: &mut Option<&'static str>,
) -> Result<(), String> {
    let latexmk = if let Some(dir) = installation {
        let engine_name = match engine {
            TexEngine::LuaLaTeX => "lualatex",
            TexEngine::Latex => "pdflatex",
            TexEngine::XeLaTeX => "xelatex",
        };
        let dir = PathBuf::from(dir);
        if !binary_in(&dir, engine_name).is_file() {
            return Err(format!("Selected installation is missing {engine_name}"));
        }
        let path = binary_in(&dir, "latexmk");
        if !path.is_file() {
            return Err("Selected installation is missing latexmk".into());
        }
        path
    } else {
        find_texlive_binary("latexmk")?
    };
    let engine_flag = match engine {
        TexEngine::XeLaTeX => "-pdfxe",
        TexEngine::Latex => "-pdf",
        TexEngine::LuaLaTeX => "-pdflua",
    };

    let mut cmd = std::process::Command::new(&latexmk);
    cmd.args([
        engine_flag,
        "-g",
        "-f",
        "-file-line-error",
        "-interaction=nonstopmode",
        "-synctex=1",
        "-outdir=.",
    ])
    .arg(main_file)
    .current_dir(work_dir)
    .env("PATH", toolchain_env_path(&latexmk))
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to launch latexmk: {}", e))?;

    *actual_engine = Some(match engine {
        TexEngine::Latex => "pdflatex",
        TexEngine::XeLaTeX => "xelatex",
        TexEngine::LuaLaTeX => "lualatex",
    });
    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut message = String::new();
    if !stdout.trim().is_empty() {
        message.push_str(stdout.trim());
    }
    if !stderr.trim().is_empty() {
        if !message.is_empty() {
            message.push('\n');
        }
        message.push_str(stderr.trim());
    }

    if message.is_empty() {
        Err("latexmk failed".to_string())
    } else {
        Err(message)
    }
}

/// Retry only errors that identify pdfTeX incompatibility, not general TeX failures.
/// Reading the root log also catches errors in included files and package loads.
fn needs_unicode_engine(message: &str) -> bool {
    let message = message.to_lowercase();
    (message.contains("unicode character") && message.contains("not set up for use with latex"))
        || (message.contains("fontspec") && message.contains("requires either xetex") && message.contains("luatex"))
        || (message.contains("xecjk") && message.contains("requires xetex"))
        || (message.contains("ctex fontset") && message.contains("is unavailable") && message.contains("mode"))
}

fn compile_latexmk_auto(
    work_dir: &Path,
    main_file: &str,
    detected: Option<TexEngine>,
    preferred: Option<TexEngine>,
    installation: Option<String>,
    actual_engine: &mut Option<&'static str>,
) -> (Result<(), String>, TexEngine) {
    let engine = resolve_latexmk_engine(detected, preferred);
    let result = compile_with_latexmk(work_dir, main_file, engine, installation.clone(), actual_engine);
    if detected.is_some() || preferred.is_some() || result.is_ok() {
        return (result, engine);
    }
    let stem = Path::new(main_file).file_stem().unwrap_or_default().to_string_lossy();
    let log_path = work_dir.join(format!("{stem}.log"));
    let log = std::fs::read_to_string(&log_path).unwrap_or_default();
    let error = result.as_ref().err().map(String::as_str).unwrap_or_default();
    if !needs_unicode_engine(&format!("{error}\n{log}")) {
        return (result, engine);
    }
    // Do not expose a partial pdfTeX PDF or stale diagnostics if the retry fails.
    let _ = std::fs::remove_file(work_dir.join(format!("{stem}.pdf")));
    let _ = std::fs::remove_file(log_path);
    eprintln!("[latex] Auto: pdfLaTeX requires Unicode support; retrying with XeLaTeX");
    (
        compile_with_latexmk(work_dir, main_file, TexEngine::XeLaTeX, installation, actual_engine),
        TexEngine::XeLaTeX,
    )
}

// --- SyncTeX Native Parser ---

struct SynctexNode {
    tag: u32,
    line: u32,
    h: f64, // PDF points
    v: f64, // PDF points
}

/// Parse synctex data and find the source location closest to (target_x, target_y) on target_page.
#[cfg(test)]
fn parse_synctex_data(
    data: &str,
    target_page: u32,
    target_x: f64,
    target_y: f64,
) -> Option<(String, u32, u32)> {
    parse_synctex_reader(std::io::Cursor::new(data), target_page, target_x, target_y)
        .expect("Reading an in-memory SyncTeX string cannot fail")
}

/// Inverse lookup needs one page, not a complete decompressed document or a
/// vector of every node on that page. Reuse the line buffer and retain only the
/// nearest node. This also avoids large allocator high-water marks when outline
/// tracking makes repeated lookups in a long document.
fn parse_synctex_reader(
    mut reader: impl BufRead,
    target_page: u32,
    target_x: f64,
    target_y: f64,
) -> std::io::Result<Option<(String, u32, u32)>> {
    let mut inputs: HashMap<u32, String> = HashMap::new();
    let mut magnification: f64 = 1000.0;
    let mut unit: f64 = 1.0;
    let mut x_offset: f64 = 0.0;
    let mut y_offset: f64 = 0.0;

    let mut in_content = false;
    let mut on_target_page = false;
    let mut closest: Option<SynctexNode> = None;
    let mut best_distance = f64::MAX;
    let mut buffer = String::new();

    loop {
        buffer.clear();
        if reader.read_line(&mut buffer)? == 0 {
            break;
        }
        let line = buffer.trim();
        if line.is_empty() {
            continue;
        }

        // TeX introduces included files between pages as it opens them, not
        // only in the header. Their tags must be available to later pages.
        if let Some(rest) = line.strip_prefix("Input:") {
            if let Some(colon_pos) = rest.find(':') {
                if let Ok(tag) = rest[..colon_pos].parse::<u32>() {
                    inputs.insert(tag, rest[colon_pos + 1..].to_string());
                }
            }
            continue;
        }

        if !in_content {
            if let Some(rest) = line.strip_prefix("Magnification:") {
                magnification = rest.trim().parse().unwrap_or(1000.0);
            } else if let Some(rest) = line.strip_prefix("Unit:") {
                unit = rest.trim().parse().unwrap_or(1.0);
            } else if let Some(rest) = line.strip_prefix("X Offset:") {
                x_offset = rest.trim().parse().unwrap_or(0.0);
            } else if let Some(rest) = line.strip_prefix("Y Offset:") {
                y_offset = rest.trim().parse().unwrap_or(0.0);
            } else if line == "Content:" {
                in_content = true;
            }
            continue;
        }

        // Content section
        if line.starts_with("Postamble:") {
            break;
        }

        let first_byte = match line.as_bytes().first() {
            Some(b) => *b,
            None => continue,
        };
        match first_byte {
            b'{' => {
                let page: u32 = line.get(1..).and_then(|s| s.parse().ok()).unwrap_or(0);
                on_target_page = page == target_page;
            }
            b'}' => {
                if on_target_page {
                    break;
                }
                on_target_page = false;
            }
            // Box/node records: [, (, h, v, k, x, g, $
            b'[' | b'(' | b'h' | b'v' | b'k' | b'x' | b'g' | b'$' if on_target_page => {
                // Convert synctex internal units to PDF points (bp)
                // 1 TeX pt = 65536 sp; 1 inch = 72.27 TeX pt = 72 PDF bp
                let factor = unit * magnification / (1000.0 * 65536.0) * 72.0 / 72.27;
                let x_offset_bp = x_offset * factor;
                let y_offset_bp = y_offset * factor;
                if let Some(node) = line
                    .get(1..)
                    .and_then(|s| parse_synctex_node(s, factor, x_offset_bp, y_offset_bp))
                {
                    let dx = node.h - target_x;
                    let dy = node.v - target_y;
                    let distance = dx * dx + dy * dy;
                    if closest.is_none() || distance < best_distance {
                        closest = Some(node);
                    }
                    if distance < best_distance {
                        best_distance = distance;
                    }
                }
            }
            _ => {}
        }
    }

    Ok(closest.and_then(|node| {
        inputs
            .get(&node.tag)
            .map(|file| (file.clone(), node.line, 0))
    }))
}

/// Parse a synctex node record (after stripping the type character).
/// Format: `<tag>,<line>,<column>:<h>,<v>[:<W>,<H>,<D>]`
fn parse_synctex_node(s: &str, factor: f64, x_offset: f64, y_offset: f64) -> Option<SynctexNode> {
    let colon_parts: Vec<&str> = s.splitn(4, ':').collect();
    if colon_parts.len() < 2 {
        return None;
    }

    // Parse tag and line (ignore column)
    let first_part = colon_parts.first()?;
    let tlc: Vec<&str> = first_part.splitn(3, ',').collect();
    if tlc.len() < 2 {
        return None;
    }
    let tag: u32 = tlc.first()?.parse().ok()?;
    let line: u32 = tlc.get(1)?.parse().ok()?;

    // Parse h, v coordinates
    let second_part = colon_parts.get(1)?;
    let hv: Vec<&str> = second_part.splitn(2, ',').collect();
    if hv.len() < 2 {
        return None;
    }
    let h_raw: i64 = hv.first()?.parse().ok()?;
    let v_raw: i64 = hv.get(1)?.parse().ok()?;

    let h = h_raw as f64 * factor + x_offset;
    let v = v_raw as f64 * factor + y_offset;

    Some(SynctexNode { tag, line, h, v })
}

// --- Tauri Commands ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexliveStatus {
    pub installations: Vec<LatexInstallation>,
    pub available: bool,
    pub engines: Vec<String>,
    pub latexmk_available: bool,
    pub binary_paths: std::collections::BTreeMap<String, String>,
    pub version: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LatexInstallation {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub engines: Vec<String>,
    pub binary_paths: std::collections::BTreeMap<String, String>,
    pub available: bool,
}

fn binary_in(dir: &Path, name: &str) -> PathBuf {
    dir.join(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    })
}

fn discover_installations() -> Vec<LatexInstallation> {
    let mut dirs = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&paths));
    }
    for name in ["latexmk", "pdflatex", "xelatex", "lualatex"] {
        if let Ok(path) = find_texlive_binary(name) {
            if let Some(parent) = path.parent() {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    dirs.push(PathBuf::from("/Library/TeX/texbin"));
    for root in ["/usr/local/texlive", "C:\\texlive"] {
        if let Ok(years) = std::fs::read_dir(root) {
            for year in years.flatten() {
                if let Ok(bins) = std::fs::read_dir(year.path().join("bin")) {
                    dirs.extend(bins.flatten().map(|entry| entry.path()));
                }
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join("bin"));
        dirs.push(home.join("Library/Application Support/MiKTeX/texmfs/install/miktex/bin"));
        dirs.push(home.join(".miktex/texmfs/install/miktex/bin"));
    }
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(key) {
            for suffix in ["MiKTeX/miktex/bin/x64", "Programs/MiKTeX/miktex/bin/x64"] {
                dirs.push(PathBuf::from(&base).join(suffix));
            }
        }
    }
    #[cfg(target_os = "macos")]
    let receipts = std::process::Command::new("/usr/sbin/pkgutil")
        .arg("--pkgs")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut installations = Vec::new();
    for dir in dirs {
        let mut paths = std::collections::BTreeMap::new();
        for name in ["latexmk", "pdflatex", "xelatex", "lualatex"] {
            let path = binary_in(&dir, name);
            if path.is_file() {
                paths.insert(name.to_string(), path.to_string_lossy().into_owned());
            }
        }
        let engines: Vec<String> = ["pdflatex", "xelatex", "lualatex"]
            .iter()
            .filter(|name| paths.contains_key(**name))
            .map(|name| name.to_string())
            .collect();
        if engines.is_empty() {
            continue;
        }
        let probe = PathBuf::from(&paths[&engines[0]]);
        let identity = std::fs::canonicalize(&probe).unwrap_or(probe.clone());
        if !seen.insert(identity) {
            continue;
        }
        let mut cmd = std::process::Command::new(&probe);
        cmd.arg("--version");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let version = cmd
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .map(str::to_string)
            });
        let mut name = if version
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("miktex")
        {
            "MiKTeX"
        } else if version.as_deref().unwrap_or("").contains("TeX Live") {
            "TeX Live"
        } else {
            "Local LaTeX"
        };
        #[cfg(target_os = "macos")]
        if name == "TeX Live" {
            let resolved = std::fs::canonicalize(&probe)
                .unwrap_or(probe.clone())
                .to_string_lossy()
                .into_owned();
            for receipt in receipts
                .lines()
                .filter(|r| r.starts_with("org.tug.mactex."))
            {
                let year: String = receipt
                    .chars()
                    .rev()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                if !year.is_empty()
                    && resolved.contains(&format!("/{year}/"))
                    && receipt.contains("texlive")
                {
                    name = "MacTeX";
                }
                if !year.is_empty()
                    && resolved.contains(&format!("/{year}basic/"))
                    && receipt.contains("basic")
                {
                    name = "BasicTeX";
                }
            }
        }
        installations.push(LatexInstallation {
            id: dir.to_string_lossy().into_owned(),
            name: name.into(),
            version,
            available: paths.contains_key("latexmk"),
            engines,
            binary_paths: paths,
        });
    }
    installations
}

pub fn detect_texlive() -> TexliveStatus {
    let installations = discover_installations();
    let chosen = installations
        .iter()
        .find(|i| i.available)
        .or(installations.first());
    TexliveStatus {
        available: chosen.is_some_and(|i| i.available),
        engines: chosen.map(|i| i.engines.clone()).unwrap_or_default(),
        latexmk_available: chosen.is_some_and(|i| i.binary_paths.contains_key("latexmk")),
        version: chosen.and_then(|i| i.version.clone()),
        binary_paths: chosen.map(|i| i.binary_paths.clone()).unwrap_or_default(),
        installations,
    }
}

pub async fn compile_latex(
    window: crate::host::WindowContext,
    state: &LatexCompilerState,
    project_dir: String,
    main_file: String,
    backend: Option<CompilerBackend>,
    engine: Option<TexEngine>,
    diagnostics: u64,
    installation: Option<String>,
    snapshot_path: Option<String>,
) -> Result<Vec<u8>, CompileFailure> {
    // The RPC can be cancelled when its window closes, but spawn_blocking
    // compiler work cannot. Keep the backend future (and its project lock)
    // alive until the process finishes, as the workspace MCP already does.
    let app = window.service.clone();
    let state = state.clone();
    let operation = tokio::spawn(async move {
        compile_latex_selected(
            &app,
            &state,
            project_dir,
            main_file,
            backend,
            engine,
            installation,
            snapshot_path,
        )
        .await
    });
    let result = operation
        .await
        .map_err(|error| format!("Compilation task failed: {error}"))??;
    window
        .emit(&format!("__channel:{diagnostics}"), result.diagnostics)
        .map_err(|error| error.to_string())?;
    Ok(result.pdf_bytes)
}

pub async fn compile_latex_bytes(
    app: &crate::host::ServiceContext,
    state: &LatexCompilerState,
    project_dir: String,
    main_file: String,
    backend: Option<CompilerBackend>,
    engine: Option<TexEngine>,
) -> Result<CompiledLatex, CompileFailure> {
    compile_latex_selected(app, state, project_dir, main_file, backend, engine, None, None).await
}

async fn compile_latex_selected(
    app: &crate::host::ServiceContext,
    state: &LatexCompilerState,
    project_dir: String,
    main_file: String,
    backend: Option<CompilerBackend>,
    engine: Option<TexEngine>,
    installation: Option<String>,
    snapshot_path: Option<String>,
) -> Result<CompiledLatex, CompileFailure> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Server busy, too many concurrent compilations".to_string())?;

    let _storage_guard = crate::project_storage::COMPILATION_STORAGE_GATE.read().await;
    let storage = resolve_project_storage(&app, &project_dir)?;

    // Acquire per-project lock to prevent concurrent compilations on the same build dir.
    let project_lock = {
        let mut locks = state.project_locks.lock().await;
        locks
            .entry(storage.project_id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _project_guard = project_lock.lock().await;

    let t0 = std::time::Instant::now();
    let backend = backend.unwrap_or(CompilerBackend::Latexmk);

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Set up build directory (offload blocking I/O to avoid starving the async runtime)
    let work_dir = persistent_build_dir(&storage.cache_dir);
    let is_reuse = work_dir.exists();

    {
        let work_dir = work_dir.clone();
        let project_dir = project_dir.clone();
        tokio::task::spawn_blocking(move || {
            if is_reuse {
                sync_source_files(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to sync project: {}", e))
            } else {
                std::fs::create_dir_all(&work_dir)
                    .map_err(|e| format!("Failed to create build dir: {}", e))?;
                copy_dir_recursive(Path::new(&project_dir), &work_dir)
                    .map_err(|e| format!("Failed to copy project: {}", e))
            }
        })
        .await
        .map_err(|e| format!("File sync task panicked: {}", e))??;
    }

    eprintln!(
        "[latex] +{:.0}ms {} ({}, backend={})",
        t0.elapsed().as_millis(),
        if is_reuse {
            "sync source files"
        } else {
            "full copy"
        },
        if is_reuse { "reuse" } else { "first build" },
        match backend {
            CompilerBackend::Latexmk => "latexmk",
            CompilerBackend::Tectonic => "tectonic",
        }
    );

    // Remove stale PDF so a failed compile doesn't return the previous result.
    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));
    let _ = std::fs::remove_file(&pdf_path);
    // Clear the previous root log so diagnostics cannot come from an older run.
    let log_path = work_dir.join(format!("{}.log", main_file_name));
    let _ = std::fs::remove_file(&log_path);

    // Verify the main TeX file exists before attempting compilation
    let main_tex_path = work_dir.join(&main_file);
    if !main_tex_path.exists() {
        return Err(format!(
            "Compilation failed\n\nNo .tex file found: \"{}\". Create a document.tex or main.tex file to compile.",
            main_file
        ).into());
    }

    // Source hints initialize defaults; an explicit document choice takes precedence.
    let main_tex_content = std::fs::read_to_string(&main_tex_path).unwrap_or_default();
    let detected_engine = detect_tex_engine(&main_tex_content);
    let mut latexmk_engine = resolve_latexmk_engine(detected_engine, engine);

    if matches!(backend, CompilerBackend::Tectonic) {
        if let Some(TexEngine::LuaLaTeX) = detected_engine {
            return Err(
                "Compilation failed\n\nThis document requires LuaLaTeX (% !TEX program = lualatex), \
                 which is not supported. The selected Tectonic backend uses a XeTeX-based engine. \
                 Please switch to XeLaTeX or remove the magic comment."
                    .to_string().into(),
            );
        }
    }

    let actual_engine;
    let compile_result = if matches!(backend, CompilerBackend::Latexmk) {
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let (result, used_engine, ran_engine) = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            let mut actual_engine = None;
            let (result, used) = compile_latexmk_auto(
                &work_dir_clone,
                &main_file_clone,
                detected_engine,
                engine,
                installation,
                &mut actual_engine,
            );
            (result, used, actual_engine)
        })
        .await
        .map_err(|e| format!("Compilation task panicked: {}", e))?;
        latexmk_engine = used_engine;
        actual_engine = ran_engine;
        eprintln!(
            "[latex] +{:.0}ms latexmk done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    } else {
        // Run Tectonic in a subprocess to isolate C-level global state (font cache, etc.).
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let (result, ran_engine) = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            let mut actual_engine = None;
            let result = compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone, &mut actual_engine);
            (result, actual_engine)
        })
        .await
        .map_err(|e| format!("Compilation task panicked: {}", e))?;
        actual_engine = ran_engine;
        eprintln!(
            "[latex] +{:.0}ms tectonic done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    };

    let failure = |message| CompileFailure { message, diagnostics: Vec::new(), actual_engine };
    let backend_label = match backend {
        CompilerBackend::Latexmk => format!("Latexmk/{}", match latexmk_engine {
            TexEngine::Latex => "pdflatex",
            TexEngine::XeLaTeX => "xelatex",
            TexEngine::LuaLaTeX => "lualatex",
        }),
        CompilerBackend::Tectonic => "Tectonic".to_string(),
    };

    let log_path = work_dir.join(format!("{}.log", main_file_name));

    // Handle "No pages of output" — retry with \AtEndDocument{\null} injection (Tectonic only).
    if matches!(backend, CompilerBackend::Tectonic) && !pdf_path.exists() {
        let log_path_clone = log_path.clone();
        let main_tex = work_dir.join(&main_file);
        let pdf_path_clone = pdf_path.clone();
        let main_file_clone = main_file.clone();
        let work_dir_clone = work_dir.clone();

        let needs_retry = tokio::task::spawn_blocking(move || {
            let log_content = std::fs::read_to_string(&log_path_clone).unwrap_or_default();
            if !log_content.contains("No pages of output") || has_real_errors(&log_content) {
                return Ok(false);
            }
            eprintln!("[latex] no pages of output — retrying with \\null injection");
            if let Ok(content) = std::fs::read_to_string(&main_tex) {
                if let Some(pos) = content.find("\\begin{document}") {
                    let modified = format!(
                        "{}\\AtEndDocument{{\\null}}{}",
                        &content[..pos],
                        &content[pos..]
                    );
                    let _ = std::fs::write(&main_tex, &modified);
                    return Ok(true);
                }
            }
            Ok::<bool, String>(false)
        })
        .await
        .map_err(|e| failure(format!("Retry prep panicked: {}", e)))?
        .map_err(failure)?;

        if needs_retry {
            let retry_result = tokio::task::spawn_blocking(move || {
                compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone, &mut None)
            })
            .await
            .map_err(|e| failure(format!("Retry task panicked: {}", e)))?;
            eprintln!(
                "[latex] empty-body retry: ok={} pdf_exists={}",
                retry_result.is_ok(),
                pdf_path_clone.exists()
            );
        }
    }

    // Store build info
    {
        let mut builds = state.last_builds.lock().await;
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
            },
        );
    }

    if pdf_path.exists() {
        let pdf_path_clone = pdf_path.clone();
        let (pdf_bytes, pdf_size) = tokio::task::spawn_blocking(move || {
            if let Some(destination) = snapshot_path {
                let size = std::fs::copy(&pdf_path_clone, destination)?;
                Ok((Vec::new(), size))
            } else {
                let bytes = std::fs::read(&pdf_path_clone)?;
                let size = bytes.len() as u64;
                Ok::<_, std::io::Error>((bytes, size))
            }
        })
            .await
            .map_err(|e| failure(format!("PDF read task panicked: {}", e)))?
            .map_err(|e| failure(format!("Failed to read PDF: {}", e)))?;
        eprintln!(
            "[latex] +{:.0}ms total (reuse={}, backend={}) pdf_size={}KB",
            t0.elapsed().as_millis(),
            is_reuse,
            backend_label,
            pdf_size / 1024
        );
        let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
        let mut diagnostics = extract_compile_diagnostics(&log_content);
        project_locations(&mut diagnostics, &work_dir);
        Ok(CompiledLatex {
            actual_engine,
            pdf_bytes,
            diagnostics,
        })
    } else {
        let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
        let details = extract_error_lines(&log_content);
        let msg = if details.is_empty() {
            match compile_result {
                Err(e) => e,
                Ok(_) => "Compilation failed: no PDF generated".to_string(),
            }
        } else {
            details
        };
        let mut diagnostics = extract_compile_diagnostics(&log_content);
        project_locations(&mut diagnostics, &work_dir);
        Err(CompileFailure {
            actual_engine,
            message: format!("Compilation failed ({})\n\n{}", backend_label, msg),
            diagnostics,
        })
    }
}

pub async fn get_compiled_pdf(
    state: &LatexCompilerState,
    project_dir: String,
) -> Result<Vec<u8>, String> {
    let pdf_path = {
        let builds = state.last_builds.lock().await;
        let build = builds
            .get(&project_dir)
            .ok_or("No compiled PDF is available for this project")?;
        build.work_dir.join(format!("{}.pdf", build.main_file_name))
    };

    let pdf_bytes = tokio::task::spawn_blocking(move || std::fs::read(&pdf_path))
        .await
        .map_err(|error| format!("PDF read task panicked: {error}"))?
        .map_err(|error| format!("Failed to read compiled PDF: {error}"))?;
    Ok(pdf_bytes)
}

fn read_synctex_data(synctex_gz: &Path, synctex_plain: &Path) -> Result<String, String> {
    if synctex_gz.exists() {
        let compressed =
            std::fs::read(&synctex_gz).map_err(|e| format!("Failed to read synctex.gz: {}", e))?;
        let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
        let mut data = String::new();
        decoder
            .read_to_string(&mut data)
            .map_err(|e| format!("Failed to decompress synctex: {}", e))?;
        Ok::<_, String>(data)
    } else if synctex_plain.exists() {
        std::fs::read_to_string(&synctex_plain)
            .map_err(|e| format!("Failed to read synctex: {}", e))
    } else {
        Err("No synctex data found. Recompile with synctex enabled.".to_string())
    }
}

fn read_synctex_location(
    synctex_gz: &Path,
    synctex_plain: &Path,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<(String, u32, u32)>, String> {
    let reader: Box<dyn BufRead> = if synctex_gz.exists() {
        let file = std::fs::File::open(synctex_gz)
            .map_err(|e| format!("Failed to read synctex.gz: {e}"))?;
        Box::new(BufReader::new(flate2::read::GzDecoder::new(file)))
    } else if synctex_plain.exists() {
        let file = std::fs::File::open(synctex_plain)
            .map_err(|e| format!("Failed to read synctex: {e}"))?;
        Box::new(BufReader::new(file))
    } else {
        return Err("No synctex data found. Recompile with synctex enabled.".to_string());
    };
    parse_synctex_reader(reader, page, x, y).map_err(|e| format!("Failed to read synctex: {e}"))
}

fn relative_synctex_path(work_dir: &Path, file: &str) -> String {
    let root = work_dir
        .canonicalize()
        .unwrap_or_else(|_| work_dir.to_path_buf());
    // TeX may emit a canonical /private/var path while the build directory uses
    // macOS's /var alias. Resolve both sides, including embedded ./ segments.
    let absolute = work_dir
        .join(file)
        .canonicalize()
        .unwrap_or_else(|_| work_dir.join(file));
    absolute
        .strip_prefix(&root)
        .unwrap_or(&absolute)
        .to_string_lossy()
        .replace('\\', "/")
}

pub async fn get_synctex_source_map(
    state: &LatexCompilerState,
    project_dir: String,
) -> Result<crate::synctex_boxes::SourceMap, String> {
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project")?;
    let work_dir = build.work_dir.clone();
    let synctex_gz = work_dir.join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = work_dir.join(format!("{}.synctex", build.main_file_name));
    drop(builds);
    tokio::task::spawn_blocking(move || {
        let data = read_synctex_data(&synctex_gz, &synctex_plain)?;
        let mut map = crate::synctex_boxes::parse_source_map(&data);
        for file in map.inputs.values_mut() {
            *file = relative_synctex_path(&work_dir, file);
        }
        Ok(map)
    })
    .await
    .map_err(|e| format!("Synctex map task panicked: {e}"))?
}

pub async fn synctex_edit(
    state: &LatexCompilerState,
    project_dir: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SynctexResult, String> {
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project")?;

    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));

    let work_dir = build.work_dir.clone();
    drop(builds); // Release lock before I/O

    // Read, decompress, and parse synctex data (blocking I/O + CPU work → offload)
    let (file, line, column) = tokio::task::spawn_blocking(move || {
        read_synctex_location(&synctex_gz, &synctex_plain, page, x, y)?
            .ok_or_else(|| "Could not resolve source location".to_string())
    })
    .await
    .map_err(|e| format!("Synctex task panicked: {}", e))??;

    let file = relative_synctex_path(&work_dir, &file);

    Ok(SynctexResult { file, line, column })
}

fn parse_synctex_view_output(output: &str) -> Option<SynctexViewResult> {
    let mut page: Option<u32> = None;
    let mut x: Option<f64> = None;
    let mut y: Option<f64> = None;

    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line == "SyncTeX result end" {
            break;
        }
        if let Some(rest) = line.strip_prefix("Page:") {
            page = rest.trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix("x:") {
            x = rest.trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix("y:") {
            y = rest.trim().parse().ok();
        }

        if let (Some(page), Some(x), Some(y)) = (page, x, y) {
            return Some(SynctexViewResult { page, x, y });
        }
    }

    None
}

pub async fn synctex_view(
    state: &LatexCompilerState,
    project_dir: String,
    file: String,
    line: u32,
    column: u32,
) -> Result<SynctexViewResult, String> {
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project")?;

    let work_dir = build.work_dir.clone();
    let output_pdf = build.work_dir.join(format!("{}.pdf", build.main_file_name));
    drop(builds);

    let synctex = find_texlive_binary("synctex")?;
    let mut cmd = std::process::Command::new(&synctex);
    cmd.arg("view")
        .arg("-i")
        .arg(format!("{}:{}:{}", line, column, file))
        .arg("-o")
        .arg(output_pdf)
        .current_dir(&work_dir)
        .env("PATH", toolchain_env_path(&synctex))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| format!("Synctex view task panicked: {}", e))?
        .map_err(|e| format!("Failed to launch synctex: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "synctex view failed".to_string()
        };
        return Err(message);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_synctex_view_output(&stdout).ok_or_else(|| "Could not resolve PDF location".to_string())
}

/// Clear in-memory build state on app exit.
/// Persistent build directories are intentionally kept for fast restart.
pub async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    builds.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- detect_bib_tool ---

    #[test]
    fn compile_diagnostics_distinguish_warnings_and_recoverable_errors() {
        let diagnostics = extract_compile_diagnostics(
            "This is XeTeX\nLaTeX Warning: Reference `missing' undefined.\nOverfull \\hbox (2.0pt too wide) at lines 3--4\n! Undefined control sequence.\nLaTeX Warning: Reference `missing' undefined."
        );
        assert_eq!(diagnostics.len(), 3);
        assert_eq!(diagnostics[0].severity, "error");
        assert_eq!(diagnostics[1].severity, "warning");
        assert_eq!(diagnostics[2].severity, "warning");
        assert!(extract_compile_diagnostics("Output written on main.pdf (1 page). ").is_empty());
    }

    #[test]
    fn compile_diagnostics_preserve_locations_in_wrapped_warnings_and_errors() {
        let diagnostics = extract_compile_diagnostics(
            "(./main.tex\n(./sections/results.tex\nLaTeX Warning: Reference `missing' on page 1 undefined on input\nline 42.\n! Undefined control sequence.\nl.47 \\badcommand\n)\nOverfull \\hbox (2.0pt too wide) at lines 60--62\n)",
        );
        let json = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(json[0]["file"], "sections/results.tex");
        assert_eq!(json[0]["line"], 47);
        assert_eq!(json[1]["file"], "sections/results.tex");
        assert_eq!(json[1]["line"], 42);
        assert_eq!(json[2]["file"], "main.tex");
        assert_eq!(json[2]["line"], 60);
        assert_eq!(json[2]["end_line"], 62);
    }

    #[test]
    fn compile_diagnostics_keep_errors_when_warnings_are_truncated() {
        let mut log = (0..110)
            .map(|i| format!("Package example Warning: {}\n", i))
            .collect::<String>();
        log.push_str("! Missing $ inserted.\n");
        let diagnostics = extract_compile_diagnostics(&log);
        assert_eq!(diagnostics.len(), 100);
        assert_eq!(diagnostics[0].severity, "error");
    }

    #[test]
    fn test_detect_bib_tool_biber() {
        let content =
            "\\documentclass{article}\n\\usepackage{biblatex}\n\\begin{document}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_biblatex_with_options() {
        let content = "\\documentclass{article}\n\\usepackage[style=apa,backend=biber]{biblatex}\n\\begin{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_bibtex() {
        let content = "\\documentclass{article}\n\\bibliography{refs}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_addbibresource() {
        let content = "\\documentclass{article}\n\\addbibresource{refs.bib}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    #[test]
    fn test_detect_bib_tool_commented_out() {
        let content = "\\documentclass{article}\n% \\bibliography{refs}\n% \\usepackage{biblatex}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    // --- extract_error_lines ---

    #[test]
    fn test_extract_error_lines_empty_log() {
        assert_eq!(extract_error_lines(""), "");
    }

    #[test]
    fn test_extract_error_lines_no_pages() {
        let log = "Some preamble\nNo pages of output.\nSome trailing";
        let result = extract_error_lines(log);
        assert_eq!(
            result,
            "No pages of output. Add visible content to the document body."
        );
    }

    #[test]
    fn test_extract_error_lines_with_errors() {
        let log = "line 1\n! Undefined control sequence.\nline 3\n! Missing $ inserted.\nline 5";
        let result = extract_error_lines(log);
        assert!(result.contains("Undefined control sequence"));
        assert!(result.contains("Missing $ inserted"));
    }

    #[test]
    fn test_extract_error_lines_error_colon() {
        let log = "stuff\nLatex Error: Bad math environment\nmore stuff";
        let result = extract_error_lines(log);
        assert!(result.contains("Error:"));
    }

    #[test]
    fn test_extract_error_lines_no_errors_returns_tail() {
        let log = "a".repeat(1000);
        let result = extract_error_lines(&log);
        // Should return last 500 chars
        assert_eq!(result.len(), 500);
    }

    #[test]
    fn test_extract_error_lines_limits_to_10() {
        let mut log = String::new();
        for i in 0..20 {
            log.push_str(&format!("! Error number {}\n", i));
        }
        let result = extract_error_lines(&log);
        assert!(result.contains("---- Engine output ----"));
        let count = result.lines().count();
        assert!(count <= 120);
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_persistent_build_dir() {
        let dir = persistent_build_dir(Path::new("/Users/dev/Library/Caches/project-id"));
        assert_eq!(
            dir,
            PathBuf::from("/Users/dev/Library/Caches/project-id/latex-build")
        );
    }

    // --- parse_synctex_node ---

    #[test]
    fn test_parse_synctex_node_basic() {
        // Format: tag,line,column:h,v
        let node = parse_synctex_node("1,42,0:1000,2000", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 1);
        assert_eq!(node.line, 42);
        assert_eq!(node.h, 1000.0);
        assert_eq!(node.v, 2000.0);
    }

    #[test]
    fn test_parse_synctex_node_with_dimensions() {
        // Format: tag,line,column:h,v:W,H,D
        let node = parse_synctex_node("3,10,0:500,600:100,20,5", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 3);
        assert_eq!(node.line, 10);
    }

    #[test]
    fn test_parse_synctex_node_with_offset() {
        let node = parse_synctex_node("1,1,0:0,0", 1.0, 10.0, 20.0);
        let node = node.unwrap();
        assert_eq!(node.h, 10.0); // 0 * 1.0 + 10.0
        assert_eq!(node.v, 20.0); // 0 * 1.0 + 20.0
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_colon() {
        assert!(parse_synctex_node("1,1,0", 1.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_comma() {
        assert!(parse_synctex_node("1:100,200", 1.0, 0.0, 0.0).is_none());
    }

    // --- parse_synctex_data ---

    #[test]
    fn synctex_paths_resolve_relative_absolute_and_build_directory_aliases() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("build");
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        let source = root.join("chapters/second.tex");
        std::fs::write(&source, "Chapter").unwrap();
        assert_eq!(
            relative_synctex_path(&root, "./chapters/second.tex"),
            "chapters/second.tex",
        );
        assert_eq!(
            relative_synctex_path(&root, &source.to_string_lossy()),
            "chapters/second.tex",
        );
        let outside = directory.path().join("external.tex");
        std::fs::write(&outside, "External").unwrap();
        assert_eq!(
            relative_synctex_path(&root, &outside.to_string_lossy()),
            outside
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/"),
        );
        #[cfg(unix)]
        {
            let alias = directory.path().join("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            let canonical_source = source.canonicalize().unwrap();
            assert_eq!(
                relative_synctex_path(&alias, &canonical_source.to_string_lossy()),
                "chapters/second.tex",
            );
        }
    }

    #[test]
    fn inverse_synctex_resolves_files_introduced_between_pages() {
        let data = "Input:1:main.tex\nContent:\n{1\nh1,12,0:0,0\n}1\n\
                    Input:2:chapters/second.tex\n{2\nh2,34,0:0,0\n}2\n\
                    Input:3:chapters/third.tex\n{3\nh3,56,0:0,0\n}3\n";
        for (page, file, line) in [
            (1, "main.tex", 12),
            (2, "chapters/second.tex", 34),
            (3, "chapters/third.tex", 56),
        ] {
            assert_eq!(
                parse_synctex_data(data, page, 0.0, 0.0),
                Some((file.to_string(), line, 0))
            );
        }
    }

    #[test]
    fn inverse_synctex_stream_handles_utf8_crlf_ties_and_stops_after_target_page() {
        let first_page =
            "Input:1:./章节.tex\r\nContent:\r\n{1\r\nh1,10,0:0,0\r\nh1,20,0:0,0\r\n}1\r\n";
        let mut bytes = first_page.as_bytes().to_vec();
        bytes.extend_from_slice(b"{2\n\xff\n}2\n");
        // Tiny reads split UTF-8 code points and records across buffer boundaries.
        let reader = BufReader::with_capacity(1, std::io::Cursor::new(&bytes));
        assert_eq!(
            parse_synctex_reader(reader, 1, 0.0, 0.0).unwrap(),
            Some(("./章节.tex".to_string(), 10, 0))
        );
        let reader = BufReader::with_capacity(1, std::io::Cursor::new(&bytes));
        assert!(parse_synctex_reader(reader, 2, 0.0, 0.0).is_err());
    }

    #[test]
    fn inverse_synctex_reads_plain_and_gzip_and_observes_replaced_data() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let plain = directory.path().join("main.synctex");
        let gzip = directory.path().join("main.synctex.gz");
        assert!(read_synctex_location(&gzip, &plain, 1, 0.0, 0.0).is_err());
        let first = "Input:1:main.tex\nContent:\n{1\nh1,12,0:0,0\n}1\n";
        std::fs::write(&plain, first).unwrap();
        assert_eq!(
            read_synctex_location(&gzip, &plain, 1, 0.0, 0.0).unwrap(),
            Some(("main.tex".to_string(), 12, 0))
        );
        for line in [21, 42] {
            let data = format!("Input:1:other.tex\nContent:\n{{1\nh1,{line},0:0,0\n}}1\n");
            let mut encoder = flate2::write::GzEncoder::new(
                std::fs::File::create(&gzip).unwrap(),
                flate2::Compression::default(),
            );
            encoder.write_all(data.as_bytes()).unwrap();
            encoder.finish().unwrap();
            assert_eq!(
                read_synctex_location(&gzip, &plain, 1, 0.0, 0.0).unwrap(),
                Some(("other.tex".to_string(), line, 0))
            );
            assert!(read_synctex_location(&gzip, &plain, 2, 0.0, 0.0)
                .unwrap()
                .is_none());
        }
        std::fs::write(&gzip, b"invalid gzip").unwrap();
        assert!(read_synctex_location(&gzip, &plain, 1, 0.0, 0.0).is_err());
    }

    #[test]
    fn test_parse_synctex_data_basic() {
        let data = "\
SyncTeX Version:1
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000:500,100,0
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 50.0, 50.0);
        assert!(result.is_some());
        let (file, line, _col) = result.unwrap();
        assert_eq!(file, "./main.tex");
        assert_eq!(line, 5);
    }

    #[test]
    fn test_parse_synctex_data_wrong_page() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000
}1
Postamble:
";
        // Looking for page 2 but data only has page 1
        let result = parse_synctex_data(data, 2, 50.0, 50.0);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_synctex_data_closest_node() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,10,0:0,0
h1,20,0:100000000,100000000
}1
Postamble:
";
        // (0, 0) is closer to the first node
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 10);
    }

    #[test]
    fn test_parse_synctex_data_scales_offsets_before_matching() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:4736287
Y Offset:4736287
Content:
{1
h1,10,0:0,0
h1,20,0:10000000,10000000
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 224.0, 224.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 20);
    }

    #[test]
    fn test_parse_synctex_view_output_uses_first_result() {
        let output = "\
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:main.pdf
Page:2
x:72.5
y:195.25
h:72.5
v:198.0
Output:main.pdf
Page:3
x:10
y:20
SyncTeX result end
";
        let result = parse_synctex_view_output(output).unwrap();
        assert_eq!(result.page, 2);
        assert_eq!(result.x, 72.5);
        assert_eq!(result.y, 195.25);
    }

    #[test]
    fn test_parse_synctex_data_empty() {
        let result = parse_synctex_data("", 1, 0.0, 0.0);
        assert!(result.is_none());
    }

    // --- extract_error_lines additional edge cases ---

    #[test]
    fn test_extract_error_lines_mixed_error_formats() {
        let log = "preamble\n! LaTeX Error: File not found.\nl.42 \\input{missing}\nerror: compilation stopped";
        let result = extract_error_lines(log);
        assert!(result.contains("LaTeX Error"));
        assert!(result.contains("error: compilation stopped"));
    }

    #[test]
    fn test_extract_error_lines_short_log_no_errors() {
        let log = "This is a short log without errors";
        let result = extract_error_lines(log);
        // Short log (< 500 chars) returned as tail
        assert_eq!(result, log);
    }

    // --- parse_synctex_node additional edge cases ---

    #[test]
    fn test_parse_synctex_node_negative_coordinates() {
        let node = parse_synctex_node("1,1,0:-500,300", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let n = node.unwrap();
        assert_eq!(n.h, -500.0);
        assert_eq!(n.v, 300.0);
    }

    #[test]
    fn test_parse_synctex_node_factor_scaling() {
        // factor=2.0 should double the coordinates
        let node = parse_synctex_node("1,1,0:100,200", 2.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.h, 200.0);
        assert_eq!(n.v, 400.0);
    }

    #[test]
    fn test_parse_synctex_node_zero_tag_and_line() {
        let node = parse_synctex_node("0,0,0:0,0", 1.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.tag, 0);
        assert_eq!(n.line, 0);
    }

    // --- parse_synctex_data additional edge cases ---

    #[test]
    fn test_parse_synctex_data_multiple_inputs() {
        let data = "\
Input:1:./main.tex
Input:2:./chapter1.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h2,15,0:500,500
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (file, line, _) = result.unwrap();
        assert_eq!(file, "./chapter1.tex");
        assert_eq!(line, 15);
    }

    #[test]
    fn test_parse_synctex_data_multiple_pages() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:100,100
}1
{2
h1,25,0:200,200
}2
Postamble:
";
        let result = parse_synctex_data(data, 2, 200.0, 200.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 25);
    }

    // --- extract_error_lines: real errors take priority over "No pages of output" ---

    #[test]
    fn test_extract_error_lines_real_errors_over_no_pages() {
        let log = "Some preamble\n! LaTeX Error: File `missing.sty' not found.\nNo pages of output.\nMore stuff";
        let result = extract_error_lines(log);
        assert!(
            result.contains("LaTeX Error"),
            "real error should be shown, got: {}",
            result
        );
        assert!(
            !result.contains("Add visible content"),
            "No pages fallback should NOT appear"
        );
    }

    // --- has_real_errors ---

    #[test]
    fn test_has_real_errors_with_bang() {
        assert!(has_real_errors("ok\n! Undefined control sequence.\nmore"));
    }

    #[test]
    fn test_has_real_errors_with_error_colon() {
        assert!(has_real_errors("LaTeX Error: Bad math\nstuff"));
    }

    #[test]
    fn test_has_real_errors_none() {
        assert!(!has_real_errors("This is pdfTeX\nNo pages of output.\n"));
    }

    // --- detect_tex_engine ---

    #[test]
    fn test_detect_tex_engine_xelatex() {
        let content = "% !TEX program = xelatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_pdflatex() {
        let content = "% !TEX program = pdflatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::Latex));
    }

    #[test]
    fn test_detect_tex_engine_lualatex() {
        let content = "% !TEX program = lualatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::LuaLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";
        assert_eq!(detect_tex_engine(content), None);
    }

    #[test]
    fn test_detect_tex_engine_case_insensitive() {
        let content = "  % !TeX program = XeLaTeX\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_no_spaces() {
        let content = "%!TEX program=xelatex\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_resolve_latexmk_engine_auto_prefers_detected_engine() {
        assert_eq!(
            resolve_latexmk_engine(Some(TexEngine::LuaLaTeX), None),
            TexEngine::LuaLaTeX
        );
    }


    #[test]
    fn auto_engine_defaults_and_overrides() {
        assert_eq!(resolve_latexmk_engine(None, None), TexEngine::Latex);
        assert_eq!(resolve_latexmk_engine(None, Some(TexEngine::LuaLaTeX)), TexEngine::LuaLaTeX);
        assert_eq!(resolve_latexmk_engine(Some(TexEngine::XeLaTeX), Some(TexEngine::Latex)), TexEngine::Latex);
        assert!(needs_unicode_engine("LaTeX Error: Unicode character 中 (U+4E2D)\nnot set up for use with LaTeX."));
        assert!(needs_unicode_engine("Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX."));
        assert!(!needs_unicode_engine("Undefined control sequence. File missing.tex not found."));
        assert!(!needs_unicode_engine("Package fontspec Error: The font Missing cannot be found."));
    }

    #[test]
    fn engine_is_unknown_when_the_toolchain_cannot_start() {
        let dir = tempfile::tempdir().unwrap();
        let mut actual_engine = None;
        let (result, _) = compile_latexmk_auto(
            dir.path(), "main.tex", None, None,
            Some(dir.path().to_string_lossy().into_owned()), &mut actual_engine,
        );
        assert!(result.is_err());
        assert_eq!(actual_engine, None);
        assert_eq!(CompileFailure::from("Missing source".to_string()).actual_engine, None);
    }

    #[test]
    #[ignore = "requires an installed latexmk, pdfLaTeX and XeLaTeX"]
    fn auto_engine_real_toolchain() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut actual_engine = None;
        let write = |content: &str| std::fs::write(root.join("main.tex"), content).unwrap();
        write(r"\documentclass{article}\begin{document}Hello café\end{document}");
        let (result, used) = compile_latexmk_auto(root, "main.tex", None, None, None, &mut actual_engine);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(used, TexEngine::Latex);
        assert_eq!(actual_engine, Some("pdflatex"));
        std::fs::write(root.join("preamble.tex"), r"\usepackage{fontspec}").unwrap();
        write(r"\documentclass{article}\input{preamble}\begin{document}Hello\end{document}");
        let (result, used) = compile_latexmk_auto(root, "main.tex", None, None, None, &mut actual_engine);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(used, TexEngine::XeLaTeX);
        assert_eq!(actual_engine, Some("xelatex"));
        for (detected, preferred) in [(Some(TexEngine::Latex), None), (None, Some(TexEngine::Latex))] {
            let (result, used) = compile_latexmk_auto(root, "main.tex", detected, preferred, None, &mut actual_engine);
            assert!(result.is_err());
            assert_eq!(used, TexEngine::Latex);
            assert_eq!(actual_engine, Some("pdflatex"));
        }
        write(r"\documentclass[fontset=fandol]{ctexart}\begin{document}中文测试\end{document}");
        let (result, used) = compile_latexmk_auto(root, "main.tex", None, None, None, &mut actual_engine);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(used, TexEngine::XeLaTeX);
        assert_eq!(actual_engine, Some("xelatex"));
        write(r"\documentclass{article}\begin{document}\input{missing}\end{document}");
        let (result, used) = compile_latexmk_auto(root, "main.tex", None, None, None, &mut actual_engine);
        assert!(result.is_err());
        assert_eq!(used, TexEngine::Latex);
        assert_eq!(actual_engine, Some("pdflatex"));
    }

    #[test]
    #[ignore = "requires an installed latexmk and pdfLaTeX"]
    fn explicit_engine_overrides_source_hint_in_real_toolchain() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("main.tex"), r"% !TEX program = xelatex
\documentclass{article}\begin{document}Explicit engine\end{document}").unwrap();
        let mut actual_engine = None;
        let (result, used) = compile_latexmk_auto(dir.path(), "main.tex", Some(TexEngine::XeLaTeX), Some(TexEngine::Latex), None, &mut actual_engine);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(used, TexEngine::Latex);
        assert_eq!(actual_engine, Some("pdflatex"));
    }

    // --- persistent_build_dir edge case ---

    #[test]
    fn test_persistent_build_dir_trailing_slash() {
        let dir = persistent_build_dir(Path::new("/cache/project/"));
        assert_eq!(dir, PathBuf::from("/cache/project/latex-build"));
    }

    // --- copy_dir_recursive integration tests ---

    #[test]
    fn test_copy_dir_recursive_nested() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Create nested structure
        std::fs::create_dir_all(src.path().join("sub").join("deep")).unwrap();
        std::fs::write(src.path().join("comments.json"), "catalex metadata").unwrap();
        std::fs::write(src.path().join("comments-agents.json"), "agent metadata").unwrap();
        std::fs::write(src.path().join("top.tex"), "top").unwrap();
        std::fs::write(src.path().join("sub").join("mid.tex"), "mid").unwrap();
        std::fs::write(
            src.path().join("sub").join("comments.json"),
            "nested project data",
        )
        .unwrap();
        std::fs::write(
            src.path().join("sub").join("deep").join("bottom.tex"),
            "bottom",
        )
        .unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("top.tex")).unwrap(),
            "top"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("mid.tex")).unwrap(),
            "mid"
        );
        assert!(!dst.path().join("comments.json").exists());
        assert!(!dst.path().join("comments-agents.json").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("comments.json")).unwrap(),
            "nested project data"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("deep").join("bottom.tex"))
                .unwrap(),
            "bottom"
        );
    }

    #[test]
    fn test_copy_dir_recursive_skips_hidden_dirs() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join(".git")).unwrap();
        std::fs::write(src.path().join(".git").join("config"), "secret").unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join(".git").exists(), ".git should be skipped");
    }

    #[test]
    fn test_copy_dir_recursive_empty_subdir() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("empty_sub")).unwrap();
        std::fs::write(src.path().join("a.tex"), "a").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("empty_sub").exists());
        assert!(dst.path().join("empty_sub").is_dir());
    }

    // --- sync_source_files integration tests ---

    #[test]
    fn test_sync_source_files_copies_sources() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("refs.bib"), "bib").unwrap();
        std::fs::write(src.path().join("style.sty"), "sty").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            "doc"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("refs.bib")).unwrap(),
            "bib"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("style.sty")).unwrap(),
            "sty"
        );
    }

    #[test]
    fn test_sync_source_files_skips_artifacts() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("main.aux"), "aux").unwrap();
        std::fs::write(src.path().join("main.log"), "log").unwrap();
        std::fs::write(src.path().join("main.synctex.gz"), "sync").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join("main.aux").exists());
        assert!(!dst.path().join("main.log").exists());
        assert!(!dst.path().join("main.synctex.gz").exists());
    }

    #[test]
    fn test_sync_source_files_recursive_and_skips_hidden() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("chapters")).unwrap();
        std::fs::create_dir_all(src.path().join(".catalex")).unwrap();
        std::fs::write(src.path().join("comments.json"), "catalex metadata").unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.tex"), "ch1").unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.aux"), "aux").unwrap();
        std::fs::write(
            src.path().join("chapters").join("comments.json"),
            "nested project data",
        )
        .unwrap();
        std::fs::write(src.path().join(".catalex").join("data"), "data").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("chapters").join("ch1.tex")).unwrap(),
            "ch1"
        );
        assert!(!dst.path().join("comments.json").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("chapters").join("comments.json")).unwrap(),
            "nested project data"
        );
        assert!(!dst.path().join("chapters").join("ch1.aux").exists());
        assert!(!dst.path().join(".catalex").exists());
    }

    // --- sync_source_files copies figure PDFs ---

    #[test]
    fn test_sync_source_files_copies_figure_pdfs() {
        // .pdf files (e.g. figures) must be synced — they are NOT artifacts.
        // The output PDF is managed by compile_latex (explicit remove_file).
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("figures")).unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("figures").join("chart.pdf"), "pdf figure").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("figures").join("chart.pdf")).unwrap(),
            "pdf figure"
        );
    }

    #[test]
    fn test_sync_source_files_overwrites_changed_tex_content() {
        // Regression: when a user empties a file, sync must overwrite
        // the old content in the build dir with the empty content.
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Old content in build dir
        std::fs::write(dst.path().join("main.tex"), "old content").unwrap();
        // User emptied the file
        std::fs::write(src.path().join("main.tex"), "").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            ""
        );
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_stale_pdf_removal_pattern() {
        // Simulates the pattern used in compile_latex: remove stale PDF
        // before compilation so a failed compile doesn't return old results.
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        // Simulate previous successful build left a PDF
        std::fs::write(&pdf_path, "old pdf data").unwrap();
        assert!(pdf_path.exists());

        // This is what compile_latex does before running tectonic
        let _ = std::fs::remove_file(&pdf_path);
        assert!(!pdf_path.exists());

        // If compilation fails, pdf_path.exists() is false → error returned
    }

    #[test]
    fn test_stale_pdf_removal_no_existing_file() {
        // remove_file on a non-existent path should not panic (we use let _ =)
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        assert!(!pdf_path.exists());
        let result = std::fs::remove_file(&pdf_path);
        // It's an error but we ignore it with let _ =
        assert!(result.is_err());
    }
}
