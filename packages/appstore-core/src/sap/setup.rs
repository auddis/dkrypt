use crate::client::AppleClient;
use crate::error::ClientError;
use std::collections::HashMap;
use std::time::Duration;
use url::Url;
const SETUP_CERT_KEY: &str = "sign-sap-setup-cert";
const SETUP_BUFFER_KEY: &str = "sign-sap-setup-buffer";
const SETUP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SETUP_BODY: usize = 1 << 20;
pub async fn fetch_certificate(client: &AppleClient, url: &Url) -> Result<Vec<u8>, ClientError> {
    let resp = client
        .http()
        .get(url.as_str())
        .timeout(SETUP_TIMEOUT)
        .send()
        .await?;
    let body = read_body(resp, "SAP certificate").await?;
    plist_data(&body, SETUP_CERT_KEY)
}
pub async fn exchange(
    client: &AppleClient,
    url: &Url,
    input: &[u8],
) -> Result<Vec<u8>, ClientError> {
    let mut envelope = plist::Dictionary::new();
    envelope.insert(SETUP_BUFFER_KEY.into(), plist::Value::Data(input.to_vec()));
    let mut request_body = Vec::new();
    plist::to_writer_xml(&mut request_body, &envelope)
        .map_err(|e| ClientError::Sap(format!("encode SAP setup message: {e}")))?;
    let resp = client
        .http()
        .post(url.as_str())
        .header("Content-Type", "application/x-plist")
        .timeout(SETUP_TIMEOUT)
        .body(request_body)
        .send()
        .await?;
    let body = read_body(resp, "SAP setup").await?;
    plist_data(&body, SETUP_BUFFER_KEY)
}
async fn read_body(resp: reqwest::Response, label: &str) -> Result<Vec<u8>, ClientError> {
    let status = resp.status();
    let body = resp.bytes().await?;
    if !status.is_success() {
        return Err(ClientError::Sap(format!(
            "{label} request returned HTTP {status}"
        )));
    }
    if body.len() > MAX_SETUP_BODY {
        return Err(ClientError::Sap(format!(
            "{label} response exceeds {MAX_SETUP_BODY} bytes"
        )));
    }
    Ok(body.to_vec())
}
fn plist_data(document: &[u8], key: &str) -> Result<Vec<u8>, ClientError> {
    let values: HashMap<String, plist::Value> =
        crate::client::plist_xml::parse_plist_response(document)?;
    let value = values
        .get(key)
        .and_then(plist::Value::as_data)
        .ok_or_else(|| ClientError::Sap(format!("Apple plist is missing {key}")))?;
    if value.is_empty() {
        return Err(ClientError::Sap(format!("Apple plist has an empty {key}")));
    }
    Ok(value.to_vec())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_data_value() {
        let document = br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>sign-sap-setup-cert</key>
    <data>AAEC</data>
</dict>
</plist>"#;
        assert_eq!(
            plist_data(document, SETUP_CERT_KEY).unwrap(),
            vec![0x00, 0x01, 0x02]
        );
    }
    #[test]
    fn rejects_missing_key() {
        let document = br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>something-else</key>
    <data>AAEC</data>
</dict>
</plist>"#;
        assert!(plist_data(document, SETUP_CERT_KEY).is_err());
    }
    #[test]
    fn rejects_string_valued_key() {
        let document = br#"<plist>
<dict>
<key>sign-sap-setup-buffer</key>
<string>Error</string>
</dict>
</plist>"#;
        assert!(plist_data(document, SETUP_BUFFER_KEY).is_err());
    }
}
