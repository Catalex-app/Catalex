//! Request-scoped compiler cancellation and owned process-tree shutdown.
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

pub const CANCELLED: &str = "Compilation cancelled";
pub const CLEANUP_FAILED: &str = "Compiler cleanup failed";
pub(crate) type Key = (String, String, String);

#[derive(Default)]
pub struct Registry {
    entries: Mutex<Entries>,
}
#[derive(Default)]
struct Entries {
    active: HashMap<Key, Arc<Operation>>,
    cancelled: VecDeque<Key>,
}

pub struct Operation {
    pub identity: Key,
    pub token: CancellationToken,
    verification: bool,
    completion: Mutex<Option<Result<(), String>>>,
    done: watch::Sender<bool>,
}
impl Operation {
    fn new(token: CancellationToken, verification: bool, identity: Key) -> Self {
        Self {
            identity,
            token,
            verification,
            completion: Mutex::new(None),
            done: watch::channel(false).0,
        }
    }
    pub fn check(&self) -> Result<(), String> {
        if self.token.is_cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
    // Cancellation and publication are ordered by this mutex. Completion wins
    // only once all output is ready; a later Stop cannot undo that result.
    pub fn publish<T>(&self, publish: impl FnOnce() -> T) -> Result<T, String> {
        let mut completed = self.completion.lock().unwrap_or_else(|e| e.into_inner());
        self.check()?;
        let value = publish();
        *completed = Some(Ok(()));
        Ok(value)
    }
    fn cancel(&self) {
        let completed = self.completion.lock().unwrap_or_else(|e| e.into_inner());
        if completed.is_none() {
            self.token.cancel();
        }
    }
    pub fn finish(&self, error: Option<&str>) -> bool {
        let mut completed = self.completion.lock().unwrap_or_else(|e| e.into_inner());
        if completed.is_none() {
            *completed = Some(match error.filter(|e| e.starts_with(CLEANUP_FAILED)) {
                Some(error) => Err(error.to_string()),
                None => Ok(()),
            });
        }
        self.done.send_replace(true);
        self.token.is_cancelled()
    }
    async fn wait(&self) -> Result<(), String> {
        let mut done = self.done.subscribe();
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                break;
            }
        }
        self.completion
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or(Ok(()))
    }
}
impl Registry {
    pub fn register(
        &self,
        window: &str,
        project: &str,
        id: &str,
        token: CancellationToken,
    ) -> Result<Arc<Operation>, String> {
        self.register_inner(window, project, id, token, false)
    }
    pub fn register_verification(
        &self,
        window: &str,
        project: &str,
        id: &str,
        token: CancellationToken,
    ) -> Result<Arc<Operation>, String> {
        self.register_inner(window, project, id, token, true)
    }
    fn register_inner(
        &self,
        window: &str,
        project: &str,
        id: &str,
        token: CancellationToken,
        verification: bool,
    ) -> Result<Arc<Operation>, String> {
        if id.is_empty() || id.len() > 200 {
            return Err("Invalid compilation identity".into());
        }
        let key = (window.into(), project.into(), id.into());
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.active.contains_key(&key) {
            return Err("Compilation identity is already active".into());
        }
        if entries.cancelled.contains(&key) {
            token.cancel();
        }
        let operation = Arc::new(Operation::new(token, verification, key.clone()));
        entries.active.insert(key, operation.clone());
        Ok(operation)
    }
    pub fn finish(
        &self,
        window: &str,
        project: &str,
        id: &str,
        operation: &Operation,
        error: Option<&str>,
    ) -> bool {
        let cancelled = operation.finish(error);
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .remove(&(window.into(), project.into(), id.into()));
        cancelled
    }
    pub async fn cancel(&self, window: &str, project: &str, ids: &[String]) -> Result<(), String> {
        if ids.len() > 64 || ids.iter().any(|id| id.is_empty() || id.len() > 200) {
            return Err("Invalid compilation identities".into());
        }
        let operations = {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let mut operations = Vec::new();
            for id in ids {
                let key = (window.into(), project.into(), id.clone());
                if let Some(operation) = entries.active.get(&key) {
                    operation.cancel();
                    operations.push(operation.clone());
                }
                if !entries.cancelled.contains(&key) {
                    entries.cancelled.push_back(key);
                }
            }
            // A started verification event can still be in transit to the
            // renderer. Stop all verification operations already registered for
            // this owner/workspace, including those whose IDs are not visible yet.
            for ((owner, root, _), operation) in &entries.active {
                if owner == window
                    && root == project
                    && operation.verification
                    && !operations.iter().any(|entry| Arc::ptr_eq(entry, operation))
                {
                    operation.cancel();
                    operations.push(operation.clone());
                }
            }
            // Only tombstones are bounded: never evict a live operation.
            while entries.cancelled.len() > 512 {
                entries.cancelled.pop_front();
            }
            operations
        };
        let mut error = None;
        for operation in operations {
            if let Err(failure) = operation.wait().await {
                error.get_or_insert(failure);
            }
        }
        error.map_or(Ok(()), Err)
    }
}

pub fn check(token: &CancellationToken) -> Result<(), String> {
    if token.is_cancelled() {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) -> Result<bool, String> {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if unsafe { kill(-(pid as i32), signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(3) {
        Ok(false)
    } else {
        Err(error.to_string())
    }
}

/// Runs inside spawn_blocking. Keep pipe readers separate so a full compiler
/// output pipe never prevents observing cancellation. The caller owns the build
/// lock until this function confirms tree shutdown and reaps the direct child.
pub fn output(command: &mut Command, token: &CancellationToken) -> Result<Output, String> {
    check(token)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to launch compiler: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or("Missing compiler stdout")?;
    let stderr = child.stderr.take().ok_or("Missing compiler stderr")?;
    let reader = |mut stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).map(|_| bytes)
        })
    };
    let stdout = reader(Box::new(stdout));
    let stderr = reader(Box::new(stderr));
    let result = (|| {
        let mut stopping = None;
        let mut status = None;
        let mut group_exited = false;
        loop {
            if token.is_cancelled() && stopping.is_none() {
                stopping = Some(Instant::now());
                #[cfg(unix)]
                {
                    group_exited =
                        !signal_group(pid, 15).map_err(|e| format!("{CLEANUP_FAILED}: {e}"))?;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let mut terminator = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(0x08000000)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|e| format!("{CLEANUP_FAILED}: {e}"))?;
                    let deadline = Instant::now() + Duration::from_secs(2);
                    loop {
                        match terminator.try_wait() {
                            Ok(Some(status)) if status.success() => break,
                            Ok(Some(status)) => {
                                return Err(format!(
                                    "{CLEANUP_FAILED}: taskkill exited with {status}"
                                ))
                            }
                            Err(error) => {
                                let _ = terminator.kill();
                                let _ = terminator.wait();
                                return Err(format!("{CLEANUP_FAILED}: taskkill: {error}"));
                            }
                            Ok(None) if Instant::now() >= deadline => {
                                let _ = terminator.kill();
                                let _ = terminator.wait();
                                return Err(format!("{CLEANUP_FAILED}: taskkill timed out"));
                            }
                            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                        }
                    }
                }
            }
            if status.is_none() {
                status = child
                    .try_wait()
                    .map_err(|e| format!("{CLEANUP_FAILED}: {e}"))?;
            }
            if let Some(started) = stopping {
                #[cfg(unix)]
                {
                    if !group_exited {
                        group_exited =
                            !signal_group(pid, 0).map_err(|e| format!("{CLEANUP_FAILED}: {e}"))?;
                    }
                    if !group_exited && started.elapsed() >= Duration::from_millis(750) {
                        group_exited =
                            !signal_group(pid, 9).map_err(|e| format!("{CLEANUP_FAILED}: {e}"))?;
                    }
                    // An escaped descendant can retain our pipes after the group
                    // exits. Do not join those readers indefinitely or reuse its
                    // build directory: let the deadline report unconfirmed cleanup.
                    if group_exited
                        && status.is_some()
                        && stdout.is_finished()
                        && stderr.is_finished()
                    {
                        break;
                    }
                }
                #[cfg(not(unix))]
                if status.is_some() && stdout.is_finished() && stderr.is_finished() {
                    break;
                }
                if started.elapsed() > Duration::from_secs(5) {
                    return Err(format!("{CLEANUP_FAILED}: process tree {pid} did not exit"));
                }
            } else if status.is_some() && stdout.is_finished() && stderr.is_finished() {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        let stdout = stdout
            .join()
            .map_err(|_| "Compiler stdout reader panicked")?
            .map_err(|e| e.to_string())?;
        let stderr = stderr
            .join()
            .map_err(|_| "Compiler stderr reader panicked")?
            .map_err(|e| e.to_string())?;
        check(token)?;
        Ok(Output {
            status: status.ok_or("Missing compiler exit status")?,
            stdout,
            stderr,
        })
    })();
    if result.is_err() {
        // Child::drop does not reap. Even when tree cleanup could not be
        // confirmed, terminate/reap the direct child; callers quarantine the
        // work directory and detached pipe readers finish when their writers do.
        let _ = child.kill();
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_is_scoped_and_can_precede_registration() {
        let registry = Registry::default();
        registry
            .cancel("one", "/project", &["old".into()])
            .await
            .unwrap();
        let old = registry
            .register("one", "/project", "old", CancellationToken::new())
            .unwrap();
        assert!(old.check().is_err());
        let other = registry
            .register("two", "/project", "old", CancellationToken::new())
            .unwrap();
        let next = registry
            .register("one", "/project", "next", CancellationToken::new())
            .unwrap();
        assert!(other.check().is_ok());
        assert!(next.check().is_ok());
    }
    #[tokio::test]
    async fn stop_waits_for_cleanup_and_completion_wins_late_stop() {
        let registry = Arc::new(Registry::default());
        let operation = registry
            .register("one", "/p", "a", CancellationToken::new())
            .unwrap();
        let task = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.cancel("one", "/p", &["a".into()]).await })
        };
        operation.token.cancelled().await;
        assert!(!task.is_finished());
        registry.finish("one", "/p", "a", &operation, None);
        task.await.unwrap().unwrap();
        let completed = registry
            .register("one", "/p", "b", CancellationToken::new())
            .unwrap();
        completed.publish(|| ()).unwrap();
        completed.cancel();
        assert!(completed.check().is_ok());
    }
    #[tokio::test]
    async fn stop_cancels_unseen_verification_only_for_its_owner_and_workspace() {
        let registry = Arc::new(Registry::default());
        let verification = registry
            .register_verification("one", "/p", "verify", CancellationToken::new())
            .unwrap();
        let other_window = registry
            .register_verification("two", "/p", "verify", CancellationToken::new())
            .unwrap();
        let other_project = registry
            .register_verification("one", "/other", "verify", CancellationToken::new())
            .unwrap();
        let user = registry
            .register("one", "/p", "user", CancellationToken::new())
            .unwrap();
        let task = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.cancel("one", "/p", &[]).await })
        };
        verification.token.cancelled().await;
        assert!(!other_window.token.is_cancelled());
        assert!(!other_project.token.is_cancelled());
        assert!(!user.token.is_cancelled());
        assert!(!task.is_finished());
        assert!(registry.finish("one", "/p", "verify", &verification, None));
        task.await.unwrap().unwrap();
        let later = registry
            .register_verification("one", "/p", "later", CancellationToken::new())
            .unwrap();
        assert!(!later.token.is_cancelled());
    }

    #[test]
    fn cancelled_output_is_never_published_and_cleanup_failure_is_retained() {
        let operation = Operation::new(
            CancellationToken::new(),
            false,
            ("one".into(), "/p".into(), "a".into()),
        );
        operation.cancel();
        let mut published = false;
        assert_eq!(
            operation
                .publish(|| {
                    published = true;
                })
                .unwrap_err(),
            CANCELLED
        );
        assert!(!published);
        assert!(operation.finish(Some("Compiler cleanup failed: test")));
        assert_eq!(
            operation
                .completion
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap_err(),
            "Compiler cleanup failed: test"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_reaps_compiler_and_term_resistant_descendant() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("pid");
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("trap '' TERM; sh -c 'trap \"\" TERM; echo $$ > \"$1\"; while :; do sleep 1; done' child \"$1\" & wait").arg("parent").arg(&marker);
        let token = CancellationToken::new();
        let cancel = token.clone();
        let marker_copy = marker.clone();
        let stop = std::thread::spawn(move || {
            let start = Instant::now();
            while !marker_copy.exists() && start.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(10));
            }
            cancel.cancel();
        });
        assert_eq!(output(&mut command, &token).unwrap_err(), CANCELLED);
        stop.join().unwrap();
        let pid = std::fs::read_to_string(marker).unwrap();
        let result = Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .status()
            .unwrap();
        assert!(!result.success());
    }
}
