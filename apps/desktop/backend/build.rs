fn main() {
    // Cargo can reuse this executable after the checkout is moved. Read the
    // current manifest directory at execution time instead of embedding it.
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .expect("Cargo must provide CARGO_MANIFEST_DIR");
    let brand_path = std::path::PathBuf::from(manifest_dir).join("../../../branding.json");
    println!("cargo:rerun-if-changed={}", brand_path.display());
    let brand: serde_json::Value = serde_json::from_slice(
        &std::fs::read(brand_path).unwrap_or_else(|error| panic!("Cannot read branding.json: {error}")),
    ).unwrap_or_else(|error| panic!("Invalid branding.json: {error}"));
    for (field, key) in [("productName", "APP_BRAND_NAME"), ("namespace", "APP_BRAND_NAMESPACE")] {
        let value = brand[field].as_str().unwrap_or_else(|| panic!("Missing branding field: {field}"));
        println!("cargo:rustc-env={key}={value}");
    }
    // Embed ZOTERO credentials at compile time from .env file or system env
    let _ = dotenvy::dotenv(); // load .env if present (local dev)
    for key in ["ZOTERO_CONSUMER_KEY", "ZOTERO_CONSUMER_SECRET"] {
        if let Ok(val) = std::env::var(key) {
            println!("cargo:rustc-env={key}={val}");
        }
    }
}
