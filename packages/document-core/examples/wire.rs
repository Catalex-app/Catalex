//! Line-delimited test driver for comparing native and WebAssembly execution.
use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let diff = std::env::args().any(|arg| arg == "--diff");
    let stdout = io::stdout();
    let mut output = stdout.lock();
    for line in io::stdin().lock().lines() {
        let line = line?;
        let result = if diff {
            catalex_document_core::diff_json(line.as_bytes())
        } else {
            catalex_document_core::apply_json(line.as_bytes())
        };
        output.write_all(&result)?;
        output.write_all(b"\n")?;
    }
    Ok(())
}
