//! Comments an agent asked to resolve once its draft change is accepted. They
//! are kept with the draft, so discarding the draft discards them too.
use super::*;

const FILE: &str = "comment-resolutions.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingResolution {
    pub file_path: String,
    pub id: String,
    /// Comment text when the agent decided. A comment the user changes later is left alone.
    pub text: String,
    /// The draft's file and its content digest when the agent's turn ended.
    /// Absent while the agent is working, or when the draft does not change the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<String>,
}

pub(crate) fn read(session: &Path) -> Vec<PendingResolution> {
    fs::read(session.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub(crate) fn write(session: &Path, items: &[PendingResolution]) -> Result<(), String> {
    let path = session.join(FILE);
    if items.is_empty() {
        return match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    }
    crate::project_files::replace_file(&path, &serde_json::to_vec(items).map_err(|e| e.to_string())?)
}

/// `text` records a new or updated request; `None` withdraws it.
pub(crate) fn set(session: &Path, file_path: &str, id: &str, text: Option<&str>) -> Result<(), String> {
    let mut items = read(session);
    let before = items.len();
    items.retain(|item| item.id != id);
    if let Some(text) = text {
        items.push(PendingResolution {
            file_path: file_path.into(),
            id: id.into(),
            text: text.into(),
            candidate_path: None,
            proposal: None,
        });
    } else if items.len() == before {
        return Ok(());
    }
    write(session, &items)
}

/// Resolves the comments whose change was accepted. A comment that was edited,
/// resolved, or deleted in the meantime keeps the state its last editor gave it.
pub(crate) fn resolve(root: &Path, storage: &Path, items: &[PendingResolution]) -> Vec<CommentPatch> {
    let mut patches = Vec::new();
    for item in items {
        // An accepted rename has already moved the comment to the draft's path.
        let path = item.candidate_path.as_ref().unwrap_or(&item.file_path);
        let result = store::transaction(storage, |db| {
            let sides = identity::load_for_write_on(root, storage, db, [(path.clone(), Some(item.id.clone()))])?;
            let found = sides.iter().flat_map(|side| &side.files).find_map(|(file, comments)| {
                comments.iter().find(|comment| comment.id == item.id).map(|comment| (file.clone(), comment.clone()))
            });
            let Some((file_path, before)) = found.filter(|(_, comment)| !comment.resolved && comment.text == item.text) else {
                return Ok(None);
            };
            let mut after = before.clone();
            after.resolved = true;
            let patch = CommentPatch { file_path, id: item.id.clone(), before: Some(before), after: Some(after) };
            apply_patch_on(root, db, &patch, false, None, sides).map(Some)
        });
        match result {
            Ok(Some(patch)) => patches.push(patch),
            Ok(None) => {}
            Err(error) => eprintln!("[comments] could not resolve an accepted comment: {error}"),
        }
    }
    patches
}
