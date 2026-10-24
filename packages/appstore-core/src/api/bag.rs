use crate::client::AppleClient;
use crate::error::ClientError;
use crate::sap::SapConfig;
use std::collections::HashMap;
use std::time::Duration;
use url::Url;
const BAG_URL: &str = "https://init.itunes.apple.com/bag.xml?ix=5";
const BAG_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const AUTH_PATH: &str = "/WebObjects/MZFinance.woa/wa/authenticate";
const AUTH_HOST: &str = "buy.itunes.apple.com";
const AUTH_POD_SUFFIX: &str = "-buy.itunes.apple.com";
#[derive(Debug, Clone)]
pub struct BagConfig {
    pub auth_endpoint: Url,
    pub sap: SapConfig,
    pub update_product_endpoint: Option<Url>,
}
pub async fn fetch_bag(client: &AppleClient) -> Result<BagConfig, ClientError> {
    let resp = client
        .http()
        .get(BAG_URL)
        .timeout(BAG_REQUEST_TIMEOUT)
        .send()
        .await?;
    let body = resp.bytes().await?;
    let outer: HashMap<String, plist::Value> =
        crate::client::plist_xml::parse_plist_response(&body)?;
    let bag_data = outer
        .get("bag")
        .and_then(plist::Value::as_data)
        .ok_or_else(|| ClientError::UnexpectedResponse("bag: missing 'bag' data".into()))?;
    let inner: HashMap<String, plist::Value> =
        plist::from_bytes(bag_data).map_err(ClientError::PlistDe)?;
    parse_bag(&inner)
}
fn parse_bag(inner: &HashMap<String, plist::Value>) -> Result<BagConfig, ClientError> {
    let auth_endpoint = bag_url(inner, "authenticateAccount")?;
    validate_auth_endpoint(&auth_endpoint)?;
    let version_str = inner
        .get("sign-sap-version")
        .and_then(plist::Value::as_string)
        .ok_or_else(|| ClientError::UnexpectedResponse("bag: missing sign-sap-version".into()))?;
    let version = version_str.parse::<u32>().map_err(|e| {
        ClientError::UnexpectedResponse(format!(
            "bag: invalid sign-sap-version {version_str:?}: {e}"
        ))
    })?;
    let sap = SapConfig {
        setup_url: bag_url(inner, "sign-sap-setup")?,
        cert_url: bag_url(inner, "sign-sap-setup-cert")?,
        version,
    };
    sap.validate()?;
    let update_product_endpoint = inner
        .get("updateProduct")
        .and_then(plist::Value::as_string)
        .and_then(|raw| Url::parse(raw).ok())
        .filter(|endpoint| validate_update_product_endpoint(endpoint).is_ok());
    Ok(BagConfig {
        auth_endpoint,
        sap,
        update_product_endpoint,
    })
}
fn bag_url(inner: &HashMap<String, plist::Value>, key: &str) -> Result<Url, ClientError> {
    let raw = inner
        .get(key)
        .and_then(plist::Value::as_string)
        .ok_or_else(|| ClientError::UnexpectedResponse(format!("bag: missing {key}")))?;
    Url::parse(raw)
        .map_err(|e| ClientError::UnexpectedResponse(format!("bag: invalid {key} URL: {e}")))
}
pub fn validate_auth_endpoint(url: &Url) -> Result<(), ClientError> {
    if url.scheme() != "https" {
        return Err(ClientError::UnexpectedResponse(format!(
            "unsupported authentication endpoint {url}: not HTTPS"
        )));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != AUTH_HOST && !host.ends_with(AUTH_POD_SUFFIX) {
        return Err(ClientError::UnexpectedResponse(format!(
            "unsupported authentication endpoint {url}: unexpected host"
        )));
    }
    if url.path().trim_end_matches('/') != AUTH_PATH {
        return Err(ClientError::UnexpectedResponse(format!(
            "unsupported authentication endpoint {url}: unexpected path"
        )));
    }
    Ok(())
}
fn validate_update_product_endpoint(url: &Url) -> Result<(), ClientError> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https"
        || host != "downloaddispatch.itunes.apple.com"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/up/updateProduct"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ClientError::UnexpectedResponse(
            "bag: unsupported updateProduct URL".into(),
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }
    fn current_bag() -> HashMap<String, plist::Value> {
        HashMap::from([
            (
                "authenticateAccount".to_string(),
                plist::Value::String(
                    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate".into(),
                ),
            ),
            (
                "sign-sap-setup".to_string(),
                plist::Value::String(
                    "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy".into(),
                ),
            ),
            (
                "sign-sap-setup-cert".to_string(),
                plist::Value::String("https://s.mzstatic.com/sap/setupCert.plist".into()),
            ),
            (
                "sign-sap-version".to_string(),
                plist::Value::String("200".into()),
            ),
            (
                "updateProduct".to_string(),
                plist::Value::String(
                    "https://downloaddispatch.itunes.apple.com/up/updateProduct".into(),
                ),
            ),
        ])
    }
    #[test]
    fn parses_apples_current_bag() {
        let config = parse_bag(&current_bag()).unwrap();
        assert_eq!(
            config.auth_endpoint.as_str(),
            "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate"
        );
        assert_eq!(
            config.sap.setup_url.as_str(),
            "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy"
        );
        assert_eq!(config.sap.version, 200);
        assert_eq!(
            config.update_product_endpoint.unwrap().as_str(),
            "https://downloaddispatch.itunes.apple.com/up/updateProduct"
        );
    }

    #[test]
    fn ignores_untrusted_update_product_endpoint_without_rejecting_other_bag_settings() {
        let mut bag = current_bag();
        bag.insert(
            "updateProduct".to_string(),
            plist::Value::String(
                "https://downloaddispatch.itunes.apple.com.evil.test/up/updateProduct".into(),
            ),
        );
        let config = parse_bag(&bag).unwrap();
        assert!(config.update_product_endpoint.is_none());
    }
    #[test]
    fn accepts_legacy_bag_without_update_product_endpoint() {
        let mut bag = current_bag();
        bag.remove("updateProduct");
        let config = parse_bag(&bag).unwrap();
        assert!(config.update_product_endpoint.is_none());
    }
    #[test]
    fn fails_when_sap_keys_are_absent() {
        let mut bag = current_bag();
        bag.remove("sign-sap-setup");
        assert!(parse_bag(&bag).is_err());
    }
    #[test]
    fn accepts_pod_hosts() {
        assert!(
            validate_auth_endpoint(&url(
                "https://p14-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate"
            ))
            .is_ok()
        );
    }
    #[test]
    fn accepts_trailing_slash() {
        assert!(
            validate_auth_endpoint(&url(
                "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/"
            ))
            .is_ok()
        );
    }
    #[test]
    fn rejects_native_fast_endpoint() {
        assert!(
            validate_auth_endpoint(&url("https://auth.itunes.apple.com/auth/v1/native/fast/"))
                .is_err()
        );
    }
    #[test]
    fn rejects_lookalike_host() {
        assert!(
            validate_auth_endpoint(&url(
                "https://buy.itunes.apple.com.evil.test/WebObjects/MZFinance.woa/wa/authenticate"
            ))
            .is_err()
        );
    }
    #[test]
    fn rejects_other_action_on_valid_host() {
        assert!(
            validate_auth_endpoint(&url(
                "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct"
            ))
            .is_err()
        );
    }
    #[test]
    fn rejects_plaintext() {
        assert!(
            validate_auth_endpoint(&url(
                "http://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate"
            ))
            .is_err()
        );
    }
}
