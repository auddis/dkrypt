use crate::client::AppleClient;
use crate::error::{ClientError, StoreError};
use crate::model::Account;
use futures_util::StreamExt;
use indicatif::{ProgressBar, ProgressStyle};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use tokio::io::AsyncWriteExt;
use url::Url;
#[derive(Debug, Deserialize)]
pub struct DownloadItem {
    #[serde(rename = "URL")]
    pub url: String,
    pub sinfs: Vec<Sinf>,
    #[serde(default)]
    pub metadata: HashMap<String, plist::Value>,
}
impl DownloadItem {
    pub fn latest_external_version_id(&self) -> Option<String> {
        metadata_string(
            &self.metadata,
            &[
                "softwareVersionExternalIdentifier",
                "externalVersionIdentifier",
            ],
        )
    }
}
#[derive(Debug, Clone, Deserialize)]
pub struct Sinf {
    pub id: i64,
    #[serde(with = "serde_bytes")]
    pub sinf: Vec<u8>,
}
mod serde_bytes {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let val = plist::Value::deserialize(deserializer)?;
        match val {
            plist::Value::Data(d) => Ok(d),
            _ => Err(serde::de::Error::custom("expected data")),
        }
    }
}
const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;
pub async fn get_download_info(
    client: &AppleClient,
    app_id: i64,
    account: &Account,
    external_version_id: Option<&str>,
) -> Result<DownloadItem, ClientError> {
    for attempt in 0..MAX_DOWNLOAD_ATTEMPTS {
        match try_get_download_info(client, app_id, account, external_version_id).await {
            Err(ClientError::Store(StoreError::TemporarilyUnavailable))
                if attempt + 1 < MAX_DOWNLOAD_ATTEMPTS =>
            {
                let delay = 5 * (attempt as u64 + 1);
                tracing::warn!(
                    attempt = attempt + 1,
                    delay,
                    "temporarily unavailable, retrying"
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
            other => return other,
        }
    }
    Err(ClientError::Store(StoreError::TemporarilyUnavailable))
}
async fn try_get_download_info(
    client: &AppleClient,
    app_id: i64,
    account: &Account,
    external_version_id: Option<&str>,
) -> Result<DownloadItem, ClientError> {
    let url = download_url(account, client.guid());
    let body_bytes = download_info_request_body(app_id, client.guid(), external_version_id)?;
    let mut dict = post_download_info(client, account, &url, &body_bytes).await?;
    if is_empty_successful_download(&dict) {
        dict = retry_update_product(client, account, &body_bytes).await?;
    }
    download_item_from_response_dict(&dict)
}
fn download_info_request_body(
    app_id: i64,
    guid: &str,
    external_version_id: Option<&str>,
) -> Result<Vec<u8>, ClientError> {
    let mut body = plist::Dictionary::new();
    body.insert(
        "salableAdamId".into(),
        plist::Value::Integer(app_id.into()),
    );
    body.insert(
        "guid".into(),
        plist::Value::String(guid.to_string()),
    );
    body.insert("creditDisplay".into(), plist::Value::String(String::new()));
    body.insert("serialNumber".into(), plist::Value::String("0".into()));
    if let Some(vid) = external_version_id {
        body.insert(
            "externalVersionId".into(),
            plist::Value::String(vid.to_string()),
        );
    }
    let mut body_bytes = Vec::new();
    plist::to_writer_xml(&mut body_bytes, &body)
        .map_err(|e| ClientError::UnexpectedResponse(format!("plist serialize: {e}")))?;
    Ok(body_bytes)
}
async fn post_download_info(
    client: &AppleClient,
    account: &Account,
    url: &str,
    body: &[u8],
) -> Result<HashMap<String, plist::Value>, ClientError> {
    let response = client
        .http()
        .post(url)
        .header("Content-Type", "application/x-apple-plist")
        .header("iCloud-DSID", &account.directory_services_id)
        .header("X-Dsid", &account.directory_services_id)
        .body(body.to_vec())
        .send()
        .await?;
    let status = response.status();
    let response_body = response.bytes().await?;
    tracing::debug!(%status, response_bytes = response_body.len(), "App Store download metadata response received");
    crate::client::plist_xml::parse_plist_response(&response_body)
}
async fn retry_update_product(
    client: &AppleClient,
    account: &Account,
    body: &[u8],
) -> Result<HashMap<String, plist::Value>, ClientError> {
    let config = crate::api::bag::fetch_bag(client).await.map_err(|error| {
        let code = match &error {
            ClientError::Http(error) if error.is_timeout() => "update_product_bag_timed_out",
            ClientError::Http(error) if error.is_connect() => {
                "update_product_bag_network_unavailable"
            }
            _ => "update_product_bag_unavailable",
        };
        ClientError::UnexpectedResponse(code.into())
    })?;
    let endpoint = config
        .update_product_endpoint
        .ok_or_else(|| ClientError::UnexpectedResponse("update_product_endpoint_missing".into()))?;
    let fallback_url = update_product_url(&endpoint, client.guid());
    tracing::info!(
        "legacy App Store download returned no package; retrying Apple's updateProduct endpoint"
    );
    let response = post_download_info(client, account, fallback_url.as_str(), body)
        .await
        .map_err(|error| {
            let code = match &error {
                ClientError::Http(error) if error.is_timeout() => {
                    "update_product_request_timed_out"
                }
                ClientError::Http(error) if error.is_connect() => {
                    "update_product_request_network_unavailable"
                }
                ClientError::PlistDe(_) => "update_product_response_invalid",
                _ => "update_product_request_failed",
            };
            ClientError::UnexpectedResponse(code.into())
        })?;
    if is_empty_successful_download(&response) {
        return Err(ClientError::UnexpectedResponse(
            "update_product_empty_song_list".into(),
        ));
    }
    Ok(response)
}
fn is_empty_successful_download(dict: &HashMap<String, plist::Value>) -> bool {
    if StoreError::from_plist_dict(dict).is_some() {
        return false;
    }
    match dict.get("songList") {
        None => true,
        Some(plist::Value::Array(items)) => items.is_empty(),
        Some(_) => false,
    }
}
fn update_product_url(endpoint: &Url, guid: &str) -> Url {
    let mut url = endpoint.clone();
    url.query_pairs_mut().append_pair("guid", guid);
    url
}
fn download_item_from_response_dict(
    dict: &HashMap<String, plist::Value>,
) -> Result<DownloadItem, ClientError> {
    match StoreError::from_plist_dict(dict) {
        Some(StoreError::LicenseAlreadyExists) => {
            if let Some(item) = download_item_from_dict(dict)? {
                Ok(item)
            } else {
                Err(ClientError::Store(StoreError::PasswordTokenExpired))
            }
        }
        Some(err) => Err(ClientError::Store(err)),
        None => {
            if let Some(item) = download_item_from_dict(dict)? {
                Ok(item)
            } else {
                Err(ClientError::UnexpectedResponse("missing songList".into()))
            }
        }
    }
}
fn download_item_from_dict(
    dict: &HashMap<String, plist::Value>,
) -> Result<Option<DownloadItem>, ClientError> {
    let Some(song_list) = dict.get("songList") else {
        return Ok(None);
    };
    let song_list = song_list
        .as_array()
        .ok_or_else(|| ClientError::UnexpectedResponse("invalid songList".into()))?;
    let first = song_list
        .first()
        .ok_or_else(|| ClientError::UnexpectedResponse("empty songList".into()))?;
    plist::from_value(first)
        .map(Some)
        .map_err(ClientError::PlistDe)
}
fn metadata_string(metadata: &HashMap<String, plist::Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| metadata.get(*key).and_then(metadata_value_to_string))
}
fn metadata_value_to_string(value: &plist::Value) -> Option<String> {
    match value {
        plist::Value::String(s) => Some(s.clone()),
        plist::Value::Integer(i) => i.as_signed().map(|n| n.to_string()),
        _ => None,
    }
}
pub async fn download_file(
    client: &AppleClient,
    url: &str,
    dest: &Path,
    show_progress: bool,
) -> Result<(), ClientError> {
    let existing_size = if dest.exists() {
        tokio::fs::metadata(dest)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    let mut req = client.http().get(url);
    if existing_size > 0 {
        req = req.header("Range", format!("bytes={existing_size}-"));
        tracing::info!(existing_size, "resuming download");
    }
    let resp = req.send().await?;
    if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        tracing::info!("file already fully downloaded");
        return Ok(());
    }
    let total_size = resp.content_length().map(|cl| cl + existing_size);
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dest)
        .await
        .map_err(|e| ClientError::UnexpectedResponse(format!("open file: {e}")))?;
    let pb = if show_progress {
        let pb = match total_size {
            Some(total) => {
                let pb = ProgressBar::new(total);
                pb.set_style(
                    ProgressStyle::default_bar()
                        .template("{msg} [{bar:40}] {bytes}/{total_bytes} ({eta})")
                        .unwrap()
                        .progress_chars("=> "),
                );
                pb.set_position(existing_size);
                pb
            }
            None => {
                let pb = ProgressBar::new_spinner();
                pb.set_style(
                    ProgressStyle::default_spinner()
                        .template("{msg} {bytes} {elapsed}")
                        .unwrap(),
                );
                pb
            }
        };
        pb.set_message("Downloading");
        Some(pb)
    } else {
        None
    };
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)
            .await
            .map_err(|e| ClientError::UnexpectedResponse(format!("write: {e}")))?;
        if let Some(ref pb) = pb {
            pb.inc(chunk.len() as u64);
        }
    }
    file.flush()
        .await
        .map_err(|e| ClientError::UnexpectedResponse(format!("flush: {e}")))?;
    if let Some(pb) = pb {
        pb.finish_with_message("Download complete");
    }
    Ok(())
}
fn download_url(account: &Account, guid: &str) -> String {
    let host = match &account.pod {
        Some(pod) => format!("p{pod}-buy.itunes.apple.com"),
        None => "buy.itunes.apple.com".to_string(),
    };
    format!("https://{host}/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid={guid}")
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample_download_item() -> plist::Value {
        let mut sinf = plist::Dictionary::new();
        sinf.insert("id".into(), plist::Value::Integer(1.into()));
        sinf.insert("sinf".into(), plist::Value::Data(vec![1, 2, 3]));
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert(
            "sinfs".into(),
            plist::Value::Array(vec![plist::Value::Dictionary(sinf)]),
        );
        plist::Value::Dictionary(item)
    }
    #[test]
    fn download_item_wins_over_license_already_exists_marker() {
        let mut dict = HashMap::new();
        dict.insert("failureType".into(), plist::Value::String("5002".into()));
        dict.insert(
            "customerMessage".into(),
            plist::Value::String("license already exists".into()),
        );
        dict.insert(
            "songList".into(),
            plist::Value::Array(vec![sample_download_item()]),
        );
        let item = download_item_from_response_dict(&dict).unwrap();
        assert_eq!(item.url, "https://example.invalid/app.ipa");
        assert_eq!(item.sinfs[0].id, 1);
        assert_eq!(item.sinfs[0].sinf, vec![1, 2, 3]);
    }
    #[test]
    fn bare_license_already_exists_requires_reauth_for_download() {
        let mut dict = HashMap::new();
        dict.insert("failureType".into(), plist::Value::String("5002".into()));
        dict.insert(
            "customerMessage".into(),
            plist::Value::String("license already exists".into()),
        );
        let err = download_item_from_response_dict(&dict).unwrap_err();
        assert!(err.is_token_expired());
    }
    #[test]
    fn download_item_reads_current_latest_version_id() {
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert("sinfs".into(), plist::Value::Array(Vec::new()));
        let mut metadata = plist::Dictionary::new();
        metadata.insert(
            "softwareVersionExternalIdentifier".into(),
            plist::Value::Integer(887118713.into()),
        );
        item.insert("metadata".into(), plist::Value::Dictionary(metadata));
        let item: DownloadItem = plist::from_value(&plist::Value::Dictionary(item)).unwrap();
        assert_eq!(
            item.latest_external_version_id().as_deref(),
            Some("887118713")
        );
    }
    #[test]
    fn download_item_reads_legacy_latest_version_id() {
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert("sinfs".into(), plist::Value::Array(Vec::new()));
        let mut metadata = plist::Dictionary::new();
        metadata.insert(
            "externalVersionIdentifier".into(),
            plist::Value::String("12345678".into()),
        );
        item.insert("metadata".into(), plist::Value::Dictionary(metadata));
        let item: DownloadItem = plist::from_value(&plist::Value::Dictionary(item)).unwrap();
        assert_eq!(
            item.latest_external_version_id().as_deref(),
            Some("12345678")
        );
    }
    #[test]
    fn download_item_does_not_guess_latest_version_id_from_array() {
        let mut item = plist::Dictionary::new();
        item.insert(
            "URL".into(),
            plist::Value::String("https://example.invalid/app.ipa".into()),
        );
        item.insert("sinfs".into(), plist::Value::Array(Vec::new()));
        let mut metadata = plist::Dictionary::new();
        metadata.insert(
            "softwareVersionExternalIdentifiers".into(),
            plist::Value::Array(vec![plist::Value::Integer(887118713.into())]),
        );
        item.insert("metadata".into(), plist::Value::Dictionary(metadata));
        let item: DownloadItem = plist::from_value(&plist::Value::Dictionary(item)).unwrap();
        assert_eq!(item.latest_external_version_id(), None);
    }
    #[test]
    fn retries_only_empty_successful_download_responses() {
        let empty_success = HashMap::from([("songList".into(), plist::Value::Array(Vec::new()))]);
        let failed_response =
            HashMap::from([("failureType".into(), plist::Value::String("9610".into()))]);
        let available_item = HashMap::from([(
            "songList".into(),
            plist::Value::Array(vec![sample_download_item()]),
        )]);
        assert!(is_empty_successful_download(&empty_success));
        assert!(is_empty_successful_download(&HashMap::new()));
        assert!(!is_empty_successful_download(&failed_response));
        assert!(!is_empty_successful_download(&available_item));
    }
    #[test]
    fn update_product_url_preserves_guid_as_query_parameter() {
        let endpoint =
            url::Url::parse("https://downloaddispatch.itunes.apple.com/up/updateProduct").unwrap();
        let request_url = update_product_url(&endpoint, "AABBCCDDEEFF");
        assert_eq!(
            request_url.as_str(),
            "https://downloaddispatch.itunes.apple.com/up/updateProduct?guid=AABBCCDDEEFF"
        );
    }
    #[test]
    fn download_info_request_matches_app_store_payload_types_and_fields() {
        let body = download_info_request_body(1234, "AABBCCDDEEFF", Some("5678")).unwrap();
        let request: plist::Dictionary = plist::from_bytes(&body).unwrap();
        assert_eq!(
            request.get("salableAdamId"),
            Some(&plist::Value::Integer(1234.into()))
        );
        assert_eq!(
            request.get("serialNumber"),
            Some(&plist::Value::String("0".into()))
        );
        assert_eq!(
            request.get("guid"),
            Some(&plist::Value::String("AABBCCDDEEFF".into()))
        );
        assert_eq!(
            request.get("externalVersionId"),
            Some(&plist::Value::String("5678".into()))
        );
    }
}
