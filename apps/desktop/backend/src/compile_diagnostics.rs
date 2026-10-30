use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize, PartialEq)]
pub struct CompileDiagnostic {
    pub severity: &'static str,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub end_line: Option<u32>,
}

fn number_prefix(text: &str) -> Option<u32> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|number| *number > 0)
}

fn source_lines(message: &str) -> Option<(u32, u32)> {
    for marker in ["on input line ", "at lines ", "at line "] {
        if let Some((_, tail)) = message.rsplit_once(marker) {
            let first = number_prefix(tail)?;
            let last = tail
                .split_once("--")
                .and_then(|(_, value)| number_prefix(value));
            return Some((first, last.unwrap_or(first).max(first)));
        }
    }
    message
        .strip_prefix("l.")
        .and_then(number_prefix)
        .map(|line| (line, line))
}

fn normalize_file(file: &str) -> String {
    file.trim_matches('"')
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

fn file_line_message(line: &str) -> Option<(String, u32, &str)> {
    // Match from the right-hand numeric separator, allowing drive letters and spaces in paths.
    for (offset, _) in line.match_indices(':') {
        let rest = &line[offset + 1..];
        let (number, message) = rest.split_once(':')?;
        if let Ok(number) = number.parse::<u32>() {
            let file = &line[..offset];
            if number > 0 && file.contains('.') {
                return Some((normalize_file(file), number, message.trim()));
            }
        }
    }
    None
}

fn severity(message: &str, located_error: bool) -> Option<&'static str> {
    if message.contains("Warning:")
        || message.starts_with("warning:")
        || message.starts_with("Overfull \\hbox")
        || message.starts_with("Underfull \\hbox")
        || message.starts_with("Overfull \\vbox")
        || message.starts_with("Underfull \\vbox")
    {
        Some("warning")
    } else if located_error
        || message.starts_with('!')
        || message.contains("Error:")
        || message.starts_with("error:")
    {
        Some("error")
    } else {
        None
    }
}

fn input_token(text: &str) -> Option<&str> {
    let token = if let Some(quoted) = text.strip_prefix('"') {
        quoted.split_once('"')?.0
    } else {
        text.split(|c: char| c.is_whitespace() || c == '(' || c == ')')
            .next()?
    };
    let extension = token.rsplit_once('.')?.1;
    matches!(
        extension,
        "tex"
            | "ltx"
            | "sty"
            | "cls"
            | "clo"
            | "aux"
            | "def"
            | "cfg"
            | "fd"
            | "ldf"
            | "out"
            | "toc"
            | "bbl"
            | "bib"
            | "bst"
    )
    .then_some(token)
}

fn update_inputs(line: &str, stack: &mut Vec<Option<String>>) {
    let mut offset = 0;
    while offset < line.len() {
        let character = line[offset..].chars().next().unwrap();
        if character == '(' {
            let tail = &line[offset + 1..];
            let file = input_token(tail);
            stack.push(file.map(normalize_file));
            if let Some(file) = file {
                offset += 1 + file.len() + if tail.starts_with('"') { 2 } else { 0 };
                continue;
            }
        } else if character == ')' {
            stack.pop();
        }
        offset += character.len_utf8();
    }
}

/// Parse the final TeX engine log. Summary/package warnings without a source
/// line stay unlocated; never manufacture a line from the active editor.
pub fn extract_compile_diagnostics(log: &str) -> Vec<CompileDiagnostic> {
    let lines: Vec<&str> = log.lines().collect();
    let mut diagnostics = Vec::new();
    let mut inputs: Vec<Option<String>> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let text = lines[index].trim();
        let explicit = file_line_message(text);
        let message = explicit
            .as_ref()
            .map(|(_, _, message)| *message)
            .unwrap_or(text);
        let Some(severity) = severity(message, explicit.is_some()) else {
            update_inputs(text, &mut inputs);
            index += 1;
            continue;
        };
        let file = explicit
            .as_ref()
            .map(|(file, _, _)| file.clone())
            .or_else(|| inputs.iter().rev().find_map(Clone::clone));
        let mut message = message.to_string();
        let mut location = explicit
            .as_ref()
            .map(|(_, line, _)| (*line, *line))
            .or_else(|| source_lines(&message));
        // TeX wraps warnings and writes error positions on a subsequent `l.N` line.
        // Stop at structural/new diagnostic lines so a location cannot leak between issues.
        let mut consumed = index;
        for (next, raw) in lines.iter().enumerate().skip(index + 1).take(12) {
            let continuation = raw.trim();
            if continuation.is_empty() {
                if severity == "error" {
                    consumed = next;
                    continue;
                }
                break;
            }
            if continuation.starts_with(')')
                || file_line_message(continuation).is_some()
                || self::severity(continuation, false).is_some()
                || (continuation.starts_with('(') && input_token(&continuation[1..]).is_some())
            {
                break;
            }
            if let Some(position) = continuation.strip_prefix("l.").and_then(number_prefix) {
                location = Some((position, position));
                consumed = next;
                break;
            }
            // A location at the print boundary may be only the first digit(s):
            // XeTeX can emit `on input line 8` followed by `2.` on the next line.
            // Finish that token before using its number or exposing its message.
            let wrapped_location = lines[next - 1].len() >= 78
                && message.ends_with(|c: char| c.is_ascii_digit() || c == '-')
                && continuation.starts_with(|c: char| c.is_ascii_digit() || c == '.' || c == '-');
            if severity == "warning"
                && (location.is_none() || wrapped_location)
                && message.len() < 1000
            {
                // Warning continuation lines are indented, package-prefixed, or wrapped at 79 columns.
                if raw.starts_with(char::is_whitespace)
                    || continuation.starts_with('(')
                    || lines[next - 1].len() >= 78
                    || continuation.starts_with("line ")
                {
                    // The engine hard-wraps at its print width, including inside words.
                    if lines[next - 1].len() < 78 || raw.starts_with(char::is_whitespace) {
                        message.push(' ');
                    }
                    message.push_str(continuation);
                    location = source_lines(&message);
                    consumed = next;
                } else {
                    break;
                }
            } else if severity != "error" {
                break;
            }
        }
        let diagnostic = CompileDiagnostic {
            severity,
            message: message.chars().take(1000).collect(),
            file,
            line: location.map(|(first, _)| first),
            end_line: location.map(|(_, last)| last),
        };
        if !diagnostics.contains(&diagnostic) {
            diagnostics.push(diagnostic);
        }
        index = consumed + 1;
    }
    diagnostics.sort_by_key(|diagnostic| diagnostic.severity != "error");
    diagnostics.truncate(100);
    diagnostics
}

/// Convert paths from the isolated build copy back to project-relative paths.
/// External package paths remain external and are never attached to a project file.
pub fn project_locations(diagnostics: &mut [CompileDiagnostic], build: &Path) {
    for diagnostic in diagnostics {
        if let Some(file) = &diagnostic.file {
            let path = Path::new(file);
            let relative = path.strip_prefix(build).unwrap_or(path);
            let mut normalized = PathBuf::new();
            for component in relative.components() {
                match component {
                    Component::CurDir => {}
                    Component::ParentDir
                        if matches!(
                            normalized.components().next_back(),
                            Some(Component::Normal(_))
                        ) =>
                    {
                        normalized.pop();
                    }
                    other => normalized.push(other.as_os_str()),
                }
            }
            diagnostic.file = Some(normalized.to_string_lossy().replace('\\', "/"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_file_line_errors_and_keeps_global_messages_unlocated() {
        let diagnostics = extract_compile_diagnostics("C:/paper with spaces/main.tex:9: Undefined control sequence.\nLaTeX Warning: There were undefined references.\n");
        assert_eq!(
            diagnostics[0].file.as_deref(),
            Some("C:/paper with spaces/main.tex")
        );
        assert_eq!(diagnostics[0].line, Some(9));
        assert_eq!(diagnostics[1].line, None);
    }

    #[test]
    fn maps_build_paths_without_turning_external_packages_into_project_files() {
        let mut diagnostics = extract_compile_diagnostics("/tmp/build/sections/../main.tex:4: Undefined command.\n/texlive/package.sty:8: Undefined command.");
        project_locations(&mut diagnostics, Path::new("/tmp/build"));
        assert_eq!(diagnostics[0].file.as_deref(), Some("main.tex"));
        assert_eq!(diagnostics[1].file.as_deref(), Some("/texlive/package.sty"));
    }

    #[test]
    fn finds_error_lines_after_tex_help_text_and_blank_lines() {
        let diagnostics = extract_compile_diagnostics("(./main.tex\n! LaTeX Error: Missing package.\n\nSee the LaTeX manual for explanation.\nType H <return> for immediate help.\n ...\n\nl.23 \\begin{document}\n)");
        assert_eq!(diagnostics[0].line, Some(23));
    }

    #[test]
    fn rejoins_engine_wrapping_inside_location_words() {
        let first = format!("LaTeX Warning: {} on input li", "x".repeat(51));
        assert_eq!(first.len(), 78);
        let diagnostics = extract_compile_diagnostics(&format!("(./main.tex\n{first}\nne 42.\n)"));
        assert_eq!(diagnostics[0].line, Some(42));
    }

    #[test]
    fn rejoins_citation_line_numbers_split_at_engine_print_width() {
        // Real XeTeX output: both first lines are exactly 79 columns.
        let log = "(./iclr2026/iclr2026_conference.tex\n\nPackage natbib Warning: Citation `flux2024' on page 1 undefined on input line 8\n2.\n\nPackage natbib Warning: Citation `flux2024' on page 7 undefined on input line 2\n51.\n\n)";
        let diagnostics = extract_compile_diagnostics(log);
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].line, Some(82));
        assert_eq!(diagnostics[1].line, Some(251));
        assert!(diagnostics[0].message.ends_with("on input line 82."));
        assert!(diagnostics[1].message.ends_with("on input line 251."));
        assert_eq!(
            diagnostics[0].file.as_deref(),
            Some("iclr2026/iclr2026_conference.tex")
        );
    }

    #[test]
    fn preserves_repeated_messages_at_distinct_source_lines() {
        let diagnostics = extract_compile_diagnostics("(./main.tex\nLaTeX Warning: Missing reference on input line 2.\nLaTeX Warning: Missing reference on input line 8.\n)");
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[1].line, Some(8));
    }

    #[test]
    fn preserves_parent_context_across_package_and_nested_input_files() {
        let diagnostics = extract_compile_diagnostics("(./main.tex\n(/texlive/article.cls\nDocument Class: article (test)\n)\n(./sections/child.tex\nLaTeX Warning: Missing reference on input line 3.\n)\nLaTeX Warning: Missing reference on input line 9.\n)");
        assert_eq!(diagnostics[0].file.as_deref(), Some("sections/child.tex"));
        assert_eq!(diagnostics[1].file.as_deref(), Some("main.tex"));
    }
}
