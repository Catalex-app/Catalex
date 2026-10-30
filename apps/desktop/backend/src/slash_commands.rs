use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const CATALEX_VERIFY_SKILL_NAME: &str = "catalex-verify-latex";
const CATALEX_VERIFY_SKILL_DESCRIPTION: &str =
    "Compile, repair, and visually inspect LaTeX changes with bounded retries.";
const CATALEX_VERIFY_SKILL_CONTENT: &str = include_str!(
    "../resources/catalex/skills/catalex-verify-latex/SKILL.md"
);
const REVIEW_SKILL_CONTENT: &str = include_str!(
    "../resources/catalex/skills/review-document/SKILL.md"
);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub id: String,
    pub name: String,
    pub full_command: String,
    pub scope: String,
    pub namespace: Option<String>,
    pub file_path: String,
    pub content: String,
    pub description: Option<String>,
    pub allowed_tools: Vec<String>,
    pub has_bash_commands: bool,
    pub has_file_references: bool,
    pub accepts_arguments: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct CommandFrontmatterRaw {
    allowed_tools: Option<serde_yaml::Value>,
    description: Option<String>,
    name: Option<String>,
}

struct CommandFrontmatter {
    allowed_tools: Option<Vec<String>>,
    description: Option<String>,
    name: Option<String>,
}

impl CommandFrontmatterRaw {
    fn into_parsed(self) -> CommandFrontmatter {
        let allowed_tools = self.allowed_tools.and_then(|v| match v {
            serde_yaml::Value::String(s) => {
                let tools: Vec<String> = s.split_whitespace().map(|t| t.to_string()).collect();
                if tools.is_empty() {
                    None
                } else {
                    Some(tools)
                }
            }
            serde_yaml::Value::Sequence(seq) => {
                let tools: Vec<String> = seq
                    .into_iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                if tools.is_empty() {
                    None
                } else {
                    Some(tools)
                }
            }
            _ => None,
        });
        CommandFrontmatter {
            allowed_tools,
            description: self.description,
            name: self.name,
        }
    }
}

fn parse_markdown_with_frontmatter(content: &str) -> (Option<CommandFrontmatter>, String) {
    let lines: Vec<&str> = content.lines().collect();

    if lines.first() != Some(&"---") {
        return (None, content.to_string());
    }

    let mut frontmatter_end = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if *line == "---" {
            frontmatter_end = Some(i);
            break;
        }
    }

    if let Some(end) = frontmatter_end {
        let frontmatter_content = lines.get(1..end).map(|s| s.join("\n")).unwrap_or_default();
        let body_content = lines
            .get((end + 1)..)
            .map(|s| s.join("\n"))
            .unwrap_or_default();

        match serde_yaml::from_str::<CommandFrontmatterRaw>(&frontmatter_content) {
            Ok(raw) => (Some(raw.into_parsed()), body_content),
            Err(_) => (None, content.to_string()),
        }
    } else {
        (None, content.to_string())
    }
}

fn extract_command_info(file_path: &Path, base_path: &Path) -> Option<(String, Option<String>)> {
    let relative_path = file_path.strip_prefix(base_path).ok()?;
    let path_without_ext = relative_path
        .with_extension("")
        .to_string_lossy()
        .to_string();

    let components: Vec<&str> = path_without_ext.split(['/', '\\']).collect();

    if components.is_empty() {
        return None;
    }

    if components.len() == 1 {
        Some((components.first()?.to_string(), None))
    } else {
        let command_name = components.last()?.to_string();
        let namespace = components
            .get(..components.len() - 1)
            .map(|s| s.join(":"))
            .unwrap_or_default();
        Some((command_name, Some(namespace)))
    }
}

fn load_command_from_file(file_path: &Path, base_path: &Path, scope: &str) -> Option<SlashCommand> {
    let content = fs::read_to_string(file_path).ok()?;
    let (frontmatter, body) = parse_markdown_with_frontmatter(&content);
    let (name, namespace) = extract_command_info(file_path, base_path)?;

    let full_command = match &namespace {
        Some(ns) => format!("/{ns}:{name}"),
        None => format!("/{name}"),
    };

    let id = format!(
        "{}-{}",
        scope,
        file_path.to_string_lossy().replace('/', "-")
    );

    let has_bash_commands = body.contains("!`");
    let has_file_references = body.contains('@');
    let accepts_arguments = body.contains("$ARGUMENTS");

    let (description, allowed_tools) = if let Some(fm) = frontmatter {
        (fm.description, fm.allowed_tools.unwrap_or_default())
    } else {
        (None, Vec::new())
    };

    Some(SlashCommand {
        id,
        name,
        full_command,
        scope: scope.to_string(),
        namespace,
        file_path: file_path.to_string_lossy().to_string(),
        content: body,
        description,
        allowed_tools,
        has_bash_commands,
        has_file_references,
        accepts_arguments,
    })
}

fn find_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) {
    if !dir.exists() {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();

        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }

        if path.is_dir() {
            find_markdown_files(&path, files);
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" {
                    files.push(path);
                }
            }
        }
    }
}

fn load_skill_from_file(skill_md: &Path, scope: &str) -> Option<SlashCommand> {
    if !skill_md.exists() {
        return None;
    }

    let path = skill_md.parent()?;
    if !path.is_dir() {
        return None;
    }

    let content = match fs::read_to_string(skill_md) {
        Ok(c) => c,
        Err(_) => return None,
    };

    let folder_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => return None,
    };

    let (frontmatter, body) = parse_markdown_with_frontmatter(&content);

    // Name: frontmatter name > first # heading > folder name
    let name = frontmatter
        .as_ref()
        .and_then(|fm| fm.name.clone())
        .or_else(|| {
            body.lines()
                .find(|l| l.starts_with("# "))
                .map(|l| l.trim_start_matches("# ").trim().to_string())
        })
        .unwrap_or_else(|| folder_name.clone());

    // Description: frontmatter description (truncated to 200 chars)
    let description = frontmatter
        .as_ref()
        .and_then(|fm| fm.description.clone())
        .map(|d| d.chars().take(200).collect());

    let id = format!("skill-{}", folder_name);

    Some(SlashCommand {
        id,
        name: name.clone(),
        full_command: format!("/{}", folder_name),
        scope: scope.to_string(),
        namespace: None,
        file_path: skill_md.to_string_lossy().to_string(),
        content,
        description,
        allowed_tools: vec![],
        has_bash_commands: false,
        has_file_references: false,
        accepts_arguments: true,
    })
}

/// Load skills from a `.claude/skills/` directory.
/// Each skill is a direct child directory containing a `SKILL.md` file.
fn load_skills_from_dir(dir: &Path, scope: &str) -> Vec<SlashCommand> {
    if !dir.exists() {
        return Vec::new();
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut skills = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if let Some(skill) = load_skill_from_file(&skill_md, scope) {
            skills.push(skill);
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn collect_skill_md_files(dir: &Path, files: &mut Vec<PathBuf>, include_hidden: bool) {
    if !dir.exists() {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        if path.is_dir() {
            if !include_hidden && name.starts_with('.') {
                continue;
            }
            collect_skill_md_files(&path, files, include_hidden);
        } else if path.is_file() && name == "SKILL.md" {
            files.push(path);
        }
    }
}

fn load_recursive_skills_from_dir(
    dir: &Path,
    scope: &str,
    include_hidden: bool,
) -> Vec<SlashCommand> {
    let mut skill_files = Vec::new();
    collect_skill_md_files(dir, &mut skill_files, include_hidden);

    let mut skills = skill_files
        .iter()
        .filter_map(|path| load_skill_from_file(path, scope))
        .collect::<Vec<_>>();

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn merge_unique_skills(commands: &mut Vec<SlashCommand>, skills: Vec<SlashCommand>) {
    let mut existing_commands = commands
        .iter()
        .filter(|c| c.scope == "skill")
        .map(|c| c.full_command.clone())
        .collect::<std::collections::HashSet<_>>();

    for skill in skills {
        if existing_commands.insert(skill.full_command.clone()) {
            commands.push(skill);
        }
    }
}

fn create_builtin_skill_commands(provider: Option<&str>) -> Vec<SlashCommand> {
    [
        (
            CATALEX_VERIFY_SKILL_NAME,
            CATALEX_VERIFY_SKILL_DESCRIPTION,
            CATALEX_VERIFY_SKILL_CONTENT,
        ),
        (
            "review-document",
            "Review documents and leave exact-passage comments without rewriting.",
            REVIEW_SKILL_CONTENT,
        ),
    ]
    .into_iter()
    .map(|(name, description, content)| {
        let namespace = (!matches!(provider, Some("codex" | "pi"))).then(|| "catalex".to_string());
        SlashCommand {
            id: format!("skill-{name}"),
            name: name.to_string(),
            full_command: match &namespace {
                Some(namespace) => format!("/{namespace}:{name}"),
                None => format!("/{name}"),
            },
            scope: "skill".to_string(),
            namespace,
            file_path: format!("catalex://built-in-skills/{name}/SKILL.md"),
            content: content.to_string(),
            description: Some(description.to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: true,
        }
    })
    .collect()
}


fn resolve_project_skills_dir(project_path: &str, provider: Option<&str>) -> PathBuf {
    let root = match provider {
        Some("codex") => ".codex",
        Some("pi") => ".pi",
        _ => ".claude",
    };
    PathBuf::from(project_path).join(root).join("skills")
}

fn resolve_global_skills_dir(provider: Option<&str>) -> Option<PathBuf> {
    if provider == Some("pi") {
        return std::env::var_os("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".pi/agent")))
            .map(|root| root.join("skills"));
    }
    let root = if provider == Some("codex") {
        ".codex"
    } else {
        ".claude"
    };
    dirs::home_dir().map(|home_dir| home_dir.join(root).join("skills"))
}

fn resolve_codex_plugin_skills_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home_dir| home_dir.join(".codex").join("plugins"))
}

fn resolve_claude_plugin_skills_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home_dir| home_dir.join(".claude").join("plugins"))
}

pub async fn slash_commands_list(
    project_path: Option<String>,
    provider: Option<String>,
) -> Result<Vec<SlashCommand>, String> {
    let mut commands = Vec::new();

    commands.extend(create_builtin_skill_commands(provider.as_deref()));

    // Pi discovers its prompt templates itself; do not advertise Claude commands.
    if provider.as_deref() != Some("pi") {
        // Load project commands
        if let Some(ref proj_path) = project_path {
            let project_commands_dir = PathBuf::from(proj_path).join(".claude").join("commands");
            if project_commands_dir.exists() {
                let mut md_files = Vec::new();
                find_markdown_files(&project_commands_dir, &mut md_files);
                for file_path in md_files {
                    if let Some(cmd) =
                        load_command_from_file(&file_path, &project_commands_dir, "project")
                    {
                        commands.push(cmd);
                    }
                }
            }
        }

        // Load user commands
        if let Some(home_dir) = dirs::home_dir() {
            let user_commands_dir = home_dir.join(".claude").join("commands");
            if user_commands_dir.exists() {
                let mut md_files = Vec::new();
                find_markdown_files(&user_commands_dir, &mut md_files);
                for file_path in md_files {
                    if let Some(cmd) =
                        load_command_from_file(&file_path, &user_commands_dir, "user")
                    {
                        commands.push(cmd);
                    }
                }
            }
        }
    }

    // Load installed skills (project-level first, then global)
    if let Some(proj_path) = &project_path {
        let project_skills_dir = resolve_project_skills_dir(proj_path, provider.as_deref());
        let project_skills = if provider.as_deref() == Some("codex") {
            load_recursive_skills_from_dir(&project_skills_dir, "skill", true)
        } else {
            load_skills_from_dir(&project_skills_dir, "skill")
        };
        merge_unique_skills(&mut commands, project_skills);
    }
    if let Some(global_skills_dir) = resolve_global_skills_dir(provider.as_deref()) {
        let global_skills = if provider.as_deref() == Some("codex") {
            load_recursive_skills_from_dir(&global_skills_dir, "skill", true)
        } else {
            load_skills_from_dir(&global_skills_dir, "skill")
        };
        merge_unique_skills(&mut commands, global_skills);
    }
    if provider.as_deref() == Some("codex") {
        if let Some(plugin_skills_root) = resolve_codex_plugin_skills_root() {
            let plugin_skills = load_recursive_skills_from_dir(&plugin_skills_root, "skill", true);
            merge_unique_skills(&mut commands, plugin_skills);
        }
    } else if provider.as_deref() != Some("pi") {
        if let Some(plugin_skills_root) = resolve_claude_plugin_skills_root() {
            let plugin_skills = load_recursive_skills_from_dir(&plugin_skills_root, "skill", true);
            merge_unique_skills(&mut commands, plugin_skills);
        }
    }

    Ok(commands)
}

pub async fn slash_command_get(command_id: String) -> Result<SlashCommand, String> {
    let commands = slash_commands_list(None, None).await?;
    commands
        .into_iter()
        .find(|cmd| cmd.id == command_id)
        .ok_or_else(|| format!("Command not found: {}", command_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_markdown_no_frontmatter() {
        let (fm, body) = parse_markdown_with_frontmatter("Just some content\nwith lines");
        assert!(fm.is_none());
        assert_eq!(body, "Just some content\nwith lines");
    }

    #[test]
    fn test_parse_markdown_empty() {
        let (fm, body) = parse_markdown_with_frontmatter("");
        assert!(fm.is_none());
        assert_eq!(body, "");
    }

    #[test]
    fn test_parse_markdown_with_valid_frontmatter() {
        let content = "---\ndescription: My command\n---\nBody content here";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        assert!(fm.is_some());
        let fm = fm.unwrap();
        assert_eq!(fm.description.unwrap(), "My command");
        assert_eq!(body, "Body content here");
    }

    #[test]
    fn test_parse_markdown_with_allowed_tools() {
        let content = "---\ndescription: Test\nallowed-tools:\n  - Bash\n  - Read\n---\nBody";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        let fm = fm.unwrap();
        assert_eq!(fm.allowed_tools.unwrap(), vec!["Bash", "Read"]);
        assert_eq!(body, "Body");
    }

    #[test]
    fn test_parse_markdown_unclosed_frontmatter() {
        let content = "---\ndescription: Test\nno closing delimiter";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        assert!(fm.is_none());
        assert_eq!(body, content);
    }

    #[test]
    fn test_extract_command_info_simple() {
        let base = Path::new("/commands");
        let file = Path::new("/commands/greet.md");
        let (name, namespace) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "greet");
        assert!(namespace.is_none());
    }

    #[test]
    fn test_extract_command_info_nested() {
        let base = Path::new("/commands");
        let file = Path::new("/commands/tools/lint.md");
        let (name, namespace) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "lint");
        assert_eq!(namespace.unwrap(), "tools");
    }

    #[test]
    fn test_extract_command_info_deeply_nested() {
        let base = Path::new("/commands");
        let file = Path::new("/commands/tools/rust/clippy.md");
        let (name, namespace) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "clippy");
        assert_eq!(namespace.unwrap(), "tools:rust");
    }

    #[test]
    fn test_extract_command_info_strips_extension() {
        let base = Path::new("/base");
        let file = Path::new("/base/my-command.md");
        let (name, _) = extract_command_info(file, base).unwrap();
        assert_eq!(name, "my-command");
    }

    // --- SKILL.md frontmatter parsing tests ---

    #[test]
    fn test_parse_skill_frontmatter_with_extra_fields() {
        // Real SKILL.md format: has name, description, license, metadata — extra fields
        let content = "---\nname: biopython\ndescription: Comprehensive molecular biology toolkit.\nlicense: Unknown\nmetadata:\n    skill-author: K-Dense Inc.\n---\n\n# Biopython\n\nBody here.";
        let (fm, body) = parse_markdown_with_frontmatter(content);
        assert!(
            fm.is_some(),
            "Frontmatter with unknown fields (license, metadata) should parse successfully"
        );
        let fm = fm.unwrap();
        assert_eq!(
            fm.description.unwrap(),
            "Comprehensive molecular biology toolkit."
        );
        assert_eq!(fm.name.unwrap(), "biopython");
        assert!(body.contains("# Biopython"));
    }

    #[test]
    fn test_parse_skill_frontmatter_minimal() {
        let content = "---\nname: scanpy\ndescription: scRNA-seq analysis\n---\n\n# Scanpy";
        let (fm, _body) = parse_markdown_with_frontmatter(content);
        assert!(fm.is_some());
        let fm = fm.unwrap();
        assert_eq!(fm.name.unwrap(), "scanpy");
        assert_eq!(fm.description.unwrap(), "scRNA-seq analysis");
    }

    #[test]
    fn test_parse_skill_frontmatter_with_string_allowed_tools() {
        // Some SKILL.md files have allowed-tools as a bare string, not a list
        let content = "---\nname: bgpt\ndescription: Search papers.\nallowed-tools: Bash\nlicense: MIT\n---\n\n# BGPT";
        let (fm, _body) = parse_markdown_with_frontmatter(content);
        assert!(
            fm.is_some(),
            "Frontmatter with allowed-tools as string should still parse"
        );
        let fm = fm.unwrap();
        assert_eq!(fm.description.unwrap(), "Search papers.");
    }

    #[test]
    fn test_parse_skill_frontmatter_with_space_separated_allowed_tools() {
        // e.g. "allowed-tools: Read Write Edit Bash"
        let content = "---\nname: writer\ndescription: Write stuff.\nallowed-tools: Read Write Edit Bash\n---\n\nBody";
        let (fm, _body) = parse_markdown_with_frontmatter(content);
        assert!(
            fm.is_some(),
            "Frontmatter with space-separated allowed-tools should parse"
        );
        let fm = fm.unwrap();
        assert_eq!(fm.description.unwrap(), "Write stuff.");
    }

    #[test]
    fn test_load_skills_from_dir() {
        let dir = tempfile::tempdir().unwrap();

        // Create a skill with full SKILL.md frontmatter (including extra fields)
        let skill_dir = dir.path().join("biopython");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: biopython\ndescription: Molecular biology toolkit.\nlicense: Unknown\nmetadata:\n    skill-author: Test\n---\n\n# Biopython\n\nBody.",
        )
        .unwrap();

        // Create a skill without frontmatter
        let skill_dir2 = dir.path().join("custom-tool");
        fs::create_dir_all(&skill_dir2).unwrap();
        fs::write(
            skill_dir2.join("SKILL.md"),
            "# Custom Tool\n\nA custom tool description.",
        )
        .unwrap();

        // Non-skill directory (no SKILL.md)
        let non_skill = dir.path().join("not-a-skill");
        fs::create_dir_all(&non_skill).unwrap();
        fs::write(non_skill.join("README.md"), "nothing").unwrap();

        let skills = load_skills_from_dir(dir.path(), "skill");

        assert_eq!(
            skills.len(),
            2,
            "Should find 2 skills, skip dir without SKILL.md"
        );

        let bio = skills
            .iter()
            .find(|s| s.full_command == "/biopython")
            .unwrap();
        assert_eq!(bio.name, "biopython");
        assert_eq!(
            bio.description.as_deref(),
            Some("Molecular biology toolkit.")
        );
        assert_eq!(bio.scope, "skill");
        assert!(bio.accepts_arguments);

        let custom = skills
            .iter()
            .find(|s| s.full_command == "/custom-tool")
            .unwrap();
        assert_eq!(custom.name, "Custom Tool");
        assert!(
            custom.description.is_none(),
            "No frontmatter = no description"
        );
    }

    #[test]
    fn test_creates_bundled_catalex_verify_skill_command() {
        let skill = create_builtin_skill_commands(Some("codex")).remove(0);

        assert_eq!(skill.scope, "skill");
        assert_eq!(skill.full_command, "/catalex-verify-latex");
        assert!(skill.file_path.starts_with("catalex://built-in-skills/"));
        assert!(skill.content.contains("mcp__catalex__compile"));
        assert!(skill.content.contains("mcp__catalex__render_page"));
    }

    #[tokio::test]
    async fn pi_catalog_uses_pi_skills_without_claude_commands() {
        let project = tempfile::tempdir().unwrap();
        let pi_skill = project.path().join(".pi/skills/pi-only");
        let claude_command = project.path().join(".claude/commands");
        fs::create_dir_all(&pi_skill).unwrap();
        fs::create_dir_all(&claude_command).unwrap();
        fs::write(
            pi_skill.join("SKILL.md"),
            "---\nname: Pi only\ndescription: Pi fixture\n---\nbody",
        )
        .unwrap();
        fs::write(claude_command.join("claude-only.md"), "Claude only").unwrap();
        let commands = slash_commands_list(
            Some(project.path().to_string_lossy().into()),
            Some("pi".into()),
        )
        .await
        .unwrap();
        assert!(commands
            .iter()
            .any(|command| command.full_command == "/pi-only"));
        assert!(commands
            .iter()
            .any(|command| command.full_command == "/review-document"));
        assert!(!commands
            .iter()
            .any(|command| command.full_command == "/claude-only"));
    }

    #[test]
    fn review_command_uses_shared_content_and_native_provider_syntax() {
        let codex = create_builtin_skill_commands(Some("codex")).remove(1);
        let claude = create_builtin_skill_commands(Some("claude")).remove(1);
        assert_eq!(codex.full_command, "/review-document");
        assert_eq!(claude.full_command, "/catalex:review-document");
        assert_eq!(codex.content, REVIEW_SKILL_CONTENT);
        assert_eq!(claude.content, codex.content);
    }

    #[test]
    fn test_load_recursive_skills_from_dir_includes_nested_hidden_for_codex() {
        let dir = tempfile::tempdir().unwrap();

        let system_skill = dir.path().join(".system").join("imagegen");
        fs::create_dir_all(&system_skill).unwrap();
        fs::write(
            system_skill.join("SKILL.md"),
            "---\nname: imagegen\ndescription: Generate images\n---\n\n# ImageGen",
        )
        .unwrap();

        let runtime_skill = dir.path().join("codex-primary-runtime").join("slides");
        fs::create_dir_all(&runtime_skill).unwrap();
        fs::write(
            runtime_skill.join("SKILL.md"),
            "---\nname: PowerPoint\ndescription: Work with slides\n---\n\n# PowerPoint",
        )
        .unwrap();

        let skills = load_recursive_skills_from_dir(dir.path(), "skill", true);

        assert_eq!(skills.len(), 2);
        assert!(skills.iter().any(|s| s.full_command == "/imagegen"));
        assert!(skills.iter().any(|s| s.full_command == "/slides"));
    }

    #[test]
    fn test_load_recursive_skills_from_dir_skips_hidden_when_disabled() {
        let dir = tempfile::tempdir().unwrap();

        let hidden_skill = dir.path().join(".system").join("imagegen");
        fs::create_dir_all(&hidden_skill).unwrap();
        fs::write(hidden_skill.join("SKILL.md"), "# ImageGen").unwrap();

        let visible_skill = dir.path().join("slides");
        fs::create_dir_all(&visible_skill).unwrap();
        fs::write(visible_skill.join("SKILL.md"), "# Slides").unwrap();

        let skills = load_recursive_skills_from_dir(dir.path(), "skill", false);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].full_command, "/slides");
    }

    #[test]
    fn test_merge_unique_skills_prefers_existing_command() {
        let mut commands = vec![SlashCommand {
            id: "skill-existing".to_string(),
            name: "Existing".to_string(),
            full_command: "/imagegen".to_string(),
            scope: "skill".to_string(),
            namespace: None,
            file_path: "/tmp/existing/SKILL.md".to_string(),
            content: "existing".to_string(),
            description: Some("existing".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: true,
        }];

        let duplicate = SlashCommand {
            id: "skill-duplicate".to_string(),
            name: "Duplicate".to_string(),
            full_command: "/imagegen".to_string(),
            scope: "skill".to_string(),
            namespace: None,
            file_path: "/tmp/duplicate/SKILL.md".to_string(),
            content: "duplicate".to_string(),
            description: Some("duplicate".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: true,
        };

        let unique = SlashCommand {
            id: "skill-slides".to_string(),
            name: "Slides".to_string(),
            full_command: "/slides".to_string(),
            scope: "skill".to_string(),
            namespace: None,
            file_path: "/tmp/slides/SKILL.md".to_string(),
            content: "slides".to_string(),
            description: Some("slides".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: true,
        };

        merge_unique_skills(&mut commands, vec![duplicate, unique]);

        assert_eq!(commands.len(), 2);
        assert_eq!(
            commands
                .iter()
                .filter(|command| command.full_command == "/imagegen")
                .count(),
            1
        );
        assert!(commands.iter().any(|command| command.full_command == "/slides"));
    }

    #[test]
    fn test_real_skills_dir() {
        // Test against actual installed skills if available
        let skills_dir = dirs::home_dir().unwrap().join(".claude").join("skills");
        if !skills_dir.exists() {
            eprintln!("SKIP: no skills installed at {:?}", skills_dir);
            return;
        }

        let skills = load_skills_from_dir(&skills_dir, "skill");
        eprintln!("Found {} skills", skills.len());

        let mut missing_desc = Vec::new();
        let mut missing_name = Vec::new();

        for skill in &skills {
            if skill.description.is_none() {
                missing_desc.push(skill.full_command.as_str());
            }
            if skill.name == skill.full_command.trim_start_matches('/') {
                // name fell back to folder name
                missing_name.push(skill.full_command.as_str());
            }
        }

        if !missing_desc.is_empty() {
            eprintln!("Skills WITHOUT description ({}):", missing_desc.len());
            for cmd in &missing_desc {
                eprintln!("  {}", cmd);
            }
        }
        if !missing_name.is_empty() {
            eprintln!("Skills where name == folder ({}):", missing_name.len());
            for cmd in &missing_name {
                eprintln!("  {}", cmd);
            }
        }

        // Print a few samples with descriptions
        for skill in skills.iter().take(5) {
            eprintln!(
                "  {} | name={:?} | desc={:?}",
                skill.full_command,
                skill.name,
                skill.description.as_deref().map(|d| &d[..d.len().min(60)])
            );
        }

        assert!(
            missing_desc.is_empty(),
            "{} skills missing description: {:?}",
            missing_desc.len(),
            missing_desc
        );
    }

    // --- load_command_from_file integration tests ---

    #[test]
    fn test_load_command_from_file_simple() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("greet.md");
        fs::write(
            &file,
            "Hello $ARGUMENTS, run !`echo hi` and check @main.tex",
        )
        .unwrap();

        let cmd = load_command_from_file(&file, dir.path(), "project").unwrap();
        assert_eq!(cmd.name, "greet");
        assert!(cmd.namespace.is_none());
        assert_eq!(cmd.full_command, "/greet");
        assert_eq!(cmd.scope, "project");
        assert!(cmd.accepts_arguments);
        assert!(cmd.has_bash_commands);
        assert!(cmd.has_file_references);
        assert!(cmd.description.is_none());
        assert!(cmd.allowed_tools.is_empty());
    }

    #[test]
    fn test_load_command_from_file_with_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lint.md");
        let content = "---\ndescription: Run linter\nallowed-tools:\n  - Bash\n  - Read\n---\nLint the project";
        fs::write(&file, content).unwrap();

        let cmd = load_command_from_file(&file, dir.path(), "user").unwrap();
        assert_eq!(cmd.name, "lint");
        assert_eq!(cmd.description.unwrap(), "Run linter");
        assert_eq!(cmd.allowed_tools, vec!["Bash", "Read"]);
        assert_eq!(cmd.content, "Lint the project");
    }

    #[test]
    fn test_load_command_from_file_nested_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let ns_dir = dir.path().join("tools").join("rust");
        fs::create_dir_all(&ns_dir).unwrap();
        let file = ns_dir.join("clippy.md");
        fs::write(&file, "Run clippy").unwrap();

        let cmd = load_command_from_file(&file, dir.path(), "project").unwrap();
        assert_eq!(cmd.name, "clippy");
        assert_eq!(cmd.namespace.unwrap(), "tools:rust");
        assert_eq!(cmd.full_command, "/tools:rust:clippy");
    }

    // --- find_markdown_files integration tests ---

    #[test]
    fn test_find_markdown_files_collects_md_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("cmd1.md"), "a").unwrap();
        fs::write(dir.path().join("cmd2.md"), "b").unwrap();
        fs::write(dir.path().join("notes.txt"), "c").unwrap();
        fs::write(dir.path().join("data.json"), "d").unwrap();

        let mut files = Vec::new();
        find_markdown_files(dir.path(), &mut files);

        assert_eq!(files.len(), 2);
        let names: Vec<String> = files
            .iter()
            .map(|f| f.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"cmd1.md".to_string()));
        assert!(names.contains(&"cmd2.md".to_string()));
    }

    #[test]
    fn test_find_markdown_files_skips_hidden_dirs() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("visible.md"), "ok").unwrap();
        let hidden = dir.path().join(".hidden");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("secret.md"), "hidden").unwrap();

        let mut files = Vec::new();
        find_markdown_files(dir.path(), &mut files);

        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].file_name().unwrap().to_str().unwrap(),
            "visible.md"
        );
    }

    #[test]
    fn test_find_markdown_files_recursive() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("top.md"), "top").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("nested.md"), "nested").unwrap();

        let mut files = Vec::new();
        find_markdown_files(dir.path(), &mut files);

        assert_eq!(files.len(), 2);
        let names: Vec<String> = files
            .iter()
            .map(|f| f.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"top.md".to_string()));
        assert!(names.contains(&"nested.md".to_string()));
    }

    #[tokio::test]
    async fn command_catalog_omits_legacy_defaults_for_both_providers() {
        let project = tempfile::tempdir().unwrap();
        for provider in ["claude", "codex", "pi"] {
            let commands = slash_commands_list(
                Some(project.path().to_string_lossy().into()),
                Some(provider.into()),
            )
            .await
            .unwrap();
            assert!(!commands.iter().any(|command| command.scope == "default"));
            for name in crate::builtin_skills::NAMES {
                assert!(commands
                    .iter()
                    .any(|command| command.name == *name && command.scope == "skill"));
            }
        }
    }

}
