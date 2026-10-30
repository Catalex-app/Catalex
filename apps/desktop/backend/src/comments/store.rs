//! Embedded PoloDB persistence. Domain snapshots remain the existing in-memory and
//! history interchange view. Live records use Overleaf's docs/rooms/messages split.
use super::*;
use polodb_core::{
    bson::{self, doc, oid::ObjectId, Bson, Document},
    CollectionT, Database, IndexModel,
};
use serde::de::DeserializeOwned;
use std::{
    collections::BTreeSet,
    sync::{OnceLock, Weak},
};

pub(super) type Connection = polodb_core::Transaction;
const DATABASE: &str = "comments.polodb";
const FORMAT: i32 = 1;
fn error(e: impl std::fmt::Display) -> String {
    format!("comment_storage_failed: {e}")
}
fn encode<T: Serialize + ?Sized>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(error)
}
fn decode<T: DeserializeOwned>(v: &str) -> Result<T, String> {
    serde_json::from_str(v).map_err(|e| format!("invalid_comments_file: {e}"))
}
fn oid(namespace: &str) -> ObjectId {
    let hash = Sha1::digest(namespace.as_bytes());
    let mut bytes = [0; 12];
    bytes.copy_from_slice(&hash[..12]);
    ObjectId::from_bytes(bytes)
}
fn role(agent: bool) -> &'static str {
    if agent {
        "agent"
    } else {
        "human"
    }
}
fn thread_id(agent: bool, id: &str) -> ObjectId {
    oid(&format!("{}:{id}", role(agent)))
}
fn doc_id(path: &str, detached: bool) -> ObjectId {
    oid(&format!("doc:{detached}:{path}"))
}
fn empty() -> AuthorSnapshot {
    AuthorSnapshot {
        version: 1,
        counter: 0,
        files: BTreeMap::new(),
        orphaned: BTreeMap::new(),
        revisions: BTreeMap::new(),
        orphaned_revisions: BTreeMap::new(),
        sources: BTreeMap::new(),
        scope: None,
    }
}
fn decode_snapshot(raw: &str, agent: bool) -> Option<AuthorSnapshot> {
    let side: AuthorSnapshot = decode(raw).ok()?;
    if side.version != 1 || validate_numbers(&side).is_err() {
        return None;
    }
    let mut ids = BTreeSet::new();
    if side
        .files
        .values()
        .chain(side.orphaned.values())
        .flatten()
        .any(|c| !ids.insert(&c.id) || c.origin.is_some() != agent)
    {
        return None;
    }
    Some(side)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct RangeOp {
    p: i64,
    c: String,
    t: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct RangeLocal {
    agent: bool,
    id: String,
    anchor: serde_json::Map<String, Value>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Range {
    op: RangeOp,
    catalex: RangeLocal,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Ranges {
    comments: Vec<Range>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct DocLocal {
    path: String,
    detached: bool,
    // The two author views are existing UI/history semantics, not separate stores.
    revisions: BTreeMap<String, Vec<identity::FileRevision>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Doc {
    #[serde(rename = "_id")]
    id: ObjectId,
    project_id: ObjectId,
    rev: i64,
    ranges: Ranges,
    catalex: DocLocal,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct RoomLocal {
    id: String,
    agent: bool,
    path: String,
    detached: bool,
    doc_id: ObjectId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Room {
    #[serde(rename = "_id")]
    id: ObjectId,
    project_id: ObjectId,
    thread_id: ObjectId,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved: Option<Document>,
    catalex: RoomLocal,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct MessageLocal {
    doc_id: ObjectId,
    #[serde(flatten)]
    body: serde_json::Map<String, Value>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Message {
    #[serde(rename = "_id")]
    id: ObjectId,
    room_id: ObjectId,
    user_id: ObjectId,
    content: String,
    timestamp: bson::DateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    edited_at: Option<bson::DateTime>,
    catalex: MessageLocal,
}

fn one<T: Serialize + DeserializeOwned + Send + Sync>(
    db: &Connection,
    name: &str,
    filter: Document,
) -> Result<Option<T>, String> {
    db.collection::<T>(name).find_one(filter).map_err(error)
}
fn all<T: Serialize + DeserializeOwned + Send + Sync + Unpin>(
    db: &Connection,
    name: &str,
    filter: Document,
) -> Result<Vec<T>, String> {
    let mut cursor = db.collection::<T>(name).find(filter).run().map_err(error)?;
    let mut values = Vec::new();
    // PoloDB 5.3's Iterator unwraps deserialization errors. Use its fallible
    // cursor API so a damaged record returns an error without poisoning locks.
    while cursor.advance().map_err(error)? {
        values.push(cursor.deserialize_current().map_err(error)?);
    }
    Ok(values)
}
fn put<T: Serialize>(db: &Connection, name: &str, value: &T) -> Result<(), String> {
    let mut record = bson::to_document(value).map_err(error)?;
    let id = record
        .get("_id")
        .ok_or("invalid_comments_file: record without ID")?
        .clone();
    let col = db.collection::<Document>(name);
    match col.find_one(doc! {"_id":id.clone()}).map_err(error)? {
        Some(old) if old == record => {}
        Some(_) => {
            record.remove("_id");
            // Replacement by delete/insert also removes optional fields such as resolved.
            // Both operations are inside the caller's transaction.
            col.delete_one(doc! {"_id":id.clone()}).map_err(error)?;
            record.insert("_id", id);
            col.insert_one(record).map_err(error)?;
        }
        None => {
            col.insert_one(record).map_err(error)?;
        }
    }
    Ok(())
}
fn remove(db: &Connection, name: &str, filter: Document) -> Result<(), String> {
    db.collection::<Document>(name)
        .delete_many(filter)
        .map_err(error)?;
    Ok(())
}

// Keep the read/check/write operation serialized, including opening and closing
// RocksDB. Weak gates disappear after use: closed projects retain no DB handles.
fn storage_gate(storage: &Path) -> Result<Arc<std::sync::Mutex<()>>, String> {
    static GATES: OnceLock<std::sync::Mutex<BTreeMap<PathBuf, Weak<std::sync::Mutex<()>>>>> =
        OnceLock::new();
    fs::create_dir_all(storage).map_err(error)?;
    let path = fs::canonicalize(storage).map_err(error)?;
    let mut gates = GATES.get_or_init(Default::default).lock().map_err(error)?;
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(&path).and_then(Weak::upgrade) {
        return Ok(gate);
    }
    let gate = Arc::new(std::sync::Mutex::new(()));
    gates.insert(path, Arc::downgrade(&gate));
    Ok(gate)
}
fn open(storage: &Path) -> Result<Database, String> {
    let path = storage.join(DATABASE);
    match fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            return Err("invalid_comments_file: database must be a directory".into())
        }
        Ok(_) => {
            for entry in fs::read_dir(&path).map_err(error)? {
                let entry = entry.map_err(error)?;
                if entry.file_type().map_err(error)?.is_symlink() {
                    return Err("invalid_comments_file: database contains a symlink".into());
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(error(e)),
    }
    let started = std::time::Instant::now();
    let db = loop {
        match Database::open_path(&path) {
            Ok(db) => break db,
            Err(e)
                if e.to_string().contains("LOCK")
                    && started.elapsed() < std::time::Duration::from_secs(5) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(e) => return Err(error(e)),
        }
    };
    let meta = db.collection::<Document>("meta");
    match meta.find_one(doc! {"_id":"format"}).map_err(error)? {
        Some(v) if v.get_i32("version").ok() != Some(FORMAT) => {
            return Err("invalid_comments_file: unsupported database version".into())
        }
        Some(_) => {}
        None => {
            for (name, key) in [("meta", "kind"), ("docs", "catalex.path")] {
                db.collection::<Document>(name)
                    .create_index(IndexModel {
                        keys: doc! {key:1},
                        options: None,
                    })
                    .map_err(error)?;
            }
            meta.insert_one(doc! {"_id":"format","version":FORMAT,"project_id":ObjectId::new()})
                .map_err(error)?;
        }
    }
    Ok(db)
}
pub(super) fn transaction<T>(
    storage: &Path,
    update: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let gate = storage_gate(storage)?;
    let _guard = gate.lock().map_err(error)?;
    let db = open(storage)?;
    let tx = db.start_transaction().map_err(error)?;
    match update(&tx) {
        Ok(result) => {
            tx.commit().map_err(error)?;
            Ok(result)
        }
        Err(e) => {
            tx.rollback().map_err(error)?;
            Err(e)
        }
    }
}
fn project_id(db: &Connection) -> Result<ObjectId, String> {
    one::<Document>(db, "meta", doc! {"_id":"format"})?
        .ok_or("invalid_comments_file: missing format")?
        .get_object_id("project_id")
        .map_err(error)
}
pub(super) fn read(
    storage: &Path,
    agent: bool,
    scope: Option<&BTreeSet<String>>,
) -> Result<AuthorSnapshot, String> {
    transaction(storage, |db| read_author(db, agent, scope))
}
fn scoped_docs(db: &Connection, scope: Option<&BTreeSet<String>>) -> Result<Vec<Doc>, String> {
    match scope {
        None => all(db, "docs", doc! {}),
        Some(paths) => {
            let mut docs = Vec::new();
            for path in paths {
                for detached in [false, true] {
                    if let Some(d) = one::<Doc>(db, "docs", doc! {"_id":doc_id(path,detached)})? {
                        docs.push(d);
                    }
                }
            }
            Ok(docs)
        }
    }
}
fn source_keys(d: &Doc) -> BTreeSet<String> {
    let mut keys: BTreeSet<_> = d
        .ranges
        .comments
        .iter()
        .filter_map(|r| {
            r.catalex
                .anchor
                .get("anchorRevision")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    keys.extend(
        d.catalex
            .revisions
            .values()
            .flatten()
            .filter_map(|r| serde_json::to_value(r).ok()?.as_str().map(str::to_owned)),
    );
    keys
}
pub(super) fn read_author(
    db: &Connection,
    agent: bool,
    scope: Option<&BTreeSet<String>>,
) -> Result<AuthorSnapshot, String> {
    let [human, machine] = read_authors(db, [!agent, agent], scope)?;
    Ok(if agent { machine } else { human })
}

pub(super) fn read_both_on(
    db: &Connection,
    scope: Option<&BTreeSet<String>>,
) -> Result<[AuthorSnapshot; 2], String> {
    read_authors(db, [true, true], scope)
}

// One hydration path for full/scoped and single/both-author reads. A scoped
// write must never deserialize unrelated documents or messages.
fn read_authors(
    db: &Connection,
    requested: [bool; 2],
    scope: Option<&BTreeSet<String>>,
) -> Result<[AuthorSnapshot; 2], String> {
    let mut sides = [empty(), empty()];
    for (index, side) in sides.iter_mut().enumerate() {
        if !requested[index] { continue; }
        side.scope = scope.cloned();
        if let Some(meta) = one::<Document>(db, "meta", doc! {"_id":role(index == 1)})? {
            if meta.contains_key("invalid") {
                return Err(
                    "invalid_comments_file: comment snapshot is damaged; original data is preserved"
                        .into(),
                );
            }
            side.counter = meta.get_i64("counter").map_err(error)?.try_into().map_err(error)?;
        }
    }
    let mut keys: [BTreeSet<String>; 2] = Default::default();
    let docs: Vec<_> = scoped_docs(db, scope)?
        .into_iter()
        .filter(|d| d.ranges.comments.iter().any(|r| requested[usize::from(r.catalex.agent)]))
        .collect();
    let filters = if docs.is_empty() {
        Vec::new()
    } else if scope.is_none() {
        // A full project read needs all records, regardless of author.
        vec![doc! {}]
    } else {
        docs.iter().map(|d| doc! {"catalex.doc_id":d.id}).collect()
    };
    let mut rooms = BTreeMap::new();
    let mut messages = BTreeMap::new();
    for filter in filters {
        rooms.extend(
            all::<Room>(db, "rooms", filter.clone())?
                .into_iter()
                .map(|r| (r.id, r)),
        );
        messages.extend(
            all::<Message>(db, "messages", filter)?
                .into_iter()
                .map(|m| (m.id, m)),
        );
    }
    for d in docs {
        let mut comments: [Vec<Comment>; 2] = Default::default();
        for r in d.ranges.comments {
            let agent = r.catalex.agent;
            let index = usize::from(agent);
            if !requested[index] { continue; }
            let id = thread_id(agent, &r.catalex.id);
            let room = rooms
                .remove(&id)
                .ok_or("invalid_comments_file: missing room")?;
            let message = messages
                .remove(&id)
                .ok_or("invalid_comments_file: missing message")?;
            if room.thread_id.to_hex() != r.op.t
                || message.room_id != room.id
                || room.catalex.doc_id != d.id
                || message.catalex.doc_id != d.id
            {
                return Err("invalid_comments_file: invalid comment link".into());
            }
            let mut value = message.catalex.body;
            value.extend(r.catalex.anchor.clone());
            value.insert("id".into(), json!(r.catalex.id));
            value.insert("text".into(), json!(message.content));
            value.insert("resolved".into(), json!(room.resolved.is_some()));
            let c: Comment = serde_json::from_value(Value::Object(value)).map_err(error)?;
            if let Some(rev) = &c.anchor_revision {
                keys[index].insert(rev.clone());
            }
            comments[index].push(c);
        }
        for (index, comments) in comments.into_iter().enumerate() {
            if comments.is_empty() { continue; }
            let side = &mut sides[index];
            let groups = if d.catalex.detached { &mut side.orphaned } else { &mut side.files };
            groups.insert(d.catalex.path.clone(), comments);
            if let Some(revs) = d.catalex.revisions.get(role(index == 1)) {
                for rev in revs {
                    keys[index].insert(decode::<String>(&encode(rev)?)?);
                }
                let revisions = if d.catalex.detached {
                    &mut side.orphaned_revisions
                } else {
                    &mut side.revisions
                };
                revisions.insert(d.catalex.path.clone(), revs.clone());
            }
        }
    }
    for key in keys[0].union(&keys[1]) {
        if let Some(source) = one::<Document>(db, "snapshots", doc! {"_id":key})? {
            let text = source.get_str("text").map_err(error)?;
            for (index, side) in sides.iter_mut().enumerate() {
                if keys[index].contains(key) { side.sources.insert(key.clone(), text.into()); }
            }
        }
    }
    Ok(sides)
}

// Recovery needs immutable source versions. Store each once, with small reference
// records in meta so changing ranges never rewrites megabytes of source text.
fn ensure_sources(db: &Connection, side: &AuthorSnapshot) -> Result<BTreeSet<String>, String> {
    let mut candidates = BTreeSet::new();
    for (key, text) in &side.sources {
        let id = format!("source:{key}");
        let digest = format!("{:x}", Sha1::digest(text.as_bytes()));
        match one::<Document>(db, "meta", doc! {"_id":&id})? {
            Some(old) if old.get_str("digest").ok() != Some(&digest) => {
                return Err("invalid_comments_file: conflicting source revision".into())
            }
            Some(_) => {}
            None => {
                put(db, "snapshots", &doc! {"_id":key,"text":text})?;
                put(db, "meta", &doc! {"_id":id,"digest":digest,"refs":[]})?;
            }
        }
        candidates.insert(key.clone());
    }
    Ok(candidates)
}
fn update_source_refs(
    db: &Connection,
    id: ObjectId,
    old: &BTreeSet<String>,
    new: &BTreeSet<String>,
) -> Result<(), String> {
    for key in old.union(new) {
        let filter = doc! {"_id":format!("source:{key}")};
        if let Some(mut meta) = one::<Document>(db, "meta", filter)? {
            let mut refs = meta.get_array("refs").map_err(error)?.clone();
            refs.retain(|v| v != &Bson::ObjectId(id));
            if new.contains(key) {
                refs.push(id.into());
            }
            meta.insert("refs", refs);
            put(db, "meta", &meta)?;
        }
    }
    Ok(())
}
fn prune_candidates(db: &Connection, keys: BTreeSet<String>) -> Result<(), String> {
    for key in keys {
        let filter = doc! {"_id":format!("source:{key}")};
        if one::<Document>(db, "meta", filter.clone())?
            .is_some_and(|m| m.get_array("refs").is_ok_and(Vec::is_empty))
        {
            remove(db, "snapshots", doc! {"_id":key})?;
            remove(db, "meta", filter)?;
        }
    }
    Ok(())
}
#[derive(Clone, Copy)]
enum WriteMode<'a> {
    All,
    Comment(&'a str),
    Anchors,
}
fn write_author(
    db: &Connection,
    agent: bool,
    side: &AuthorSnapshot,
    mode: WriteMode<'_>,
) -> Result<BTreeSet<String>, String> {
    let mut seen = BTreeSet::new();
    if side
        .files
        .values()
        .chain(side.orphaned.values())
        .flatten()
        .any(|c| !seen.insert(&c.id))
    {
        return Err("invalid_comments_file: duplicate comment identifier".into());
    }
    let counter = i64::try_from(side.counter).map_err(error)?;
    put(db, "meta", &doc! {"_id":role(agent),"counter":counter})?;
    let project_id = project_id(db)?;
    let mut candidates = ensure_sources(db, side)?;
    let old_docs = scoped_docs(db, side.scope.as_ref())?;
    let mut paths: BTreeSet<_> = old_docs.iter().map(|d| d.catalex.path.clone()).collect();
    paths.extend(side.files.keys().chain(side.orphaned.keys()).cloned());
    let incoming: BTreeSet<_> = side
        .files
        .values()
        .chain(side.orphaned.values())
        .flatten()
        .map(|c| c.id.as_str())
        .collect();
    // Delete absent IDs before inserting destinations, so rename cannot erase a moved comment.
    for d in &old_docs {
        for r in d
            .ranges
            .comments
            .iter()
            .filter(|r| r.catalex.agent == agent && !incoming.contains(r.catalex.id.as_str()))
        {
            let id = thread_id(agent, &r.catalex.id);
            remove(db, "messages", doc! {"_id":id})?;
            remove(db, "rooms", doc! {"_id":id})?;
        }
    }
    let old_docs: BTreeMap<_, _> = old_docs
        .into_iter()
        .map(|d| ((d.catalex.path.clone(), d.catalex.detached), d))
        .collect();
    let mut indices = BTreeMap::new();
    for path in paths {
        for detached in [false, true] {
            let groups = if detached {
                &side.orphaned
            } else {
                &side.files
            };
            let revisions = if detached {
                &side.orphaned_revisions
            } else {
                &side.revisions
            };
            let old = old_docs.get(&(path.clone(), detached));
            let mut d = old.cloned().unwrap_or_else(|| Doc {
                id: doc_id(&path, detached),
                project_id,
                rev: 0,
                ranges: Ranges::default(),
                catalex: DocLocal {
                    path: path.clone(),
                    detached,
                    revisions: BTreeMap::new(),
                },
            });
            let old_keys = source_keys(&d);
            let previous: BTreeMap<_, _> = d
                .ranges
                .comments
                .iter()
                .filter(|r| r.catalex.agent == agent)
                .map(|r| (r.catalex.id.clone(), r.clone()))
                .collect();
            d.ranges.comments.retain(|r| r.catalex.agent != agent);
            d.catalex.revisions.remove(role(agent));
            if let Some(comments) = groups.get(&path).filter(|c| !c.is_empty()) {
                if let Some(revs) = revisions.get(&path) {
                    d.catalex
                        .revisions
                        .insert(role(agent).into(), revs.clone());
                }
                for comment in comments {
                    if matches!(mode, WriteMode::Comment(id) if id != comment.id) {
                        if let Some(r) = previous.get(&comment.id) {
                            d.ranges.comments.push(r.clone());
                            continue;
                        }
                    }
                    let id = thread_id(agent, &comment.id);
                    let mut body = serde_json::to_value(comment)
                        .map_err(error)?
                        .as_object()
                        .ok_or("invalid comment")?
                        .clone();
                    let mut anchor = serde_json::Map::new();
                    for key in [
                        "from",
                        "to",
                        "line",
                        "anchorRevision",
                        "positionReset",
                        "removedAnchor",
                    ] {
                        if let Some(mut value) = body.remove(key) {
                            if value.as_u64().is_some_and(|n| n > i64::MAX as u64) {
                                value = Value::Null;
                            }
                            anchor.insert(key.into(), value);
                        }
                    }
                    for key in ["id", "text", "resolved"] {
                        body.remove(key);
                    }
                    let quote = comment
                        .anchor_revision
                        .as_ref()
                        .and_then(|key| side.sources.get(key))
                        .and_then(|text| {
                            let index = indices
                                .entry(comment.anchor_revision.as_ref()?)
                                .or_insert_with(|| identity::SourceIndex::new(text));
                            text.get(
                                index.byte_offset(comment.from)?..index.byte_offset(comment.to)?,
                            )
                        })
                        .unwrap_or("");
                    d.ranges.comments.push(Range {
                        op: RangeOp {
                            p: i64::try_from(comment.from).unwrap_or(0),
                            c: quote.into(),
                            t: id.to_hex(),
                        },
                        catalex: RangeLocal {
                            agent,
                            id: comment.id.clone(),
                            anchor,
                        },
                    });
                    // The anchor endpoint has already validated and merged each
                    // patch against the latest content. Existing bindings only
                    // need their document ranges changed, not room/message reads.
                    if matches!(mode, WriteMode::Anchors) && previous.contains_key(&comment.id) {
                        continue;
                    }
                    let user_id = oid(&comment
                        .origin
                        .as_ref()
                        .map(|o| format!("agent:{}", o.provider))
                        .unwrap_or_else(|| "human:local".into()));
                    put(db, "users", &doc! {"_id":user_id,"kind":role(agent)})?;
                    let prior_room = one::<Room>(db, "rooms", doc! {"_id":id})?;
                    let resolved = if comment.resolved {
                        Some(prior_room.and_then(|r| r.resolved).unwrap_or_else(
                            || doc! {"user_id":oid("human:local"),"ts":bson::DateTime::now()},
                        ))
                    } else {
                        None
                    };
                    put(
                        db,
                        "rooms",
                        &Room {
                            id,
                            project_id,
                            thread_id: id,
                            resolved,
                            catalex: RoomLocal {
                                id: comment.id.clone(),
                                agent,
                                path: path.clone(),
                                detached,
                                doc_id: d.id,
                            },
                        },
                    )?;
                    let previous_message = one::<Message>(db, "messages", doc! {"_id":id})?;
                    let timestamp = comment
                        .created_at
                        .as_deref()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|t| bson::DateTime::from_millis(t.timestamp_millis()))
                        .unwrap_or_else(|| bson::DateTime::from_millis(0));
                    let edited_at = previous_message.as_ref().and_then(|m| {
                        if m.content != comment.text {
                            Some(bson::DateTime::now())
                        } else {
                            m.edited_at
                        }
                    });
                    put(
                        db,
                        "messages",
                        &Message {
                            id,
                            room_id: id,
                            user_id,
                            content: comment.text.clone(),
                            timestamp,
                            edited_at,
                            catalex: MessageLocal { doc_id: d.id, body },
                        },
                    )?;
                }
            }
            // Author views are ordered individually; keep their storage order stable.
            d.ranges.comments.sort_by_key(|r| r.catalex.agent);
            let new_keys = source_keys(&d);
            update_source_refs(db, d.id, &old_keys, &new_keys)?;
            candidates.extend(old_keys);
            candidates.extend(new_keys);
            if d.ranges.comments.is_empty() {
                if old.is_some() {
                    remove(db, "docs", doc! {"_id":d.id})?;
                    if detached {
                        remove(db, "meta", doc! {"_id":format!("detached:{}",d.id)})?;
                    }
                }
            } else if old != Some(&d) {
                d.rev += 1;
                put(db, "docs", &d)?;
                if detached {
                    put(
                        db,
                        "meta",
                        &doc! {"_id":format!("detached:{}",d.id),"kind":"detached","path":&path},
                    )?;
                }
            }
        }
    }
    Ok(candidates)
}
pub(super) fn write(
    storage: &Path,
    sides: &[(bool, &AuthorSnapshot)],
    jobs: &[String],
) -> Result<(), String> {
    transaction(storage, |db| write_on(db, sides, jobs))
}
pub(super) fn write_on(
    db: &Connection,
    sides: &[(bool, &AuthorSnapshot)],
    jobs: &[String],
) -> Result<(), String> {
    write_changed(db, sides, jobs, WriteMode::All)
}
pub(super) fn write_change(
    db: &Connection,
    agent: bool,
    side: &AuthorSnapshot,
    change: &CommentPatch,
) -> Result<(), String> {
    write_changed(db, &[(agent, side)], &[], WriteMode::Comment(&change.id))
}
pub(super) fn write_anchors_on(
    db: &Connection,
    sides: &[(bool, &AuthorSnapshot)],
) -> Result<(), String> {
    write_changed(db, sides, &[], WriteMode::Anchors)
}
fn write_changed(
    db: &Connection,
    sides: &[(bool, &AuthorSnapshot)],
    jobs: &[String],
    mode: WriteMode<'_>,
) -> Result<(), String> {
    let mut candidates = BTreeSet::new();
    for (agent, side) in sides {
        candidates.extend(write_author(db, *agent, side, mode)?);
    }
    for job in jobs {
        put(
            db,
            "meta",
            &doc! {"_id":format!("job:{job}"),"job":job,"kind":"cleanup"},
        )?;
    }
    prune_candidates(db, candidates)
}
pub(super) fn pending_cleanup(storage: &Path) -> Result<Vec<String>, String> {
    if !storage.join(DATABASE).exists() {
        return Ok(Vec::new());
    }
    transaction(storage, |db| {
        all::<Document>(db, "meta", doc! {"kind":"cleanup"})?
            .into_iter()
            .map(|d| d.get_str("job").map(str::to_owned).map_err(error))
            .collect()
    })
}
pub(super) fn finish_cleanup(storage: &Path, job: &str) -> Result<(), String> {
    transaction(storage, |db| {
        remove(db, "meta", doc! {"_id":format!("job:{job}")})
    })
}
pub(super) fn scope_for_connection(
    db: &Connection,
    requested: &[(String, Option<String>)],
) -> Result<BTreeSet<String>, String> {
    let mut paths = BTreeSet::new();
    for (path, id) in requested {
        paths.insert(path.clone());
        if let Some(id) = id {
            // Both identities are deterministic. Primary-key lookups also avoid
            // depending on PoloDB's secondary-index planner for a typing batch.
            for agent in [false, true] {
                if let Some(room) = one::<Room>(db, "rooms", doc! {"_id":thread_id(agent,id)})? {
                    paths.insert(room.catalex.path);
                }
            }
        }
    }
    // Only inspect the small directory of disconnected group names. Scanning
    // docs here would deserialize every unrelated file's ranges on each save.
    let bases: Vec<_> = paths
        .iter()
        .map(|p| format!("{p} [disconnected "))
        .collect();
    for entry in all::<Document>(db, "meta", doc! {"kind":"detached"})? {
        let path = entry.get_str("path").map_err(error)?;
        if bases.iter().any(|prefix| path.starts_with(prefix)) {
            paths.insert(path.into());
        }
    }
    Ok(paths)
}
fn export_on(db: &Connection, agent: bool) -> Result<Option<String>, String> {
    match one::<Document>(db, "meta", doc! {"_id":role(agent)})? {
        None => Ok(None),
        Some(m) => match m.get_str("invalid") {
            Ok(raw) => Ok(Some(raw.into())),
            Err(_) => Ok(Some(encode(&read_author(db, agent, None)?)?)),
        },
    }
}
pub(super) fn export(storage: &Path, agent: bool) -> Result<Option<String>, String> {
    transaction(storage, |db| export_on(db, agent))
}
fn clear_on(db: &Connection, agent: bool) -> Result<(), String> {
    let keys = write_author(db, agent, &empty(), WriteMode::All)?;
    remove(db, "meta", doc! {"_id":role(agent)})?;
    prune_candidates(db, keys)
}
pub(super) fn restore(storage: &Path, values: [(bool, Option<&str>); 2]) -> Result<(), String> {
    transaction(storage, |db| {
        for (agent, value) in values {
            clear_on(db, agent)?;
            if let Some(raw) = value {
                match decode_snapshot(raw, agent) {
                    Some(mut side) => {
                        side.revisions.clear();
                        let keys = write_author(db, agent, &side, WriteMode::All)?;
                        prune_candidates(db, keys)?;
                    }
                    None => put(
                        db,
                        "meta",
                        &doc! {"_id":role(agent),"counter":0_i64,"invalid":raw},
                    )?,
                }
            }
        }
        Ok(())
    })
}
pub(super) fn clear(storage: &Path, agent: bool) -> Result<(), String> {
    transaction(storage, |db| clear_on(db, agent))
}
pub(super) fn validate(storage: &Path) -> Result<(), String> {
    transaction(storage, |_| Ok(()))
}

#[cfg(test)]
pub(crate) fn test_read(path: impl AsRef<Path>) -> Result<Vec<u8>, String> {
    let path = path.as_ref();
    Ok(export(
        path.parent().unwrap(),
        path.file_name().unwrap() == "agent.json",
    )?
    .unwrap_or(encode(&empty())?)
    .into_bytes())
}
#[cfg(test)]
pub(crate) fn test_write(path: impl AsRef<Path>, data: impl AsRef<[u8]>) -> Result<(), String> {
    let path = path.as_ref();
    let agent = path.file_name().unwrap() == "agent.json";
    let raw = std::str::from_utf8(data.as_ref()).map_err(error)?;
    transaction(path.parent().unwrap(), |db| {
        match decode::<AuthorSnapshot>(raw) {
            Ok(mut side) => {
                let mut used: BTreeSet<u64> = side
                    .files
                    .values()
                    .chain(side.orphaned.values())
                    .flatten()
                    .filter_map(|c| c.number)
                    .collect();
                let mut next = 1;
                for c in side
                    .files
                    .values_mut()
                    .chain(side.orphaned.values_mut())
                    .flatten()
                {
                    if c.number.is_none() {
                        while used.contains(&next) {
                            next += 1;
                        }
                        c.number = Some(next);
                        used.insert(next);
                    }
                }
                side.counter = side.counter.max(used.last().copied().unwrap_or(0));
                let keys = write_author(db, agent, &side, WriteMode::All)?;
                prune_candidates(db, keys)?;
            }
            Err(_) => put(
                db,
                "meta",
                &doc! {"_id":role(agent),"counter":0_i64,"invalid":raw},
            )?,
        }
        Ok(())
    })
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
