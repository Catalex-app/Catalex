//! File selection shared by private history and agent drafts. User Git ignore
//! rules do not decide which source files/assets the app protects.
use std::{fs, path::Path};
const INTERNAL: &[&str] = &[
    ".git",
    ".catalex",
    ".texbuddy", // Legacy private metadata remains excluded.
    ".prism",
    "node_modules",
    "target",
    "dist",
    "__pycache__",
    ".cache",
];
const GENERATED: &[&str] = &[
    ".aux",
    ".log",
    ".out",
    ".toc",
    ".lof",
    ".lot",
    ".fls",
    ".fdb_latexmk",
    ".synctex.gz",
    ".bbl",
    ".blg",
    ".nav",
    ".snm",
    ".vrb",
    ".bcf",
    ".run.xml",
];
pub(crate) fn internal(path: &Path) -> bool {
    path.components().any(|part| {
        part.as_os_str()
            .to_str()
            .is_some_and(|name| INTERNAL.contains(&name))
    })
}
pub(crate) fn excluded(root: &Path, path: &Path) -> bool {
    internal(path)
        || path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| {
                [".DS_Store", "Thumbs.db"].contains(&name)
                    || GENERATED.iter().any(|suffix| name.ends_with(suffix))
            })
        || is_recorded_pdf_output(root, path)
}
pub(crate) fn git_excludes() -> String {
    INTERNAL
        .iter()
        .map(|name| format!("{name}/\n"))
        .chain(GENERATED.iter().map(|suffix| format!("*{suffix}\n")))
        .chain([".DS_Store\nThumbs.db\n".to_owned()])
        .collect()
}

// Catalex compiles outside the project. For externally compiled PDFs, only
// exclude files explicitly identified as output by a sibling TeX recorder file.
pub(crate) fn is_recorded_pdf_output(workdir: &Path, path: &Path) -> bool {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return false;
    }
    let full_path = workdir.join(path);
    let Ok(recorder) = fs::read_to_string(full_path.with_extension("fls")) else {
        return false;
    };
    let expected = full_path.canonicalize().ok();
    recorder
        .lines()
        .filter_map(|line| line.strip_prefix("OUTPUT "))
        .any(|output| {
            [
                workdir.join(output),
                full_path.parent().unwrap_or(workdir).join(output),
            ]
            .iter()
            .any(|candidate| expected.is_some() && candidate.canonicalize().ok() == expected)
        })
}
