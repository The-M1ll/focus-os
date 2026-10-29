//! Versioned, signed class policy.
//!
//! The signature covers the exact bytes of `envelope` (a JSON string), so no
//! canonicalisation ambiguity exists. Policies never contain personal study data.

use crate::crypto::{self, KeyPair};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const SUPPORTED_SCHEMAS: &[u32] = &[1];
pub const MAX_ENVELOPE_BYTES: usize = 32 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TimeWindow {
    /// 0 = Sunday .. 6 = Saturday. Empty = every day.
    pub days: Vec<u8>,
    /// Minutes after local midnight, `start < end`, end <= 1440.
    pub start_min: u16,
    pub end_min: u16,
}

/// One platform rule. Semantics (identical in every client):
/// * `blocked`: never available (class-wide block). Cannot be combined with a budget or windows.
/// * `allowed_windows`: times the platform is available at all. Empty = all day, every day.
/// * `daily_minutes`: budget inside the available times. `None` = no budget.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LimitRule {
    /// Lower-case platform id or domain, e.g. "instagram" or "example.com".
    pub platform: String,
    pub blocked: bool,
    pub daily_minutes: Option<u32>,
    pub allowed_windows: Vec<TimeWindow>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StudyGoal {
    pub id: String,
    pub title: String,
    pub target_minutes_per_week: u32,
}

/// What, if anything, members agree to share back with the class administrator.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProgressSharing {
    /// Default: the protocol carries nothing back except membership and sync acks.
    #[default]
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct PolicyPayload {
    pub limits: Vec<LimitRule>,
    pub study_goals: Vec<StudyGoal>,
    /// May members add stricter personal limits on top of class rules?
    pub allow_personal_limits: bool,
    #[serde(default)]
    pub progress_sharing: ProgressSharing,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PolicyEnvelope {
    pub class_id: String,
    pub schema_version: u32,
    pub revision: u64,
    /// Unix epoch milliseconds at signing.
    pub issued_at: i64,
    pub publisher_key_id: String,
    /// Oldest client protocol version able to interpret this policy.
    pub min_client_version: u32,
    pub payload: PolicyPayload,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SignedPolicy {
    /// JSON text of a `PolicyEnvelope`; signature is over these exact bytes.
    pub envelope: String,
    pub signature: String,
    pub key_id: String,
}

impl PolicyPayload {
    pub fn validate(&self) -> Result<()> {
        if self.limits.len() > 64 {
            return Err(Error::invalid("too many limit rules (max 64)"));
        }
        if self.study_goals.len() > 32 {
            return Err(Error::invalid("too many study goals (max 32)"));
        }
        let mut seen = std::collections::HashSet::new();
        for r in &self.limits {
            let ok_chars = r
                .platform
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
            if r.platform.is_empty() || r.platform.len() > 64 || !ok_chars {
                return Err(Error::invalid(format!(
                    "invalid platform id {:?}",
                    r.platform
                )));
            }
            if !seen.insert(r.platform.clone()) {
                return Err(Error::invalid(format!("duplicate rule for {}", r.platform)));
            }
            if r.blocked && (r.daily_minutes.is_some() || !r.allowed_windows.is_empty()) {
                return Err(Error::invalid(
                    "a blocked rule cannot also carry a budget or allowed hours",
                ));
            }
            if r.daily_minutes.is_some_and(|m| m > 1440) {
                return Err(Error::invalid("daily_minutes must be 0..=1440"));
            }
            if r.allowed_windows.len() > 14 {
                return Err(Error::invalid("too many allowed windows on one rule"));
            }
            for w in &r.allowed_windows {
                if w.start_min >= w.end_min || w.end_min > 1440 || w.days.iter().any(|d| *d > 6) {
                    return Err(Error::invalid("invalid time window"));
                }
            }
        }
        for g in &self.study_goals {
            if g.title.trim().is_empty()
                || g.title.chars().count() > 120
                || g.id.is_empty()
                || g.id.len() > 64
            {
                return Err(Error::invalid("invalid study goal"));
            }
            if g.target_minutes_per_week > 7 * 24 * 60 {
                return Err(Error::invalid("study goal exceeds a week"));
            }
        }
        Ok(())
    }
}

pub fn sign(
    key: &KeyPair,
    class_id: &str,
    revision: u64,
    issued_at: i64,
    payload: PolicyPayload,
) -> Result<SignedPolicy> {
    payload.validate()?;
    let env = PolicyEnvelope {
        class_id: class_id.to_string(),
        schema_version: SCHEMA_VERSION,
        revision,
        issued_at,
        publisher_key_id: key.key_id(),
        min_client_version: 1,
        payload,
    };
    let envelope = serde_json::to_string(&env).map_err(|e| Error::invalid(e.to_string()))?;
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(Error::invalid("policy too large"));
    }
    Ok(SignedPolicy {
        signature: key.sign(envelope.as_bytes()),
        key_id: key.key_id(),
        envelope,
    })
}

/// Full verification used by clients: size, signature against the *pinned* key,
/// schema support, class binding, and payload validity. Order matters: the
/// signature is checked before any untrusted JSON is parsed.
pub fn verify(
    sp: &SignedPolicy,
    pinned_pub_b64: &str,
    expected_class: &str,
) -> Result<PolicyEnvelope> {
    if sp.envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(Error::invalid("policy envelope too large"));
    }
    if sp.key_id != crypto::key_id(pinned_pub_b64) {
        return Err(Error::Integrity("policy signed by an unknown key".into()));
    }
    crypto::verify(pinned_pub_b64, sp.envelope.as_bytes(), &sp.signature)?;
    // Peek schema version before strict parsing so unknown future schemas are
    // reported as "unsupported" rather than "malformed".
    let v: serde_json::Value =
        serde_json::from_str(&sp.envelope).map_err(|_| Error::invalid("malformed policy"))?;
    let schema = v
        .get("schema_version")
        .and_then(|s| s.as_u64())
        .ok_or_else(|| Error::invalid("missing schema_version"))? as u32;
    if !SUPPORTED_SCHEMAS.contains(&schema) {
        return Err(Error::UnsupportedSchema(schema));
    }
    let env: PolicyEnvelope =
        serde_json::from_value(v).map_err(|e| Error::invalid(format!("malformed policy: {e}")))?;
    if env.class_id != expected_class {
        return Err(Error::Integrity(
            "policy belongs to a different class".into(),
        ));
    }
    if env.publisher_key_id != sp.key_id || env.revision == 0 {
        return Err(Error::invalid("inconsistent policy envelope"));
    }
    env.payload.validate()?;
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> PolicyPayload {
        PolicyPayload {
            limits: vec![LimitRule {
                platform: "instagram".into(),
                blocked: false,
                daily_minutes: Some(30),
                allowed_windows: vec![],
            }],
            study_goals: vec![],
            allow_personal_limits: true,
            progress_sharing: ProgressSharing::None,
        }
    }

    #[test]
    fn sign_and_verify() {
        let k = KeyPair::generate();
        let sp = sign(&k, "c1", 1, 0, payload()).unwrap();
        let env = verify(&sp, &k.public_b64(), "c1").unwrap();
        assert_eq!(env.revision, 1);
    }

    #[test]
    fn rejects_wrong_key_class_and_tamper() {
        let k = KeyPair::generate();
        let sp = sign(&k, "c1", 1, 0, payload()).unwrap();
        assert!(verify(&sp, &KeyPair::generate().public_b64(), "c1").is_err());
        assert!(verify(&sp, &k.public_b64(), "c2").is_err());
        let mut t = sp.clone();
        t.envelope = t.envelope.replace("30", "999");
        assert!(matches!(
            verify(&t, &k.public_b64(), "c1"),
            Err(Error::Integrity(_))
        ));
    }

    #[test]
    fn unsupported_schema_is_distinct() {
        let k = KeyPair::generate();
        let sp = sign(&k, "c1", 1, 0, payload()).unwrap();
        let env = sp
            .envelope
            .replace("\"schema_version\":1", "\"schema_version\":99");
        let sp2 = SignedPolicy {
            signature: k.sign(env.as_bytes()),
            envelope: env,
            key_id: k.key_id(),
        };
        assert!(matches!(
            verify(&sp2, &k.public_b64(), "c1"),
            Err(Error::UnsupportedSchema(99))
        ));
    }

    #[test]
    fn payload_validation() {
        let mut p = payload();
        p.limits[0].daily_minutes = Some(5000);
        assert!(p.validate().is_err());
        let mut p = payload();
        p.limits.push(p.limits[0].clone());
        assert!(p.validate().is_err());
        let mut p = payload();
        p.limits[0].platform = "Insta gram".into();
        assert!(p.validate().is_err());
        let mut p = payload();
        p.limits[0].allowed_windows = vec![TimeWindow {
            days: vec![9],
            start_min: 0,
            end_min: 10,
        }];
        assert!(p.validate().is_err());
    }
}
