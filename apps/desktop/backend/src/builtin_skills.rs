use crate::branding::PRODUCT_NAME;
use std::path::{Path, PathBuf};
use crate::host::WindowContext;

pub const NAMES: &[&str] = &["catalex-verify-latex", "review-document"];

fn complete(root: &Path) -> bool {
    NAMES
        .iter()
        .all(|name| root.join("skills").join(name).join("SKILL.md").is_file())
}

// One resource tree: Codex loads skills/, Claude loads its parent as a plugin.
pub fn resolve_root(window: &WindowContext) -> Result<PathBuf, String> {
    resolve_root_from_resource_dir(&window.service.resource_dir)
}

pub(crate) fn resolve_root_from_resource_dir(resource_dir: &Path) -> Result<PathBuf, String> {
    // Dev builds can retain removed resources. Never load their stale copies.
    #[cfg(debug_assertions)]
    let root = {
        let _ = resource_dir;
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(crate::branding::NAMESPACE)
    };
    #[cfg(not(debug_assertions))]
    let root = resource_dir.join(crate::branding::NAMESPACE);
    if let Some(marker) = root
        .ancestors()
        .map(|parent| parent.join(".claude-plugin/plugin.json"))
        .find(|marker| marker.is_file())
    {
        return Err(format!(
            "{PRODUCT_NAME}'s standalone skills are inside a Claude plugin at {}. Codex cannot discover them. Remove the obsolete build artifact or reinstall {PRODUCT_NAME}.",
            marker.display()
        ));
    }
    if complete(&root) {
        return Ok(root);
    }
    Err(format!(
        "{PRODUCT_NAME}'s built-in skills are missing or incomplete in {}.",
        root.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_providers_share_the_packaged_skill_tree() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(crate::branding::NAMESPACE);
        assert!(complete(&root));
        // Claude infers the namespace from this directory; a plugin manifest
        // would make Codex exclude these files from standalone skill discovery.
        assert_eq!(root.file_name().unwrap(), "catalex");
        assert!(root
            .ancestors()
            .all(|parent| !parent.join(".claude-plugin/plugin.json").is_file()));
        assert!(!complete(&root.join("skills")));
    }

    #[test]
    #[cfg(debug_assertions)]
    fn development_ignores_stale_bundled_resources() {
        let stale = tempfile::tempdir().unwrap();
        for name in NAMES {
            let dir = stale.path().join("catalex/skills").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), "stale copy").unwrap();
        }
        std::fs::create_dir(stale.path().join(".claude-plugin")).unwrap();
        std::fs::write(stale.path().join(".claude-plugin/plugin.json"), "{}").unwrap();
        assert!(complete(&stale.path().join("catalex")));
        assert_eq!(
            resolve_root_from_resource_dir(stale.path()).unwrap(),
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(crate::branding::NAMESPACE)
        );
    }
}
