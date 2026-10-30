use super::*;
use tempfile::TempDir;

fn side(id: &str, path: &str, source: &str) -> AuthorSnapshot {
    let rev = format!("{:x}", Sha1::digest(source.as_bytes()));
    serde_json::from_value(json!({"version":1,"counter":1,"files":{path:[{"id":id,"number":1,"from":0,"to":4,"line":1,"text":"Keep","anchorRevision":rev}]},"revisions":{path:[rev]},"sources":{rev:source}})).unwrap()
}
fn count(storage: &Path, collection: &str) -> u64 {
    transaction(storage, |db| {
        db.collection::<Document>(collection)
            .count_documents()
            .map_err(error)
    })
    .unwrap()
}
#[test]
fn overleaf_records_round_trip_and_anchor_writes_do_not_rewrite_messages() {
    let dir = TempDir::new().unwrap();
    let mut human = side("H-1", "a.tex", "text");
    let mut sibling = human.files["a.tex"][0].clone();
    sibling.id = "H-2".into();
    sibling.number = Some(2);
    human.counter = 2;
    human.files.get_mut("a.tex").unwrap().push(sibling);
    write(dir.path(), &[(false, &human)], &[]).unwrap();
    let before = transaction(dir.path(), |db| all::<Document>(db, "messages", doc! {})).unwrap();
    human.files.get_mut("a.tex").unwrap()[0].from = 1;
    transaction(dir.path(), |db| write_anchors_on(db, &[(false, &human)])).unwrap();
    assert_eq!(
        transaction(dir.path(), |db| all::<Document>(db, "messages", doc! {})).unwrap(),
        before
    );
    transaction(dir.path(), |db| {
        let d = all::<Doc>(db, "docs", doc! {})?.remove(0);
        assert_eq!(d.ranges.comments[0].op.p, 1);
        assert_eq!(d.ranges.comments[0].op.c, "ext");
        assert_eq!(d.ranges.comments[0].op.t, thread_id(false, "H-1").to_hex());
        let r = one::<Room>(db, "rooms", doc! {"_id":thread_id(false,"H-1")})?.unwrap();
        assert_eq!(r.project_id, d.project_id);
        let m = one::<Message>(db, "messages", doc! {"_id":r.id})?.unwrap();
        assert_eq!(m.room_id, r.id);
        assert_eq!(m.content, "Keep");
        Ok(())
    })
    .unwrap();
    let loaded = read(dir.path(), false, None).unwrap();
    assert_eq!(loaded.files, human.files);
}
#[test]
fn editing_one_comment_preserves_sibling_message_and_range() {
    let dir = TempDir::new().unwrap();
    let mut human = side("H-1", "a.tex", "text");
    let mut other = human.files["a.tex"][0].clone();
    other.id = "H-2".into();
    other.number = Some(2);
    human.counter = 2;
    human.files.get_mut("a.tex").unwrap().push(other);
    write(dir.path(), &[(false, &human)], &[]).unwrap();
    let before = transaction(dir.path(), |db| {
        one::<Message>(db, "messages", doc! {"_id":thread_id(false,"H-2")})
    })
    .unwrap();
    transaction(dir.path(), |db| {
        let mut loaded = read_author(db, false, Some(&BTreeSet::from(["a.tex".into()])))?;
        let before = loaded.files["a.tex"][0].clone();
        let mut after = before.clone();
        after.text = "Edited".into();
        loaded.files.get_mut("a.tex").unwrap()[0] = after.clone();
        write_change(
            db,
            false,
            &loaded,
            &CommentPatch {
                id: before.id.clone(),
                file_path: "a.tex".into(),
                before: Some(before),
                after: Some(after),
            },
        )
    })
    .unwrap();
    assert_eq!(
        transaction(dir.path(), |db| one::<Message>(
            db,
            "messages",
            doc! {"_id":thread_id(false,"H-2")}
        ))
        .unwrap(),
        before
    );
    assert_eq!(
        read(dir.path(), false, None).unwrap().files["a.tex"][0].text,
        "Edited"
    );
}
#[test]
fn concurrent_transactions_read_latest_committed_value() {
    let dir = TempDir::new().unwrap();
    write(dir.path(), &[(false, &side("H-1", "a.tex", "text"))], &[]).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    std::thread::scope(|threads| {
        for _ in 0..8 {
            let barrier = barrier.clone();
            let storage = dir.path();
            threads.spawn(move || {
                barrier.wait();
                for _ in 0..10 {
                    transaction(storage, |db| {
                        let mut side = read_author(db, false, Some(&BTreeSet::new()))?;
                        side.counter += 1;
                        write_on(db, &[(false, &side)], &[])
                    })
                    .unwrap();
                }
            });
        }
    });
    assert_eq!(read(dir.path(), false, None).unwrap().counter, 81);
}
#[test]
fn scoped_cleanup_and_shared_sources_preserve_other_authors_and_files() {
    let dir = TempDir::new().unwrap();
    let mut human = side("H-1", "a.tex", "text");
    let other = side("H-2", "b.tex", "text");
    human.files.extend(other.files);
    human.revisions.extend(other.revisions);
    let agent = side("A-1", "a.tex", "text");
    write(dir.path(), &[(false, &human), (true, &agent)], &[]).unwrap();
    assert_eq!(count(dir.path(), "docs"), 2);
    assert_eq!(count(dir.path(), "snapshots"), 1);
    let mut changed = side("H-1", "a.tex", "next");
    changed.scope = Some(BTreeSet::from(["a.tex".into()]));
    write(dir.path(), &[(false, &changed)], &[]).unwrap();
    assert_eq!(count(dir.path(), "snapshots"), 2);
    changed.files.clear();
    changed.revisions.clear();
    changed.sources.clear();
    write(dir.path(), &[(false, &changed)], &[]).unwrap();
    assert_eq!(count(dir.path(), "snapshots"), 1);
    assert_eq!(
        read(dir.path(), false, None).unwrap().files["b.tex"][0].id,
        "H-2"
    );
    clear(dir.path(), false).unwrap();
    assert_eq!(count(dir.path(), "snapshots"), 1);
    clear(dir.path(), true).unwrap();
    assert_eq!(count(dir.path(), "snapshots"), 0);
}
#[test]
fn transaction_failure_rolls_back_both_authors_sources_and_jobs() {
    let dir = TempDir::new().unwrap();
    let mut h = side("H-1", "a.tex", "text");
    let mut a = side("A-1", "a.tex", "text");
    write(dir.path(), &[(false, &h), (true, &a)], &[]).unwrap();
    let before = export(dir.path(), false).unwrap();
    h.files.get_mut("a.tex").unwrap()[0].text = "Changed human".into();
    a.files.get_mut("a.tex").unwrap()[0].text = "Changed agent".into();
    h.sources.insert("new".into(), "new source".into());
    let result: Result<(), String> = transaction(dir.path(), |db| {
        write_on(db, &[(false, &h), (true, &a)], &["pending.json".into()])?;
        Err("injected failure before commit".into())
    });
    assert!(result.is_err());
    assert_eq!(export(dir.path(), false).unwrap(), before);
    assert!(pending_cleanup(dir.path()).unwrap().is_empty());
    assert_eq!(count(dir.path(), "snapshots"), 1);
}
#[test]
fn combined_reads_preserve_authors_counters_sources_and_disconnected_records() {
    let dir = TempDir::new().unwrap();
    let mut human = side("H-1", "a.tex", "text");
    human.counter = 9;
    human.files.get_mut("a.tex").unwrap()[0].resolved = true;
    let mut agent = side("A-1", "a.tex", "text");
    agent.counter = 4;
    let mut detached = side("A-2", "gone.tex", "gone");
    agent.orphaned.append(&mut detached.files);
    agent.orphaned_revisions.append(&mut detached.revisions);
    agent.sources.append(&mut detached.sources);
    write(dir.path(), &[(false, &human), (true, &agent)], &[]).unwrap();
    let loaded = transaction(dir.path(), |db| read_both_on(db, None)).unwrap();
    for (index, agent) in [false, true].into_iter().enumerate() {
        let single = read(dir.path(), agent, None).unwrap();
        assert_eq!(serde_json::to_value(&loaded[index]).unwrap(), serde_json::to_value(single).unwrap());
    }
    assert_eq!(loaded[0].counter, 9);
    assert_eq!(loaded[1].counter, 4);
    assert!(loaded[0].files["a.tex"][0].resolved);
    assert_eq!(loaded[1].orphaned["gone.tex"][0].id, "A-2");
    let scope = BTreeSet::from(["a.tex".into()]);
    let scoped = transaction(dir.path(), |db| read_both_on(db, Some(&scope))).unwrap();
    assert!(scoped[1].orphaned.is_empty());
    assert_eq!(scoped[0].files, loaded[0].files);
    assert_eq!(scoped[1].files, loaded[1].files);
    assert_eq!(scoped[1].sources.len(), 1);
}
#[test]
fn unrelated_damaged_message_does_not_block_scoped_write() {
    let dir = TempDir::new().unwrap();
    let mut h = side("H-1", "a.tex", "text");
    let other = side("H-2", "b.tex", "text");
    h.files.extend(other.files);
    h.revisions.extend(other.revisions);
    write(dir.path(), &[(false, &h)], &[]).unwrap();
    transaction(dir.path(), |db| {
        put(
            db,
            "messages",
            &doc! {"_id":thread_id(false,"H-2"),"damaged":true},
        )
    })
    .unwrap();
    let scope = BTreeSet::from(["a.tex".into()]);
    let both = transaction(dir.path(), |db| read_both_on(db, Some(&scope))).unwrap();
    assert_eq!(both[0].files["a.tex"][0].id, "H-1");
    assert!(both[1].files.is_empty());
    let mut loaded = read(dir.path(), false, Some(&scope)).unwrap();
    loaded.files.get_mut("a.tex").unwrap()[0].from = 1;
    write(dir.path(), &[(false, &loaded)], &[]).unwrap();
    assert!(read(dir.path(), false, None).is_err());
    assert_eq!(
        read(dir.path(), false, Some(&scope)).unwrap().files["a.tex"][0].from,
        1
    );
}
#[test]
fn obsolete_storage_is_ignored_and_malformed_checkpoint_can_be_cleared() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("human.json"), "old").unwrap();
    fs::write(dir.path().join("comments.sqlite3"), "old SQLite").unwrap();
    assert!(read(dir.path(), false, None).unwrap().files.is_empty());
    restore(dir.path(), [(false, Some("damaged")), (true, None)]).unwrap();
    assert!(read(dir.path(), false, None).is_err());
    assert_eq!(
        export(dir.path(), false).unwrap().as_deref(),
        Some("damaged")
    );
    clear(dir.path(), false).unwrap();
    assert!(read(dir.path(), false, None).unwrap().files.is_empty());
    assert_eq!(
        fs::read_to_string(dir.path().join("human.json")).unwrap(),
        "old"
    );
}
#[test]
fn large_source_is_shared_and_deleted_after_last_reference() {
    let dir = TempDir::new().unwrap();
    let source = "text".repeat(1_100_000);
    write(
        dir.path(),
        &[
            (false, &side("H-1", "a.tex", &source)),
            (true, &side("A-1", "a.tex", &source)),
        ],
        &[],
    )
    .unwrap();
    assert_eq!(count(dir.path(), "snapshots"), 1);
    clear(dir.path(), false).unwrap();
    assert_eq!(count(dir.path(), "snapshots"), 1);
    clear(dir.path(), true).unwrap();
    assert_eq!(count(dir.path(), "snapshots"), 0);
}

// Only present in the Rust test executable. Electron fixtures invoke this exact
// ignored test; no fixture/import/debug command is shipped in the app service.
#[test]
#[ignore]
fn fixture_bridge() {
    let file = PathBuf::from(std::env::var_os("CATALEX_FIXTURE_PATH").expect("fixture path"));
    let io = PathBuf::from(std::env::var_os("CATALEX_FIXTURE_IO").expect("fixture IO"));
    match std::env::var("CATALEX_FIXTURE_MODE").unwrap().as_str() {
        "read" => fs::write(io, test_read(file).unwrap()).unwrap(),
        "write" => test_write(file, fs::read(io).unwrap()).unwrap(),
        _ => panic!("unknown fixture mode"),
    }
}
#[test]
fn repeated_replacement_keeps_linked_lost_comments_and_old_disconnected_generations() {
    let root = TempDir::new().unwrap();
    let storage = TempDir::new().unwrap();
    fs::write(root.path().join("a.tex"), "text").unwrap();
    let mut human = side("H-1", "a.tex", "text");
    let mut old = human.files["a.tex"][0].clone();
    old.id = "old".into();
    human.orphaned.insert("a.tex".into(), vec![old.clone()]);
    old.id = "older".into();
    human
        .orphaned
        .insert("a.tex [disconnected 2]".into(), vec![old]);
    write(storage.path(), &[(false, &human)], &[]).unwrap();
    fs::write(root.path().join("a.tex"), "unrelated").unwrap();
    identity::load_for_write(root.path(), storage.path(), [("a.tex".into(), None)]).unwrap();
    let saved = read(storage.path(), false, None).unwrap();
    assert_eq!(saved.orphaned.len(), 2);
    assert_eq!(saved.files["a.tex"][0].id, "H-1");
    assert!(saved.files["a.tex"][0].position_reset);
}

#[test]
#[ignore]
fn crash_writer() {
    let storage = PathBuf::from(std::env::var_os("CATALEX_CRASH_STORAGE").expect("storage"));
    let ready = PathBuf::from(std::env::var_os("CATALEX_CRASH_READY").expect("ready"));
    let committed = side("H-1", "a.tex", "committed");
    write(&storage, &[(false, &committed)], &[]).unwrap();
    transaction(&storage, |db| -> Result<(), String> {
        let changed = side("H-1", "a.tex", "uncommitted");
        write_on(db, &[(false, &changed)], &["uncommitted-job".into()])?;
        fs::write(ready, "ready").map_err(error)?;
        loop {
            std::thread::park();
        }
    })
    .unwrap();
}
#[test]
fn process_kill_preserves_commit_and_discards_pending_transaction() {
    use std::process::{Command, Stdio};
    let dir = TempDir::new().unwrap();
    let ready = dir.path().join("ready");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "comments::store::tests::crash_writer",
        ])
        .env("CATALEX_CRASH_STORAGE", dir.path())
        .env("CATALEX_CRASH_READY", &ready)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    while !ready.exists() && started.elapsed() < std::time::Duration::from_secs(20) {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let reached = ready.exists();
    let _ = child.kill();
    let output = child.wait_with_output().unwrap();
    assert!(
        reached,
        "crash writer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let saved = read(dir.path(), false, None).unwrap();
    assert_eq!(saved.sources.values().next().unwrap(), "committed");
    assert!(pending_cleanup(dir.path()).unwrap().is_empty());
    assert_eq!(count(dir.path(), "snapshots"), 1);
}

#[test]
#[ignore = "manual large-file storage benchmark"]
fn large_file_storage_benchmark() {
    let dir = TempDir::new().unwrap();
    for count in [1000, 10000] {
        let mut human = side("H-0", "a.tex", &"text line\n".repeat(count * 4));
        let original = human.files["a.tex"][0].clone();
        human.files.insert(
            "a.tex".into(),
            (0..count)
                .map(|i| {
                    let mut c = original.clone();
                    c.id = format!("H-{i}");
                    c.number = Some((i + 1) as u64);
                    c
                })
                .collect(),
        );
        human.counter = count as u64;
        let start = std::time::Instant::now();
        write(dir.path(), &[(false, &human)], &[]).unwrap();
        eprintln!("{count} seed {:?}", start.elapsed());
        transaction(dir.path(), |db| {
            let start = std::time::Instant::now();
            let scope = scope_for_connection(
                db,
                &(0..count)
                    .map(|i| ("a.tex".into(), Some(format!("H-{i}"))))
                    .collect::<Vec<_>>(),
            )?;
            eprintln!("{count} scope {:?}", start.elapsed());
            let start = std::time::Instant::now();
            let mut loaded = read_author(db, false, Some(&scope))?;
            eprintln!("{count} read {:?}", start.elapsed());
            for c in loaded.files.get_mut("a.tex").unwrap() {
                c.from = 1;
            }
            let start = std::time::Instant::now();
            write_on(db, &[(false, &loaded)], &[])?;
            eprintln!("{count} write {:?}", start.elapsed());
            Ok(())
        })
        .unwrap();
    }
}

#[test]
fn disconnected_directory_is_shared_and_removed_with_the_last_author() {
    let dir = TempDir::new().unwrap();
    let base = "notes [disconnected draft].tex";
    let path = format!("{base} [disconnected 2]");
    let mut human = side("H-1", &path, "text");
    human.orphaned = std::mem::take(&mut human.files);
    human.orphaned_revisions = std::mem::take(&mut human.revisions);
    let mut agent: AuthorSnapshot =
        serde_json::from_value(serde_json::to_value(&human).unwrap()).unwrap();
    agent.orphaned.get_mut(&path).unwrap()[0].id = "A-1".into();
    agent.orphaned.get_mut(&path).unwrap()[0].origin = Some(AgentOrigin {
        provider: "codex".into(),
        session_id: "session".into(),
        model: None,
        thinking_effort: None,
    });
    write(dir.path(), &[(false, &human), (true, &agent)], &[]).unwrap();
    let scope = || {
        transaction(dir.path(), |db| {
            scope_for_connection(db, &[(base.into(), None)])
        })
        .unwrap()
    };
    assert!(scope().contains(&path));
    clear(dir.path(), false).unwrap();
    assert!(scope().contains(&path));
    assert_eq!(
        read(dir.path(), true, None).unwrap().orphaned[&path][0].id,
        "A-1"
    );
    clear(dir.path(), true).unwrap();
    assert_eq!(scope(), BTreeSet::from([base.into()]));
    assert_eq!(
        transaction(dir.path(), |db| all::<Document>(
            db,
            "meta",
            doc! {"kind":"detached"}
        ))
        .unwrap()
        .len(),
        0
    );
}
