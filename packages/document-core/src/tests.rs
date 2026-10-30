use super::*;

fn doc() -> Document {
    Document {
        revision: 4,
        text: "😀 Before\r\nselected text\r\nAfter".into(),
        anchors: vec![Anchor {
            id: "a".into(),
            from: 11,
            to: 24,
            resolved: true,
            position_reset: false,
            removed_anchor: None,
        }],
    }
}

fn edit(document: &Document, from: usize, to: usize, insert: &str) -> Document {
    document
        .apply(&Update {
            expected_revision: document.revision,
            operations: vec![Operation::Text {
                edits: vec![TextEdit {
                    from,
                    to,
                    insert: insert.into(),
                }],
            }],
        })
        .unwrap()
}

#[test]
fn text_and_resolved_anchor_advance_together() {
    let before = doc();
    let after = edit(&before, 0, 0, "intro\n");
    assert_eq!(after.revision, 5);
    assert_eq!(after.text, format!("intro\n{}", before.text));
    assert_eq!((after.anchors[0].from, after.anchors[0].to), (17, 30));
    assert!(after.anchors[0].resolved);
    assert_eq!(before.revision, 4);
}

#[test]
fn deleting_and_reinserting_enclosing_text_restores_selection() {
    let before = doc();
    let after = edit(&before, 0, before.text.encode_utf16().count(), "");
    assert_eq!((after.anchors[0].from, after.anchors[0].to), (0, 0));
    assert!(after.anchors[0].position_reset);
    let restored = edit(&after, 0, 0, &before.text);
    assert_eq!(restored.anchors, before.anchors);
}

#[test]
fn selection_loss_and_replacement_have_the_same_rules_for_every_caller() {
    let before = doc();
    let selected = &before.anchors[0];
    let deleted = edit(&before, selected.from, selected.to, "");
    assert!(deleted.anchors[0].position_reset);
    assert_eq!(deleted.anchors[0].from, deleted.anchors[0].to);
    assert!(deleted.anchors[0].resolved);
    let shifted = edit(&deleted, 0, 0, "prefix ");
    assert!(shifted.anchors[0].position_reset);
    assert_eq!(shifted.anchors[0].from, deleted.anchors[0].from + 7);
    let replacement = edit(&before, selected.from, selected.to, "new selection");
    assert!(!replacement.anchors[0].position_reset);
    assert!(replacement.anchors[0].from < replacement.anchors[0].to);
    let mut point = before;
    point.anchors[0].to = point.anchors[0].from;
    assert!(!edit(&point, 0, 0, "prefix ").anchors[0].position_reset);
}

#[test]
fn large_deletion_recovery_is_bounded_and_requires_exact_reinsertion() {
    let before = Document {
        revision: 0,
        text: format!("😀{}😀", "x".repeat(1_000_000)),
        anchors: (0..1000)
            .map(|i| Anchor {
                id: i.to_string(),
                from: 2 + i * 900,
                to: 10 + i * 900,
                resolved: i % 2 == 0,
                position_reset: false,
                removed_anchor: None,
            })
            .collect(),
    };
    let deleted = edit(&before, 0, before.text.encode_utf16().count(), "");
    let wire = serde_json::to_vec(&deleted).unwrap();
    // Previously this payload exceeded 1 GB for a single deletion.
    assert!(wire.len() < 300_000, "{} bytes", wire.len());
    assert!(deleted.anchors[0]
        .removed_anchor
        .as_ref()
        .unwrap()
        .text
        .is_none());
    let reopened: Document = serde_json::from_slice(&wire).unwrap();
    let other = before.text.replacen('x', "y", 1);
    let unmatched = edit(&reopened, 0, 0, &other);
    assert!(unmatched
        .anchors
        .iter()
        .all(|a| a.from == a.to && a.removed_anchor.is_some()));
    let restored = edit(&reopened, 0, 0, &before.text);
    assert_eq!(restored.anchors, before.anchors);
}

#[test]
fn malformed_recovery_fingerprints_are_rejected() {
    let mut before = doc();
    before.anchors[0].removed_anchor = Some(RemovedAnchor {
        text: None,
        sha256: Some("bad".into()),
        length: Some(100),
        from: 0,
        to: 4,
    });
    assert!(before.validate().is_err());
}

#[test]
fn stale_or_invalid_batch_does_not_mutate_the_document() {
    let before = doc();
    let saved = before.clone();
    assert!(before
        .apply(&Update {
            expected_revision: 3,
            operations: vec![]
        })
        .is_err());
    let update = Update {
        expected_revision: 4,
        operations: vec![
            Operation::Resolve {
                id: "a".into(),
                resolved: false,
            },
            Operation::Text {
                edits: vec![TextEdit {
                    from: 1,
                    to: 1,
                    insert: "bad surrogate boundary".into(),
                }],
            },
        ],
    };
    assert!(before.apply(&update).is_err());
    assert_eq!(before, saved);
}

#[test]
fn comment_operations_use_the_same_revision() {
    let before = doc();
    let after = before
        .apply(&Update {
            expected_revision: 4,
            operations: vec![Operation::Resolve {
                id: "a".into(),
                resolved: false,
            }],
        })
        .unwrap();
    assert_eq!(after.revision, 5);
    assert!(!after.anchors[0].resolved);
    let deleted = after
        .apply(&Update {
            expected_revision: 5,
            operations: vec![Operation::RemoveAnchor { id: "a".into() }],
        })
        .unwrap();
    assert!(deleted.anchors.is_empty());
    assert_eq!(deleted.text, before.text);
    assert_eq!(deleted.revision, 6);
}

#[test]
fn no_op_preserves_revision_and_duplicates_are_rejected() {
    let before = doc();
    assert_eq!(edit(&before, 0, 0, ""), before);
    let mut duplicate = before.clone();
    duplicate.anchors.push(duplicate.anchors[0].clone());
    assert!(duplicate.validate().is_err());
}

#[test]
fn disk_line_endings_are_separate_from_document_coordinates() {
    for ending in ["\n", "\r\n", "\r"] {
        let raw = format!("😀 first{ending}selected{ending}");
        let normalized = normalize_document_text(&raw);
        assert_eq!(normalized, "😀 first\nselected\n");
        assert_eq!(
            encode_document_text(&normalized.replace("selected", "edited"), &raw),
            format!("😀 first{ending}edited{ending}")
        );
    }
}
