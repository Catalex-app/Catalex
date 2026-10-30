mod agent_questions;
mod agent_workspace;
mod branding;
mod builtin_skills;
mod claude;
mod codex;
mod comments;
mod compile_diagnostics;
mod git_conflicts;
mod git_credentials;
mod history;
mod host;
mod latex;
mod model_verification;
mod pi;
mod private_files;
mod project_files;
mod project_storage;
mod service;
mod shared_sessions;
mod slash_commands;
mod synctex_boxes;
mod text_merge;
mod verification;
mod workspace_mcp;
mod zotero;

pub fn tectonic_compile_subprocess(
    work_dir: &std::path::Path,
    main_file: &str,
) -> Result<(), String> {
    latex::compile_with_tectonic(work_dir, main_file)
}

pub async fn run() -> Result<(), String> {
    service::run().await
}
