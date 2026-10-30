pub(crate) fn validate_model_id(id: &str) -> Result<(), String> {
    let base = id.strip_suffix("[1m]").unwrap_or(id);
    if id.len() > 200
        || base.is_empty()
        || !base.as_bytes()[0].is_ascii_alphanumeric()
        || !base
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
        || id.eq_ignore_ascii_case("opusplan")
    {
        return Err("Enter a valid model ID without spaces.".to_string());
    }
    Ok(())
}

/// Only a completed provider turn is proof of access, not a started thread or an exit code.
pub(crate) fn check_codex_probe(stdout: &[u8]) -> Result<(), String> {
    let mut completed = false;
    for line in String::from_utf8_lossy(stdout).lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match event.get("type").and_then(serde_json::Value::as_str) {
            Some("turn.completed") => completed = true,
            Some("error" | "turn.failed") => {
                return Err(event
                    .pointer("/error/message")
                    .or_else(|| event.get("message"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Codex could not verify this model.")
                    .to_string());
            }
            _ => {}
        }
    }
    if completed {
        Ok(())
    } else {
        Err("Codex ended without verifying this model.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_rejects_flags_and_invalid_ids() {
        for id in [
            "",
            "--model",
            "model name",
            "opusplan",
            "a;echo",
            "a[1m]suffix",
        ] {
            assert!(validate_model_id(id).is_err());
        }
        for id in ["gpt-5.4", "claude-opus-4-6[1m]", "vendor/model:1"] {
            assert!(validate_model_id(id).is_ok());
        }
    }
    #[test]
    fn requires_completed_turn_and_rejects_provider_errors() {
        assert!(check_codex_probe(br#"{"type":"thread.started"}"#).is_err());
        assert!(check_codex_probe(br#"{"type":"turn.completed"}"#).is_ok());
        assert_eq!(
            check_codex_probe(br#"{"type":"turn.failed","error":{"message":"Unknown model"}}"#)
                .unwrap_err(),
            "Unknown model"
        );
    }
}
