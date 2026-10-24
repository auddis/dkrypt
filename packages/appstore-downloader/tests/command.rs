use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;
use tempfile::TempDir;

fn invoke(home: &TempDir, request: &str) -> (bool, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_dkrypt-appstore-downloader"))
        .env("HOME", home.path())
        .env("DKRYPT_APPSTORE_CACHE_DIR", home.path().join("cache"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start downloader");
    child
        .stdin
        .take()
        .expect("downloader stdin")
        .write_all(request.as_bytes())
        .expect("send request");
    let output = child.wait_with_output().expect("wait for downloader");
    (
        output.status.success(),
        serde_json::from_slice(&output.stdout).expect("parse downloader response"),
    )
}

#[test]
fn status_reports_missing_account_without_network_access() {
    let home = TempDir::new().expect("create isolated home");
    let (success, response) = invoke(&home, r#"{"operation":"status"}"#);

    assert!(success);
    assert_eq!(
        response,
        serde_json::json!({"ok": true, "authenticated": false})
    );
}

#[test]
fn authentication_rejects_invalid_account_input_before_network_access() {
    let home = TempDir::new().expect("create isolated home");
    let request = r#"{"operation":"authenticate","apple_id":"not-an-email","password":"secret","verification_code":null}"#;
    let (success, response) = invoke(&home, request);

    assert!(!success);
    assert_eq!(
        response,
        serde_json::json!({"ok": false, "stage": "request", "code": "invalid_request"})
    );
}

#[test]
fn download_rejects_invalid_bundle_ids_before_network_access() {
    let home = TempDir::new().expect("create isolated home");
    let request = r#"{"operation":"download","apple_id":"person@example.test","password":"secret","bundle_id":"../outside","external_version_id":null,"output_path":"/tmp/app.ipa"}"#;
    let (success, response) = invoke(&home, request);

    assert!(!success);
    assert_eq!(
        response,
        serde_json::json!({"ok": false, "stage": "request", "code": "invalid_request"})
    );
}

#[test]
fn download_reports_a_safe_failure_stage_when_the_session_is_missing() {
    let home = TempDir::new().expect("create isolated home");
    let request = serde_json::json!({
        "operation": "download",
        "apple_id": "person@example.test",
        "password": "secret",
        "bundle_id": "com.example.app",
        "external_version_id": null,
        "output_path": home.path().join("download.ipa"),
    });
    let (success, response) = invoke(&home, &request.to_string());

    assert!(!success);
    assert_eq!(response["stage"], "session");
    assert_eq!(response["code"], "authentication_required");
}
