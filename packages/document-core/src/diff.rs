//! Canonical whole-file replacement edits for native and browser callers.
//! Exact editor transactions bypass this. No time-based cutoff: machine speed
//! must not change which operations (and therefore anchors) a replacement uses.
use crate::TextEdit;
use imara_diff::{Algorithm, Diff, InternedInput};
use std::ops::Range;

fn offsets(text: &str) -> Vec<usize> {
    let mut result = vec![0];
    for line in text.split_inclusive('\n') {
        result.push(result.last().unwrap() + line.len());
    }
    result
}

fn refine(
    old: &str,
    new: &str,
    mut a: Range<usize>,
    mut b: Range<usize>,
) -> Vec<(Range<usize>, Range<usize>)> {
    // Trim common edges before the character limit, including on very long
    // single lines. A one-character edit in a large line stays a small edit.
    let prefix: usize = old[a.clone()]
        .chars()
        .zip(new[b.clone()].chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum();
    a.start += prefix;
    b.start += prefix;
    let suffix: usize = old[a.clone()]
        .chars()
        .rev()
        .zip(new[b.clone()].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum();
    a.end -= suffix;
    b.end -= suffix;
    if a.is_empty() && b.is_empty() {
        return vec![];
    }
    if a.is_empty() || b.is_empty() || a.len() + b.len() > 65_536 {
        return vec![(a, b)];
    }
    let mut input = InternedInput::default();
    input.update_before(old[a.clone()].chars());
    input.update_after(new[b.clone()].chars());
    let diff = Diff::compute(Algorithm::Myers, &input);
    let ca: Vec<_> = old[a.clone()]
        .char_indices()
        .map(|(i, _)| a.start + i)
        .chain([a.end])
        .collect();
    let cb: Vec<_> = new[b.clone()]
        .char_indices()
        .map(|(i, _)| b.start + i)
        .chain([b.end])
        .collect();
    diff.hunks()
        .map(|hunk| {
            (
                ca[hunk.before.start as usize]..ca[hunk.before.end as usize],
                cb[hunk.after.start as usize]..cb[hunk.after.end as usize],
            )
        })
        .collect()
}

/// Shared deterministic diff with heuristic fallbacks for repetitive input and
/// bounded character refinement. A diff describes geometry, not file identity;
/// unknown external replacements still require the caller's context checks.
pub fn replacement_edits(old: &str, new: &str) -> Vec<TextEdit> {
    if old == new {
        return vec![];
    }
    let input = InternedInput::new(old, new);
    let diff = Diff::compute(Algorithm::Histogram, &input);
    let a = offsets(old);
    let b = offsets(new);
    let mut edits = Vec::new();
    let mut byte = 0;
    let mut position = 0;
    for hunk in diff.hunks() {
        let ranges = refine(
            old,
            new,
            a[hunk.before.start as usize]..a[hunk.before.end as usize],
            b[hunk.after.start as usize]..b[hunk.after.end as usize],
        );
        for (a, b) in ranges {
            position += old[byte..a.start].encode_utf16().count();
            let from = position;
            position += old[a.clone()].encode_utf16().count();
            byte = a.end;
            edits.push(TextEdit {
                from,
                to: position,
                insert: new[b].to_owned(),
            });
        }
    }
    edits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Document, Operation, Update};

    fn check(old: &str, new: &str) -> Vec<TextEdit> {
        let edits = replacement_edits(old, new);
        let result = Document {
            text: old.into(),
            revision: 0,
            anchors: vec![],
        }
        .apply(&Update {
            expected_revision: 0,
            operations: vec![Operation::Text {
                edits: edits.clone(),
            }],
        })
        .unwrap();
        assert_eq!(result.text, new);
        edits
    }

    #[test]
    fn roundtrips_unicode_newlines_and_repeated_text() {
        let values = [
            "",
            "\n",
            "\r\n",
            "😀",
            "a😀b\r\nc",
            "same\nsame\nend",
            "same\nother\nsame\nend\n",
            "before selected after",
            "before changed after",
        ];
        for old in values {
            for new in values {
                check(old, new);
            }
        }
    }

    #[test]
    fn preserves_small_changes_in_large_files_and_long_lines() {
        let old = "😀 same line\n".repeat(20_000);
        let new = format!("prefix\n{old}suffix");
        assert_eq!(check(&old, &new).len(), 2);
        let old = "long paragraph ".repeat(100_000);
        let mut new = old.clone();
        new.insert(500_000, '✨');
        let edits = check(&old, &new);
        assert_eq!(
            edits,
            vec![TextEdit {
                from: 500_000,
                to: 500_000,
                insert: "✨".into()
            }]
        );
    }
}
