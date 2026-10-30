//! Minimal owned-buffer ABI used only by the WASM adapter. The caller allocates
//! input with alloc, then frees input/output exactly once with their exact lengths.
use super::{Document, DocumentModel, Update};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::BTreeMap, slice};

#[derive(Default)]
struct Sessions {
    next: u32,
    documents: BTreeMap<u32, DocumentModel>,
}

thread_local! {
    static SESSIONS: RefCell<Sessions> = RefCell::new(Sessions::default());
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Open { document: Document },
    Update { handle: u32, update: Update },
    Fork { handle: u32, update: Update },
    Read { handle: u32 },
    Close { handle: u32 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View<'a> {
    handle: u32,
    revision: u64,
    anchors: &'a [super::Anchor],
}

fn command(input: &[u8]) -> Result<serde_json::Value, String> {
    let command: Command = serde_json::from_slice(input).map_err(|e| e.to_string())?;
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        match command {
            Command::Open { document } => {
                let document = DocumentModel::open(document)?;
                let handle = sessions
                    .next
                    .checked_add(1)
                    .ok_or("Document handles exhausted")?;
                sessions.next = handle;
                let view = serde_json::to_value(View {
                    handle,
                    revision: document.revision,
                    anchors: &document.anchors,
                })
                .map_err(|e| e.to_string())?;
                sessions.documents.insert(handle, document);
                Ok(view)
            }
            Command::Update { handle, update } => {
                let current = sessions
                    .documents
                    .get_mut(&handle)
                    .ok_or("Document handle is closed")?;
                let next = current.apply(&update)?;
                let view = serde_json::to_value(View {
                    handle,
                    revision: next.revision,
                    anchors: &next.anchors,
                })
                .map_err(|e| e.to_string())?;
                *current = next;
                Ok(view)
            }
            Command::Fork { handle, update } => {
                let document = sessions
                    .documents
                    .get(&handle)
                    .ok_or("Document handle is closed")?
                    .apply(&update)?;
                let handle = sessions
                    .next
                    .checked_add(1)
                    .ok_or("Document handles exhausted")?;
                let view = serde_json::to_value(View {
                    handle,
                    revision: document.revision,
                    anchors: &document.anchors,
                })
                .map_err(|e| e.to_string())?;
                sessions.next = handle;
                sessions.documents.insert(handle, document);
                Ok(view)
            }
            Command::Read { handle } => serde_json::to_value(
                sessions
                    .documents
                    .get(&handle)
                    .ok_or("Document handle is closed")?
                    .snapshot()?,
            )
            .map_err(|e| e.to_string()),
            Command::Close { handle } => {
                sessions.documents.remove(&handle);
                Ok(serde_json::Value::Null)
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn free(pointer: *mut u8, length: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        pointer, length,
    )));
}

#[no_mangle]
pub unsafe extern "C" fn apply(pointer: *const u8, length: usize) -> u64 {
    let result = super::apply_json(slice::from_raw_parts(pointer, length)).into_boxed_slice();
    let size = result.len() as u64;
    let pointer = Box::into_raw(result) as *mut u8 as u64;
    (pointer << 32) | size
}

#[no_mangle]
pub unsafe extern "C" fn diff(pointer: *const u8, length: usize) -> u64 {
    let result = super::diff_json(slice::from_raw_parts(pointer, length)).into_boxed_slice();
    let size = result.len() as u64;
    let pointer = Box::into_raw(result) as *mut u8 as u64;
    (pointer << 32) | size
}

#[no_mangle]
pub unsafe extern "C" fn session(pointer: *const u8, length: usize) -> u64 {
    let result = command(slice::from_raw_parts(pointer, length));
    let result = serde_json::to_vec(&result)
        .unwrap_or_else(|_| br#"{"Err":"Could not encode document"}"#.to_vec())
        .into_boxed_slice();
    let size = result.len() as u64;
    let pointer = Box::into_raw(result) as *mut u8 as u64;
    (pointer << 32) | size
}
