//! Exercise cancellation through the real service pipe. A controllable compiler
//! keeps the first build in flight while its window closes and another compiles.
#![cfg(unix)]

use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

struct ServiceProcess {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Value>,
    directory: tempfile::TempDir,
}

impl ServiceProcess {
    fn start() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir(root.join("project")).unwrap();
        std::fs::write(root.join("project/main.tex"), "document").unwrap();
        let compiler = root.join("latexmk");
        std::fs::write(
            &compiler,
            r#"#!/bin/sh
if mkdir "$CATALEX_TEST_DIR/first-started" 2>/dev/null; then
  while [ ! -e "$CATALEX_TEST_DIR/release-first" ]; do sleep 0.01; done
else
  touch "$CATALEX_TEST_DIR/second-started"
fi
printf '%s' '%PDF-test' > main.pdf
"#,
        )
        .unwrap();
        std::fs::set_permissions(&compiler, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_catalex-desktop"))
            .env("PATH", format!("{}:/usr/bin:/bin", root.display()))
            .env("CATALEX_DATA_DIR", root.join("data"))
            .env("CATALEX_CACHE_DIR", root.join("cache"))
            .env(
                "CATALEX_RESOURCE_DIR",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
            )
            .env("CATALEX_TEST_DIR", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let message = serde_json::from_str(&line.unwrap()).unwrap();
                if sender.send(message).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
            directory,
        }
    }

    fn send(&mut self, id: u64, window: &str, command: &str, args: Value) {
        let input = self.input.as_mut().unwrap();
        writeln!(
            input,
            "{}",
            json!({"id": id, "windowId": window, "command": command, "args": args})
        )
        .unwrap();
        input.flush().unwrap();
    }

    fn response(&self, id: u64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let message = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return message;
            }
        }
    }

    fn compile(&mut self, id: u64, window: &str) {
        self.send(
            id,
            window,
            "compile_latex",
            json!({
                "projectDir": self.directory.path().join("project"),
                "mainFile": "main.tex", "backend": "latexmk", "diagnostics": {"__channel": id}
            }),
        );
    }

    fn release_compiler(&self) {
        std::fs::write(self.directory.path().join("release-first"), "").unwrap();
    }
}

impl Drop for ServiceProcess {
    fn drop(&mut self) {
        // Always release the fixture child, even when a regression assertion fails.
        self.release_compiler();
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn pi_version_probe_receives_eof_without_consuming_service_requests() {
    let mut service = ServiceProcess::start();
    let pi = service.directory.path().join("pi");
    std::fs::write(
        &pi,
        "#!/bin/sh\ncat > \"$CATALEX_TEST_DIR/pi-stdin\"\nprintf '1.2.0\\n'\n",
    )
    .unwrap();
    std::fs::set_permissions(&pi, std::fs::Permissions::from_mode(0o755)).unwrap();
    service.send(1, "probe", "check_pi_status", json!({}));
    let status = service.response(1);
    assert_eq!(status["result"]["version"], "1.2.0", "{status}");
    assert!(std::fs::read(service.directory.path().join("pi-stdin"))
        .unwrap()
        .is_empty());
    service.send(2, "probe", "__ping", json!({}));
    assert!(service.response(2).get("result").is_some());
    service.input.take();
    assert!(service.child.wait().unwrap().success());
}

#[test]
fn closing_a_window_keeps_its_compiler_lock_until_the_process_finishes() {
    let mut service = ServiceProcess::start();
    service.compile(1, "first");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !service.directory.path().join("first-started").exists() {
        assert!(Instant::now() < deadline, "First compiler did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    service.send(2, "first", "__close_window", json!({}));
    assert_eq!(service.response(2), json!({"id": 2, "result": null}));
    service.compile(3, "second");
    service.send(4, "other", "__ping", json!({}));
    assert!(
        service.response(4).get("result").is_some(),
        "Other windows must remain responsive"
    );
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        !service.directory.path().join("second-started").exists(),
        "Closing the first window released its build lock while the compiler still ran"
    );
    service.release_compiler();
    assert_eq!(service.response(3)["result"], json!(b"%PDF-test".to_vec()));
    assert!(service.directory.path().join("second-started").exists());
    service.input.take();
    assert!(service.child.wait().unwrap().success());
}
