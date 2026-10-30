//! Bounded source mapping for externally changed files. The map is shared by all
//! anchors for one old/new revision pair. Unknown replacements still need exact
//! surrounding context; a diff alone is not evidence of comment ownership.
use super::Comment;
#[cfg(test)]
use super::identity::SourceIndex;
use std::ops::Range;
use catalex_document_core::{replacement_edits, Anchor, PreparedTextChange};

pub(super) struct TextChanges {
    mapping: Result<PreparedTextChange, String>,
}

impl TextChanges {
    pub(super) fn new(old: &str, new: &str) -> Self {
        Self {
            mapping: PreparedTextChange::new(old, &replacement_edits(old, new)),
        }
    }

    pub(super) fn map_anchor(&self, comment: &Comment) -> Option<Anchor> {
        self.mapping
            .as_ref()
            .ok()?
            .map_anchor(&Anchor {
                id: comment.id.clone(),
                from: comment.from,
                to: comment.to,
                resolved: comment.resolved,
                position_reset: comment.position_reset,
                removed_anchor: comment
                    .removed_anchor
                    .clone()
                    .and_then(|value| serde_json::from_value(value).ok()),
            })
            .ok()
    }

    pub(super) fn matches_context(
        &self,
        old: &str,
        new: &str,
        range: Range<usize>,
        mapped: Range<usize>,
    ) -> bool {
        Self::context_matches(old, new, range, mapped).is_some()
    }

    fn context_matches(
        old: &str,
        new: &str,
        range: Range<usize>,
        mapped: Range<usize>,
    ) -> Option<()> {
        // Exact, Unicode-safe context around both boundaries. Document edges
        // supply a boundary only; at least one real text context is required.
        let left = old[..range.start]
            .char_indices()
            .rev()
            .nth(31)
            .map_or(0, |(i, _)| i);
        let right = old[range.end..]
            .char_indices()
            .nth(32)
            .map_or(old.len(), |(i, _)| range.end + i);
        let prefix = &old[left..range.start];
        let suffix = &old[range.end..right];
        if prefix.trim().is_empty() && suffix.trim().is_empty() {
            return None;
        }
        if prefix.is_empty() && mapped.start != 0 || suffix.is_empty() && mapped.end != new.len() {
            return None;
        }
        let start = mapped.start.checked_sub(prefix.len())?;
        let end = mapped.end.checked_add(suffix.len())?;
        if new.get(start..mapped.start)? != prefix || new.get(mapped.end..end)? != suffix {
            return None;
        }
        // A diff may span two repeated candidate passages. The combined span
        // is unique but is not evidence that either candidate owns the comment.
        // Do not bridge another copy of either boundary inside that span.
        if !prefix.is_empty()
            && new
                .get(start..mapped.end)?
                .match_indices(prefix)
                .nth(1)
                .is_some()
            || !suffix.is_empty()
                && new
                    .get(mapped.start..end)?
                    .match_indices(suffix)
                    .nth(1)
                    .is_some()
        {
            return None;
        }
        let context = new.get(start..end)?;
        let mut occurrences = new.match_indices(context);
        if occurrences.next()?.0 != start || occurrences.next().is_some() {
            return None;
        }
        Some(())
    }

    #[cfg(test)]
    fn recover(&self, old: &str, new: &str, range: Range<usize>) -> Option<Range<usize>> {
        let index = SourceIndex::new(old);
        let anchor = self
            .mapping
            .as_ref()
            .ok()?
            .map_anchor(&Anchor {
                id: "test".into(),
                from: index.position(range.start).0,
                to: index.position(range.end).0,
                resolved: false,
                position_reset: false,
                removed_anchor: None,
            })
            .ok()?;
        let index = SourceIndex::new(new);
        let mapped = index.byte_offset(anchor.from)?..index.byte_offset(anchor.to)?;
        Self::context_matches(old, new, range, mapped.clone())?;
        Some(mapped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_edits_and_deletion_with_unicode_and_crlf_context() {
        let old = "😀 Before\r\nThe selected sentence.\r\nAfter";
        let from = old.find("selected").unwrap();
        for replacement in ["updated", "", "se-expanded-lected"] {
            let new = old.replace("selected", replacement);
            let range = TextChanges::new(old, &new)
                .recover(old, &new, from..from + 8)
                .unwrap_or_else(|| panic!("replacement {replacement:?} could not be recovered"));
            assert_eq!(&new[range], replacement);
        }
    }
    #[test]
    fn rejects_unrelated_and_ambiguous_replacements() {
        let old = "Before selected After";
        assert!(TextChanges::new(old, "An unrelated document")
            .recover(old, "An unrelated document", 7..15)
            .is_none());
        let new = "Before edited After\nBefore edited After";
        assert!(TextChanges::new(old, new)
            .recover(old, new, 7..15)
            .is_none());
    }
}
