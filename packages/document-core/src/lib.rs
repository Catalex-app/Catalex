//! Platform-independent document operations. Offsets are UTF-16 code units in
//! both native and browser callers. No filesystem, database, UI, or clock access.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::{Arc, OnceLock},
};

mod diff;
pub use diff::replacement_edits;

/// Coordinate text shared by editor and native comment sources. Physical file
/// bytes are retained separately by filesystem save/conflict handling.
pub fn normalize_document_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Encode editor text with the first line ending in the physical file.
pub fn encode_document_text(text: &str, disk: &str) -> String {
    let normalized = normalize_document_text(text);
    let ending = disk
        .find(['\r', '\n'])
        .map(|offset| {
            if disk[offset..].starts_with("\r\n") {
                "\r\n"
            } else if disk.as_bytes()[offset] == b'\r' {
                "\r"
            } else {
                "\n"
            }
        })
        .unwrap_or("\n");
    if ending == "\n" {
        normalized
    } else {
        normalized.replace('\n', ending)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovedAnchor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<usize>,
    pub from: usize,
    pub to: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Anchor {
    pub id: String,
    pub from: usize,
    pub to: usize,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub position_reset: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_anchor: Option<RemovedAnchor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub revision: u64,
    pub text: String,
    pub anchors: Vec<Anchor>,
}

/// Keep editor coordinates in their native UTF-16 representation between edits.
/// String conversion belongs at open/save boundaries, not every keystroke.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocumentModel {
    pub revision: u64,
    text: Arc<[u16]>,
    pub anchors: Vec<Anchor>,
}

/// Edits in a single Text operation refer to the same input document. They must
/// be ordered and non-overlapping. Sequential edits use separate operations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextEdit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Text { edits: Vec<TextEdit> },
    PutAnchor { anchor: Anchor },
    RemoveAnchor { id: String },
    Resolve { id: String, resolved: bool },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub expected_revision: u64,
    pub operations: Vec<Operation>,
}

fn boundary(text: &[u16], position: usize) -> bool {
    position <= text.len()
        && !(position > 0
            && position < text.len()
            && (0xd800..=0xdbff).contains(&text[position - 1])
            && (0xdc00..=0xdfff).contains(&text[position]))
}

fn validate_anchor(anchor: &Anchor, text: &[u16]) -> Result<(), String> {
    if anchor.id.is_empty()
        || anchor.from > anchor.to
        || !boundary(text, anchor.from)
        || !boundary(text, anchor.to)
    {
        return Err("Invalid comment anchor".into());
    }
    if let Some(removed) = &anchor.removed_anchor {
        let valid = match (&removed.text, &removed.sha256, removed.length) {
            (Some(text), None, None) => {
                let text: Vec<_> = text.encode_utf16().collect();
                boundary(&text, removed.from) && boundary(&text, removed.to)
            }
            (None, Some(hash), Some(length)) => {
                hash.len() == 64
                    && hash.bytes().all(|b| b.is_ascii_hexdigit())
                    && removed.to <= length
            }
            _ => false,
        };
        if removed.from > removed.to || !valid {
            return Err("Invalid removed comment anchor".into());
        }
    }
    Ok(())
}

struct Change {
    from: usize,
    to: usize,
    next_from: usize,
    next_to: usize,
    removed_hash: OnceLock<String>,
    inserted_hash: OnceLock<String>,
}

// Recovery data must not duplicate a large deleted manuscript per comment.
// Hash UTF-16LE in bounded chunks, identically on every native/WASM platform.
const INLINE_REMOVED_LIMIT: usize = 4096;
fn text_hash(text: &[u16]) -> String {
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 2048];
    for chunk in text.chunks(1024) {
        for (index, unit) in chunk.iter().enumerate() {
            bytes[index * 2..index * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
        hash.update(&bytes[..chunk.len() * 2]);
    }
    format!("{:x}", hash.finalize())
}

fn map_position(position: usize, after: bool, changes: &[Change]) -> usize {
    let mut old_end = 0;
    let mut new_end = 0;
    for change in changes {
        if position < change.from {
            break;
        }
        if position < change.to || position == change.to && change.from == change.to && !after {
            return if change.from == change.to || position > change.from && position < change.to {
                if after {
                    change.next_to
                } else {
                    change.next_from
                }
            } else if position == change.from {
                change.next_from
            } else {
                change.next_to
            };
        }
        old_end = change.to;
        new_end = change.next_to;
    }
    new_end + (position - old_end)
}

/// Prepared once for a source revision pair, then reused for every anchor.
/// Document updates and native file recovery use these exact mapping rules.
pub struct PreparedTextChange {
    previous: Arc<[u16]>,
    next: Arc<[u16]>,
    changes: Vec<Change>,
}

impl PreparedTextChange {
    pub fn new(previous: &str, edits: &[TextEdit]) -> Result<Self, String> {
        Self::prepare(previous.encode_utf16().collect::<Vec<_>>().into(), edits)
    }

    fn prepare(previous: Arc<[u16]>, edits: &[TextEdit]) -> Result<Self, String> {
        let mut next = Vec::with_capacity(previous.len());
        let mut cursor = 0;
        let mut changes = Vec::with_capacity(edits.len());
        for edit in edits {
            if edit.from < cursor
                || edit.from > edit.to
                || !boundary(&previous, edit.from)
                || !boundary(&previous, edit.to)
                || changes.last().is_some_and(|c: &Change| c.from == edit.from)
            {
                return Err("Invalid or overlapping text edits".into());
            }
            next.extend_from_slice(&previous[cursor..edit.from]);
            let next_from = next.len();
            next.extend(edit.insert.encode_utf16());
            changes.push(Change {
                from: edit.from,
                to: edit.to,
                next_from,
                next_to: next.len(),
                removed_hash: OnceLock::new(),
                inserted_hash: OnceLock::new(),
            });
            cursor = edit.to;
        }
        next.extend_from_slice(&previous[cursor..]);
        Ok(Self {
            previous,
            next: next.into(),
            changes,
        })
    }

    pub fn map_anchor(&self, anchor: &Anchor) -> Result<Anchor, String> {
        validate_anchor(anchor, &self.previous)?;
        let mut anchor = anchor.clone();
        let previous = &self.previous;
        let next = &self.next;
        let changes = &self.changes;
        let mut removed_at = None;
        let mut restored = None;
        for change in changes {
            if anchor.from == anchor.to && change.from == change.to && change.from == anchor.from {
                if let Some(removed) = &anchor.removed_anchor {
                    let inserted = &next[change.next_from..change.next_to];
                    let matches = match (&removed.text, &removed.sha256, removed.length) {
                        (Some(text), None, None) => {
                            inserted.iter().copied().eq(text.encode_utf16())
                        }
                        (None, Some(hash), Some(length)) => {
                            length == inserted.len()
                                && change.inserted_hash.get_or_init(|| text_hash(inserted)) == hash
                        }
                        _ => false,
                    };
                    if matches && boundary(inserted, removed.from) && boundary(inserted, removed.to)
                    {
                        restored = Some((
                            change.next_from + removed.from,
                            change.next_from + removed.to,
                        ));
                    }
                }
            }
            if anchor.from < anchor.to && change.from <= anchor.from && change.to >= anchor.to {
                if change.next_from == change.next_to {
                    let deleted = &previous[change.from..change.to];
                    let large = deleted.len() > INLINE_REMOVED_LIMIT;
                    anchor.removed_anchor = Some(RemovedAnchor {
                        text: if large {
                            None
                        } else {
                            Some(String::from_utf16(deleted).map_err(|e| e.to_string())?)
                        },
                        sha256: large.then(|| {
                            change
                                .removed_hash
                                .get_or_init(|| text_hash(deleted))
                                .clone()
                        }),
                        length: large.then_some(deleted.len()),
                        from: anchor.from - change.from,
                        to: anchor.to - change.from,
                    });
                }
                if change.from < anchor.from || change.to > anchor.to {
                    removed_at = Some(change.next_from);
                }
            }
        }
        if let Some((from, to)) = restored {
            anchor.from = from;
            anchor.to = to;
            anchor.position_reset = false;
            anchor.removed_anchor = None;
        } else {
            let had_selection = anchor.from < anchor.to;
            let from = removed_at.unwrap_or_else(|| map_position(anchor.from, true, changes));
            let to = if removed_at.is_some() || anchor.from == anchor.to {
                from
            } else {
                map_position(anchor.to, false, changes)
            };
            anchor.from = from.min(to);
            anchor.to = from.max(to);
            if had_selection && anchor.from == anchor.to {
                anchor.position_reset = true;
            }
        }
        validate_anchor(&anchor, next)?;
        Ok(anchor)
    }
}

fn apply_text(document: &mut DocumentModel, edits: &[TextEdit]) -> Result<(), String> {
    if edits.is_empty() {
        return Ok(());
    }
    let mapping = PreparedTextChange::prepare(document.text.clone(), edits)?;
    document.anchors = document
        .anchors
        .iter()
        .map(|a| mapping.map_anchor(a))
        .collect::<Result<_, _>>()?;
    document.text = mapping.next;
    Ok(())
}

impl DocumentModel {
    pub fn open(document: Document) -> Result<Self, String> {
        let model = Self {
            revision: document.revision,
            text: document.text.encode_utf16().collect::<Vec<_>>().into(),
            anchors: document.anchors,
        };
        model.validate()?;
        Ok(model)
    }

    pub fn snapshot(&self) -> Result<Document, String> {
        Ok(Document {
            revision: self.revision,
            text: String::from_utf16(&self.text).map_err(|e| e.to_string())?,
            anchors: self.anchors.clone(),
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        let mut ids = BTreeSet::new();
        for anchor in &self.anchors {
            validate_anchor(anchor, &self.text)?;
            if !ids.insert(&anchor.id) {
                return Err("Duplicate comment ID".into());
            }
        }
        Ok(())
    }

    /// Produce a complete next state or an error. The input is never partially
    /// mutated, including when a later operation in the batch is invalid.
    pub fn apply(&self, update: &Update) -> Result<Self, String> {
        if self.revision != update.expected_revision {
            return Err("Stale document revision".into());
        }
        self.validate()?;
        let mut next = self.clone();
        for operation in &update.operations {
            match operation {
                Operation::Text { edits } => apply_text(&mut next, edits)?,
                Operation::PutAnchor { anchor } => {
                    validate_anchor(anchor, &next.text)?;
                    if let Some(current) = next.anchors.iter_mut().find(|a| a.id == anchor.id) {
                        *current = anchor.clone();
                    } else {
                        next.anchors.push(anchor.clone());
                    }
                }
                Operation::RemoveAnchor { id } => next.anchors.retain(|a| &a.id != id),
                Operation::Resolve { id, resolved } => {
                    let anchor = next
                        .anchors
                        .iter_mut()
                        .find(|a| &a.id == id)
                        .ok_or("Comment anchor does not exist")?;
                    anchor.resolved = *resolved;
                }
            }
        }
        next.validate()?;
        if next != *self {
            next.revision = self
                .revision
                .checked_add(1)
                .ok_or("Document revision exhausted")?;
        }
        Ok(next)
    }
}

impl Document {
    pub fn validate(&self) -> Result<(), String> {
        DocumentModel::open(self.clone()).map(|_| ())
    }

    pub fn apply(&self, update: &Update) -> Result<Self, String> {
        DocumentModel::open(self.clone())?.apply(update)?.snapshot()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    document: Document,
    update: Update,
}

/// The prototype wire boundary is deliberately small. Production adapters must
/// retain author/proposal/message metadata outside this geometry-only payload.
pub fn apply_json(input: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice::<Request>(input)
        .map_err(|e| e.to_string())
        .and_then(|request| request.document.apply(&request.update));
    serde_json::to_vec(&result)
        .unwrap_or_else(|_| br#"{"Err":"Could not encode document"}"#.to_vec())
}

pub fn diff_json(input: &[u8]) -> Vec<u8> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Replacement {
        before: String,
        after: String,
    }
    let result = serde_json::from_slice::<Replacement>(input)
        .map(|value| replacement_edits(&value.before, &value.after))
        .map_err(|error| error.to_string());
    serde_json::to_vec(&result).unwrap_or_else(|_| br#"{"Err":"Could not encode edits"}"#.to_vec())
}

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(test)]
mod tests;
