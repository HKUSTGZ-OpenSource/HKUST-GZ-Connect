//! Reproduce parser stack exhaustion in a child so the test runner remains alive.
use ec_compat::xml::{MAX_XML_BYTES, parse_xml};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const WORKER: &str = "HKUSTGZ_XML_DEPTH_WORKER";
const SUCCESS: &str = "SYNTHETIC_XML_DEPTH_PARSE_OK";

#[test]
fn deeply_nested_xml_is_parsed_without_process_abort() {
    if std::env::var_os(WORKER).is_some() {
        let depth = 200_000;
        let xml = format!("{}leaf{}", "<n>".repeat(depth), "</n>".repeat(depth));
        assert!(xml.len() < MAX_XML_BYTES);
        let document = parse_xml(xml.as_bytes(), "synthetic nested XML").unwrap();
        assert_eq!(document.root_element().tag_name().name(), "n");
        assert_eq!(
            document
                .descendants()
                .filter(|node| node.is_element())
                .count(),
            depth
        );
        assert_eq!(
            document
                .descendants()
                .rfind(|node| node.is_element())
                .unwrap()
                .text(),
            Some("leaf")
        );
        println!("{SUCCESS}");
        return;
    }

    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "deeply_nested_xml_is_parsed_without_process_abort",
            "--nocapture",
        ])
        .env(WORKER, "1")
        .env("RUST_MIN_STACK", "2097152")
        .env("RUST_BACKTRACE", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait_with_output();
            panic!("synthetic XML parser subprocess exceeded its deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "synthetic XML parser child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(SUCCESS),
        "parser worker did not run"
    );
}
