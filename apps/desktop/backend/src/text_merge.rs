//! Git's text merge engine shared by private drafts and project Git conflicts.
use git2::{IndexEntry, IndexTime, Oid, Repository};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConflictSegment {
    Resolved {
        content: String,
    },
    Conflict {
        ancestor: String,
        current: String,
        agent: String,
    },
}

fn entry(path: &str, oid: Oid, size: usize) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        file_size: size.min(u32::MAX as usize) as u32,
        id: oid,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

pub(crate) fn merge(
    repo: &Repository,
    base: &[u8],
    current: &[u8],
    proposed: &[u8],
) -> Result<(Vec<u8>, Vec<ConflictSegment>), String> {
    let make = |bytes: &[u8]| -> Result<IndexEntry, String> {
        Ok(entry(
            "draft",
            repo.blob(bytes).map_err(|e| e.to_string())?,
            bytes.len(),
        ))
    };
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut options = git2::MergeFileOptions::new();
    options
        .style_zdiff3(true)
        .marker_size(32)
        .ancestor_label(format!("base-{nonce}"))
        .our_label(format!("current-{nonce}"))
        .their_label(format!("agent-{nonce}"));
    let result = repo
        .merge_file_from_index(
            &make(base)?,
            &make(current)?,
            &make(proposed)?,
            Some(&mut options),
        )
        .map_err(|e| e.to_string())?;
    if result.is_automergeable() {
        return Ok((result.content().to_vec(), Vec::new()));
    }
    let text = std::str::from_utf8(result.content())
        .map_err(|_| "Binary merge needs whole-file resolution")?;
    let start_marker = format!("{} current-{nonce}", "<".repeat(32));
    let eol = if text.contains(&format!("{start_marker}\r\n")) {
        "\r\n"
    } else {
        "\n"
    };
    let begin = format!("{start_marker}{eol}");
    let ancestor = format!("{} base-{nonce}{eol}", "|".repeat(32));
    let divider = format!("{}{eol}", "=".repeat(32));
    let end = format!("{} agent-{nonce}", ">".repeat(32));
    let mut segments = Vec::new();
    let mut rest = text;
    while let Some((clean, conflict)) = rest.split_once(&begin) {
        if !clean.is_empty() {
            segments.push(ConflictSegment::Resolved {
                content: clean.into(),
            });
        }
        let (ours, conflict) = conflict
            .split_once(&ancestor)
            .ok_or("Invalid Git conflict ancestor")?;
        let (base, conflict) = conflict
            .split_once(&divider)
            .ok_or("Invalid Git conflict separator")?;
        let (theirs, tail) = conflict
            .split_once(&end)
            .ok_or("Invalid Git conflict ending")?;
        segments.push(ConflictSegment::Conflict {
            ancestor: base.into(),
            current: ours.into(),
            agent: theirs.into(),
        });
        rest = tail.strip_prefix(eol).unwrap_or(tail);
    }
    if !rest.is_empty() {
        segments.push(ConflictSegment::Resolved {
            content: rest.into(),
        });
    }
    if !segments
        .iter()
        .any(|s| matches!(s, ConflictSegment::Conflict { .. }))
    {
        return Err("Git did not produce readable conflict sections".into());
    }
    Ok((result.content().to_vec(), segments))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_complex_fixtures_match_native_git_merge() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/renderer/dev/harnesses/agent-three-way-fixtures.json"
        ))
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init_bare(directory.path()).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let (_, segments) = merge(
                &repo,
                fixture["base"].as_str().unwrap().as_bytes(),
                fixture["current"].as_str().unwrap().as_bytes(),
                fixture["agent"].as_str().unwrap().as_bytes(),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(segments).unwrap(),
                fixture["segments"],
                "Browser fixture {} must reflect the actual native merge",
                fixture["id"]
            );
        }
    }
}
