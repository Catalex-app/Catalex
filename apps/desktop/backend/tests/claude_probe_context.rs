//! Metadata requests must not inherit a GUI launch's filesystem-root cwd.
#![cfg(unix)]

use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

struct ProbeService {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Value>,
    directory: tempfile::TempDir,
}

impl ProbeService {
    fn start(fail: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let home = root.join("home");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let cli = bin.join("claude");
        std::fs::write(
            &cli,
            r#"#!/bin/sh
printf '%s\n' "cli:$*" "$(pwd -P)" "$HOME" "$CLAUDE_CONFIG_DIR" >> "$CATALEX_TEST_PROBE_LOG"
case "$1" in
  --version) printf '2.1.fixture\n';;
  auth) printf '{"loggedIn":true}\n';;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bridge = root.join("bridge.sh");
        std::fs::write(&bridge, r#"printf '%s\n' "$1" "$(pwd -P)" "$HOME" "$CLAUDE_CONFIG_DIR" "$3" >> "$CATALEX_TEST_PROBE_LOG"
if [ "$CATALEX_TEST_PROBE_FAIL" = 1 ]; then printf 'fixture failed\n' >&2; exit 9; fi
case "$1" in
  --list-models) printf '[{"value":"fixture","displayName":"Fixture"}]\n';;
  --subscription-usage) printf '{"five_hour":null}\n';;
  --verify-model) printf '{"id":"fixture"}\n';;
esac
"#).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_catalex-desktop"))
            .current_dir("/")
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .env("CLAUDE_CONFIG_DIR", root.join("account config"))
            .env("CATALEX_NODE_EXECUTABLE", "/bin/sh")
            .env("CATALEX_CLAUDE_BRIDGE", &bridge)
            .env("CATALEX_TEST_PROBE_LOG", root.join("probes.log"))
            .env("CATALEX_TEST_PROBE_FAIL", if fail { "1" } else { "0" })
            .env("CATALEX_DATA_DIR", root.join("data"))
            .env("CATALEX_CACHE_DIR", root.join("cache"))
            .env(
                "CATALEX_RESOURCE_DIR",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"),
            )
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

    fn request(&mut self, id: u64, command: &str, args: Value) -> Value {
        let input = self.input.as_mut().unwrap();
        writeln!(
            input,
            "{}",
            json!({ "id": id, "windowId": "test", "command": command, "args": args })
        )
        .unwrap();
        input.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let message = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if message["id"] == id {
                return message;
            }
        }
    }

    fn assert_isolated(&self) {
        let log = std::fs::read_to_string(self.directory.path().join("probes.log")).unwrap();
        let lines: Vec<_> = log.lines().collect();
        let mut index = 0;
        let mut probes = Vec::new();
        while index < lines.len() {
            let kind = lines[index];
            let cwd = PathBuf::from(lines[index + 1]);
            assert!(cwd.is_absolute());
            assert_ne!(cwd, Path::new("/"));
            assert_ne!(cwd, self.directory.path().join("home"));
            assert!(
                !cwd.exists(),
                "temporary directory was retained after {kind}"
            );
            assert_eq!(
                Path::new(lines[index + 2]),
                self.directory.path().join("home")
            );
            assert_eq!(
                Path::new(lines[index + 3]),
                self.directory.path().join("account config")
            );
            if !kind.starts_with("cli:") {
                // macOS temp paths can differ only by the /private alias.
                let argument = lines[index + 4]
                    .strip_prefix("/private")
                    .unwrap_or(lines[index + 4]);
                let physical = lines[index + 1]
                    .strip_prefix("/private")
                    .unwrap_or(lines[index + 1]);
                assert_eq!(
                    argument, physical,
                    "bridge and SDK must use the same folder"
                );
                index += 5;
            } else {
                index += 4;
            }
            probes.push(kind);
        }
        assert!(!probes.is_empty());
    }
}

impl Drop for ProbeService {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn background_checks_keep_account_configuration_and_remove_temporary_folders() {
    let mut service = ProbeService::start(false);
    let status = service.request(1, "check_claude_status", json!({}));
    assert_eq!(status["result"]["authenticated"], true);
    service.assert_isolated();
    for (id, command, args) in [
        (2, "list_claude_models", json!({})),
        (3, "read_claude_subscription_usage", json!({})),
        (4, "verify_claude_model", json!({"modelId": "fixture"})),
    ] {
        let reply = service.request(id, command, args);
        assert!(reply.get("result").is_some(), "{reply}");
        service.assert_isolated();
    }
}

#[test]
fn failed_model_discovery_also_cleans_up_the_probe_directory() {
    let mut service = ProbeService::start(true);
    let reply = service.request(1, "list_claude_models", json!({}));
    assert!(reply["error"].as_str().unwrap().contains("fixture failed"));
    service.assert_isolated();
}
