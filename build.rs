use std::path::Path;

fn main() {
    let dist = Path::new("web/dist");
    if !dist.exists() {
        // Keep `cargo build` working on a fresh clone before the UI is built.
        std::fs::create_dir_all(dist).expect("creating web/dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><meta charset=\"utf-8\"><title>vmdash</title>\
             <body style=\"background:#0a0c0f;color:#e7eef6;font-family:system-ui;padding:40px\">\
             <h1>vmdash</h1><p>The UI has not been built yet.</p>\
             <pre>cd web &amp;&amp; npm install &amp;&amp; npm run build</pre>\
             <p>Then restart the server.</p>",
        )
        .expect("writing placeholder index.html");
    }
    println!("cargo:rerun-if-changed=web/dist");
}
