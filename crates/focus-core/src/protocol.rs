//! Wire types shared by host and client (see NETWORK_PROTOCOL.md).

use crate::crypto;
use crate::error::{Error, Result};
use crate::policy::SignedPolicy;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_BODY_BYTES: usize = 16 * 1024;
pub const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024;
pub const REQUEST_SKEW_MS: i64 = 120_000;
pub const JOIN_SKEW_MS: i64 = 5 * 60_000;

pub const H_DEVICE: &str = "x-focus-device";
pub const H_CLASS: &str = "x-focus-class";
pub const H_TS: &str = "x-focus-ts";
pub const H_NONCE: &str = "x-focus-nonce";
pub const H_SIG: &str = "x-focus-sig";

/// Contents of the QR code / manual join string.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct JoinPayload {
    pub v: u32,
    pub class_id: String,
    pub class_name: String,
    /// Class signing public key (base64url). Members pin this.
    pub class_pub: String,
    pub pairing_id: String,
    /// One-time pairing secret (base64url, 128 bit). Never sent over the network.
    pub token: String,
    /// Reachable "ip:port" candidates.
    pub addrs: Vec<String>,
    pub expires_at: i64,
}

impl JoinPayload {
    pub fn to_uri(&self) -> String {
        format!(
            "focusos://join/{}",
            crypto::b64(serde_json::to_string(self).unwrap().as_bytes())
        )
    }
    pub fn from_uri(s: &str) -> Result<Self> {
        let body = s
            .trim()
            .strip_prefix("focusos://join/")
            .ok_or_else(|| Error::invalid("not a FOCUS OS join code"))?;
        if body.len() > 4096 {
            return Err(Error::invalid("join code too long"));
        }
        let raw = crypto::unb64(body)?;
        let p: JoinPayload =
            serde_json::from_slice(&raw).map_err(|_| Error::invalid("malformed join code"))?;
        if p.v != 1 {
            return Err(Error::invalid("unsupported join code version"));
        }
        if p.addrs.is_empty() || p.addrs.len() > 8 {
            return Err(Error::invalid("join code has no usable address"));
        }
        Ok(p)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Hello {
    pub class_id: String,
    pub class_name: String,
    pub key_id: String,
    pub protocol: u32,
    pub schemas: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct JoinRequest {
    pub pairing_id: String,
    pub device_pub: String,
    pub display_name: String,
    pub ts: i64,
    pub nonce: String,
    /// HMAC(token, join_message)
    pub proof: String,
    /// Ed25519 signature by the device key over join_message (proof of possession).
    pub device_sig: String,
}

pub fn join_message(class_id: &str, r: &JoinRequest) -> String {
    format!(
        "focus-join-v1\n{class_id}\n{}\n{}\n{}\n{}\n{}",
        r.pairing_id, r.device_pub, r.display_name, r.ts, r.nonce
    )
}

pub fn host_proof_message(
    class_id: &str,
    device_pub: &str,
    nonce: &str,
    member_id: &str,
) -> String {
    format!("focus-host-v1\n{class_id}\n{device_pub}\n{nonce}\n{member_id}")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct JoinResponse {
    pub class_id: String,
    pub class_name: String,
    pub class_pub: String,
    pub member_id: String,
    pub device_id: String,
    pub role: String,
    pub policy: Option<SignedPolicy>,
    /// HMAC(token, host_proof_message): proves the host knew the pairing secret.
    pub host_proof: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PolicyResponse {
    pub role: String,
    pub policy: Option<SignedPolicy>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AckRequest {
    pub revision: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PublishRequest {
    pub payload: crate::policy::PolicyPayload,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Policy { policy: SignedPolicy },
    Revoked,
    Ping,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Ack { revision: u64 },
    Pong,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ErrorBody {
    pub error: String,
    pub code: String,
}

/// Canonical string a device signs for every authenticated request.
pub fn request_message(
    class_id: &str,
    method: &str,
    path_and_query: &str,
    ts: i64,
    nonce: &str,
    body: &[u8],
) -> String {
    format!(
        "focus-req-v1\n{class_id}\n{method}\n{path_and_query}\n{ts}\n{nonce}\n{}",
        crypto::sha256_hex(body)
    )
}
