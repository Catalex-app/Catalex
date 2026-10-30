//! Window-scoped recovery at the failed Git subprocess boundary.
use crate::host::WindowContext;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Url;
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::HashMap,
    io::Write,
    process::{Command, Output, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};

thread_local! { static WINDOW: RefCell<Option<WindowContext>> = const { RefCell::new(None) }; }
pub fn with_window<T>(window: WindowContext, action: impl FnOnce() -> T) -> T {
    struct Reset(Option<WindowContext>);
    impl Drop for Reset {
        fn drop(&mut self) {
            WINDOW.with(|slot| {
                slot.replace(self.0.take());
            });
        }
    }
    let _reset = Reset(WINDOW.with(|slot| slot.replace(Some(window))));
    action()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prompt {
    id: String,
    project_root: String,
    host: String,
    provider: String,
    username: String,
    action: String,
    remote_branch: Option<String>,
    commands: Vec<String>,
}
#[derive(Clone)]
struct Pending {
    window: WindowContext,
    prompt: Prompt,
    url: String,
    resume: mpsc::Sender<()>,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(Default::default)
}

pub fn close_window(window: &str) {
    if let Ok(mut requests) = pending().lock() {
        requests.retain(|_, request| request.window.id != window);
    }
}

pub fn is_auth_failure(output: &Output) -> bool {
    if output.status.success() {
        return false;
    }
    let error = String::from_utf8_lossy(&output.stderr).to_lowercase();
    [
        "authentication failed",
        "http basic: access denied",
        "invalid username or password",
        "invalid username or token",
        "could not read username for 'https://",
        "could not read password for 'https://",
        "requested url returned error: 401",
        "authentication required",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

fn raw(root: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C")
        .output()
        .map_err(|_| "Could not start Git".to_string())
}
fn read(root: &str, args: &[&str]) -> Option<String> {
    let output = raw(root, args).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}
fn quote(arg: &str) -> String {
    if arg
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_./:@%+=,-".contains(c))
    {
        arg.into()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}
fn context(root: &str, args: &[&str]) -> Option<(Prompt, String)> {
    let action = *args.first()?;
    if !matches!(action, "push" | "pull" | "fetch" | "ls-remote") {
        return None;
    }
    let local_branch = read(root, &["branch", "--show-current"]);
    let explicit = args
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .copied();
    let branch_config = |key: &str| {
        local_branch.as_ref().and_then(|branch| {
            read(
                root,
                &["config", "--get", &format!("branch.{branch}.{key}")],
            )
        })
    };
    let remote = explicit
        .map(str::to_string)
        .or_else(|| {
            if action == "push" {
                branch_config("pushRemote")
                    .or_else(|| read(root, &["config", "--get", "remote.pushDefault"]))
            } else {
                None
            }
        })
        .or_else(|| branch_config("remote"))
        .unwrap_or_else(|| "origin".into());
    let url = if remote.starts_with("https://") {
        remote.clone()
    } else {
        let mut query = vec!["remote", "get-url"];
        if action == "push" {
            query.push("--push");
        }
        query.extend(["--all", &remote]);
        let urls = read(root, &query)?;
        if urls.lines().count() != 1 {
            return None;
        }
        urls
    };
    let mut parsed = Url::parse(&url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?.to_string();
    let username = if host == "git.overleaf.com" {
        "git".into()
    } else {
        parsed.username().to_string()
    };
    parsed.set_username("").ok()?;
    parsed.set_password(None).ok()?;
    let clean_url = parsed.to_string();
    let provider = match host.as_str() {
        "git.overleaf.com" => "Overleaf",
        "github.com" => "GitHub",
        "gitlab.com" => "GitLab",
        "bitbucket.org" => "Bitbucket",
        _ => "Git over HTTPS",
    }
    .into();
    let branch = if let Some(index) = args.iter().position(|arg| *arg == remote) {
        args.get(index + 1)
            .filter(|arg| !arg.starts_with('-'))
            .map(|arg| {
                arg.rsplit(':')
                    .next()
                    .unwrap_or(arg)
                    .trim_start_matches("refs/heads/")
                    .to_string()
            })
    } else {
        None
    }
    .or_else(|| {
        branch_config("merge").map(|branch| branch.trim_start_matches("refs/heads/").to_string())
    });
    let remote_branch = branch
        .filter(|_| !remote.contains("://"))
        .map(|branch| format!("{remote}/{branch}"));
    let display = args
        .iter()
        .map(|arg| {
            if *arg == url {
                quote(&clean_url)
            } else {
                quote(arg)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some((
        Prompt {
            id: uuid::Uuid::new_v4().to_string(),
            project_root: root.into(),
            host: parsed.authority().to_string(),
            provider,
            username,
            action: match action {
                "ls-remote" => "Check remote",
                "push" => "Push",
                "pull" => "Pull",
                _ => "Fetch",
            }
            .into(),
            remote_branch,
            commands: vec!["git credential approve".into(), format!("git {display}")],
        },
        clean_url,
    ))
}

pub fn run(root: &str, args: &[&str]) -> Result<Output, String> {
    let mut output = raw(root, args)?;
    let window = WINDOW.with(|slot| slot.borrow().clone());
    let Some(window) = window else {
        return Ok(output);
    };
    while is_auth_failure(&output) {
        let Some((prompt, url)) = context(root, args) else {
            break;
        };
        let (resume, receiver) = mpsc::channel();
        let id = prompt.id.clone();
        pending()
            .lock()
            .map_err(|_| "Credential request unavailable")?
            .insert(
                id.clone(),
                Pending {
                    window: window.clone(),
                    prompt: prompt.clone(),
                    url,
                    resume,
                },
            );
        if window.emit("git-credential-request", &prompt).is_err() {
            pending()
                .lock()
                .map_err(|_| "Credential request unavailable")?
                .remove(&id);
            break;
        }
        let accepted = receiver.recv_timeout(Duration::from_secs(300)).is_ok();
        pending()
            .lock()
            .map_err(|_| "Credential request unavailable")?
            .remove(&id);
        let _ = window.emit("git-credential-closed", &id);
        if !accepted {
            break;
        }
        output = raw(root, args)?;
    }
    Ok(output)
}

fn credential(root: &str, action: &str, input: &str) -> Result<Output, String> {
    let mut child = Command::new("git")
        .current_dir(root)
        .args(["credential", action])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not access the Git credential helper")?;
    let written = child
        .stdin
        .take()
        .ok_or("Credential input unavailable")?
        .write_all(input.as_bytes());
    let output = child
        .wait_with_output()
        .map_err(|_| "Could not access the Git credential helper")?;
    written.map_err(|_| "Could not send credentials to Git")?;
    Ok(output)
}

pub fn respond(
    window: &str,
    id: String,
    username: Option<String>,
    token: Option<String>,
) -> Result<(), String> {
    let request = pending()
        .lock()
        .map_err(|_| "Credential request unavailable")?
        .get(&id)
        .cloned()
        .filter(|request| request.window.id == window)
        .ok_or("This credential request is no longer active")?;
    let Some(token) = token else {
        pending()
            .lock()
            .map_err(|_| "Credential request unavailable")?
            .remove(&id);
        return Ok(());
    };
    let username = if !request.prompt.username.is_empty() {
        request.prompt.username.clone()
    } else {
        username.unwrap_or_default().trim().to_string()
    };
    let token = token.trim();
    if username.is_empty()
        || token.is_empty()
        || username.contains(['\n', '\r', '\0'])
        || token.contains(['\n', '\r', '\0'])
    {
        return Err("Enter a valid username and access token".into());
    }
    // Validate without modifying the repository or persisting unverified credentials.
    let output = Command::new("git")
        .current_dir(&request.prompt.project_root)
        .args(["-c", "credential.helper=", "ls-remote", "--", &request.url])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_COUNT", "2")
        .env(
            "GIT_CONFIG_KEY_0",
            format!("http.{}.extraheader", request.url),
        )
        .env(
            "GIT_CONFIG_VALUE_0",
            format!(
                "Authorization: Basic {}",
                STANDARD.encode(format!("{username}:{token}"))
            ),
        )
        .env("GIT_CONFIG_KEY_1", "http.followRedirects")
        .env("GIT_CONFIG_VALUE_1", "false")
        .output()
        .map_err(|_| "Could not verify credentials")?;
    if !output.status.success() {
        return Err(if is_auth_failure(&output) { "Authentication failed. Check your username and token, and make sure they have access to this repository." } else { "Could not verify access to this repository. Check the connection and repository permissions, then try again." }.into());
    }
    if !pending()
        .lock()
        .map_err(|_| "Credential request unavailable")?
        .contains_key(&id)
    {
        return Err("This credential request is no longer active".into());
    }
    let input = format!(
        "url={}\nusername={username}\npassword={token}\n\n",
        request.url
    );
    if !credential(&request.prompt.project_root, "approve", &input)?
        .status
        .success()
    {
        return Err("Git could not save the credentials".into());
    }
    let filled = credential(
        &request.prompt.project_root,
        "fill",
        &format!("url={}\nusername={username}\n\n", request.url),
    )?;
    if !filled.status.success()
        || !String::from_utf8_lossy(&filled.stdout)
            .lines()
            .any(|line| line.strip_prefix("password=") == Some(token))
    {
        return Err(
            "Git could not remember the token. Configure a Git credential helper and try again."
                .into(),
        );
    }
    let active = pending()
        .lock()
        .map_err(|_| "Credential request unavailable")?
        .remove(&id)
        .ok_or("This credential request is no longer active")?;
    active
        .resume
        .send(())
        .map_err(|_| "The Git operation is no longer waiting".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output(error: &str) -> Output {
        let mut output = Command::new("git")
            .arg("--invalid-test-option")
            .output()
            .unwrap();
        output.stderr = error.as_bytes().to_vec();
        output
    }
    #[test]
    fn auth_detection_excludes_network_permission_and_merge_failures() {
        for error in [
            "fatal: Authentication failed for 'https://host/repo'",
            "fatal: could not read Username for 'https://host': terminal prompts disabled",
            "remote: HTTP Basic: Access denied",
            "fatal: requested URL returned error: 401",
        ] {
            assert!(is_auth_failure(&output(error)), "{error}");
        }
        for error in [
            "Could not resolve host",
            "Connection timed out",
            "SSL certificate problem",
            "Permission denied (publickey)",
            "requested URL returned error: 403",
            "repository not found",
            "non-fast-forward",
            "CONFLICT (content): Merge conflict",
        ] {
            assert!(!is_auth_failure(&output(error)), "{error}");
        }
    }
    #[test]
    fn context_uses_push_url_and_redacts_url_passwords() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        for args in [
            vec!["init"],
            vec![
                "remote",
                "add",
                "origin",
                "https://git.overleaf.com/project",
            ],
            vec![
                "remote",
                "set-url",
                "--push",
                "origin",
                "https://alex:secret@github.com/team/repo",
            ],
        ] {
            assert!(raw(root, &args).unwrap().status.success());
        }
        let (prompt, url) = context(root, &["push", "origin", "HEAD:refs/heads/paper"]).unwrap();
        assert_eq!(prompt.host, "github.com");
        assert_eq!(prompt.username, "alex");
        assert_eq!(prompt.remote_branch.as_deref(), Some("origin/paper"));
        assert_eq!(url, "https://github.com/team/repo");
        assert!(!serde_json::to_string(&prompt).unwrap().contains("secret"));
        assert!(context(root, &["push", "git@github.com:team/repo"]).is_none());
        assert!(context(root, &["merge", "origin/main"]).is_none());
        let (direct, _) = context(
            root,
            &[
                "ls-remote",
                "--",
                "https://alex:secret@github.com/team/repo",
            ],
        )
        .unwrap();
        assert!(!direct.commands.join(" ").contains("secret"));
    }
}
