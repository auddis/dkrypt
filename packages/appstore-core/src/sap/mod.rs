pub mod assets;
pub mod machine;
pub mod macho;
pub mod setup;
pub mod unicorn;
use crate::client::AppleClient;
use crate::error::ClientError;
use std::sync::Arc;
use url::Url;
pub const SUPPORTED_VERSION: u32 = 200;
pub(crate) fn hex_digest(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
#[derive(Debug, Clone)]
pub struct SapConfig {
    pub setup_url: Url,
    pub cert_url: Url,
    pub version: u32,
}
impl SapConfig {
    pub fn validate(&self) -> Result<(), ClientError> {
        if self.version != SUPPORTED_VERSION {
            return Err(ClientError::Sap(format!(
                "unsupported SAP version {} (expected {SUPPORTED_VERSION})",
                self.version
            )));
        }
        for (label, url) in [("setup", &self.setup_url), ("certificate", &self.cert_url)] {
            if url.scheme() != "https" || !url.has_host() {
                return Err(ClientError::Sap(format!(
                    "SAP {label} endpoint must be an absolute HTTPS URL, got {url}"
                )));
            }
        }
        Ok(())
    }
}
pub trait ActionSigner: Send + Sync {
    fn sign(&self, data: &[u8]) -> Result<Vec<u8>, ClientError>;
}
pub trait SapMachine: Send + Sync {
    fn initialize(&self, hardware_id: &[u8]) -> Result<u64, ClientError>;
    fn exchange(
        &self,
        version: u32,
        hardware_id: &[u8],
        context: u64,
        input: &[u8],
    ) -> Result<(Vec<u8>, i32), ClientError>;
    fn sign(&self, context: u64, input: &[u8]) -> Result<Vec<u8>, ClientError>;
    fn teardown(&self, context: u64) -> Result<(), ClientError>;
}
pub struct Signer {
    machine: Arc<dyn SapMachine>,
    context: u64,
}
impl ActionSigner for Signer {
    fn sign(&self, data: &[u8]) -> Result<Vec<u8>, ClientError> {
        let signature = self.machine.sign(self.context, data)?;
        if signature.is_empty() {
            return Err(ClientError::Sap("signature is empty".into()));
        }
        Ok(signature)
    }
}
impl Drop for Signer {
    fn drop(&mut self) {
        if let Err(e) = self.machine.teardown(self.context) {
            tracing::warn!("failed to tear down SAP session: {e}");
        }
    }
}
pub async fn new_signer(
    client: &AppleClient,
    machine: Arc<dyn SapMachine>,
    config: &SapConfig,
    hardware_id: &[u8],
) -> Result<Signer, ClientError> {
    config.validate()?;
    if hardware_id.is_empty() || hardware_id.len() > 20 {
        return Err(ClientError::Sap(format!(
            "hardware ID must be 1-20 bytes, got {}",
            hardware_id.len()
        )));
    }
    let context = machine.initialize(hardware_id)?;
    let signer = Signer {
        machine: Arc::clone(&machine),
        context,
    };
    let certificate = setup::fetch_certificate(client, &config.cert_url).await?;
    tracing::debug!(len = certificate.len(), "fetched SAP setup certificate");
    let (request, state) = machine.exchange(config.version, hardware_id, context, &certificate)?;
    if state != 1 {
        return Err(ClientError::Sap(format!(
            "SAP setup entered unexpected state {state}"
        )));
    }
    if request.is_empty() {
        return Err(ClientError::Sap("SAP setup message is empty".into()));
    }
    let reply = setup::exchange(client, &config.setup_url, &request).await?;
    let (_, state) = machine.exchange(config.version, hardware_id, context, &reply)?;
    if state != 0 {
        return Err(ClientError::Sap(format!(
            "SAP setup completed in unexpected state {state}"
        )));
    }
    tracing::debug!("SAP session established");
    Ok(signer)
}
pub async fn new_default_signer(
    client: &AppleClient,
    config: &SapConfig,
    hardware_id: &[u8],
) -> Result<Signer, ClientError> {
    let cache_dir = client.cache_dir().to_path_buf();
    let bundle = assets::load(client, &cache_dir.join("apple-assets")).await?;
    let machine = machine::Machine::open(client, &cache_dir, &bundle).await?;
    new_signer(client, Arc::new(machine), config, hardware_id).await
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config(setup: &str, cert: &str, version: u32) -> SapConfig {
        SapConfig {
            setup_url: Url::parse(setup).unwrap(),
            cert_url: Url::parse(cert).unwrap(),
            version,
        }
    }
    #[test]
    fn accepts_apples_current_configuration() {
        assert!(
            config(
                "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
                "https://s.mzstatic.com/sap/setupCert.plist",
                200,
            )
            .validate()
            .is_ok()
        );
    }
    #[test]
    fn rejects_unsupported_version() {
        assert!(
            config(
                "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
                "https://s.mzstatic.com/sap/setupCert.plist",
                201,
            )
            .validate()
            .is_err()
        );
    }
    #[test]
    fn rejects_plaintext_endpoints() {
        assert!(
            config(
                "http://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
                "https://s.mzstatic.com/sap/setupCert.plist",
                200,
            )
            .validate()
            .is_err()
        );
    }
    #[tokio::test]
    #[ignore = "performs a real SAP handshake with Apple"]
    async fn live_sap_handshake_produces_a_signature() {
        let client = crate::client::AppleClient::for_tests();
        let bag = crate::api::bag::fetch_bag(&client)
            .await
            .expect("fetch bag");
        let signer = new_default_signer(&client, &bag.sap, client.hardware_id())
            .await
            .expect("establish SAP session");
        let signature = signer.sign(b"<plist>body</plist>").expect("sign");
        assert!(!signature.is_empty());
        let again = signer.sign(b"<plist>other</plist>").expect("sign again");
        assert!(!again.is_empty());
        assert_ne!(signature, again, "signature does not depend on the body");
    }
}
