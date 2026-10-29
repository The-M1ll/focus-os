//! Cryptographic primitives: Ed25519 identities, HMAC pairing proofs, and
//! passphrase-based encryption of the class signing key (Argon2id + ChaCha20-Poly1305).

use crate::error::{Error, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chacha20poly1305::{
    ChaCha20Poly1305,
    aead::{Aead, Payload},
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, KeyInit, Mac};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

pub fn random_id() -> String {
    hex::encode(random_bytes::<16>())
}

pub fn b64(data: &[u8]) -> String {
    B64.encode(data)
}

pub fn unb64(s: &str) -> Result<Vec<u8>> {
    B64.decode(s).map_err(|_| Error::invalid("bad base64"))
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// An Ed25519 keypair. The secret half is zeroized by `ed25519-dalek` on drop.
pub struct KeyPair {
    signing: SigningKey,
}

impl KeyPair {
    pub fn generate() -> Self {
        Self {
            signing: SigningKey::from_bytes(&random_bytes::<32>()),
        }
    }
    pub fn from_secret(secret: &[u8]) -> Result<Self> {
        let arr: [u8; 32] = secret
            .try_into()
            .map_err(|_| Error::invalid("bad secret key length"))?;
        Ok(Self {
            signing: SigningKey::from_bytes(&arr),
        })
    }
    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.signing.to_bytes())
    }
    pub fn public_b64(&self) -> String {
        b64(self.signing.verifying_key().as_bytes())
    }
    pub fn key_id(&self) -> String {
        key_id(&self.public_b64())
    }
    pub fn sign(&self, msg: &[u8]) -> String {
        b64(&self.signing.sign(msg).to_bytes())
    }
}

/// Short stable identifier of a public key (first 16 bytes of SHA-256, hex).
pub fn key_id(public_b64: &str) -> String {
    let raw = unb64(public_b64).unwrap_or_default();
    hex::encode(&Sha256::digest(&raw)[..16])
}

pub fn verify(public_b64: &str, msg: &[u8], sig_b64: &str) -> Result<()> {
    let pk: [u8; 32] = unb64(public_b64)?
        .try_into()
        .map_err(|_| Error::invalid("bad public key length"))?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|_| Error::invalid("bad public key"))?;
    let sig: [u8; 64] = unb64(sig_b64)?
        .try_into()
        .map_err(|_| Error::Integrity("bad signature length".into()))?;
    vk.verify(msg, &Signature::from_bytes(&sig))
        .map_err(|_| Error::Integrity("signature mismatch".into()))
}

type HmacSha256 = Hmac<Sha256>;

pub fn hmac_b64(key: &[u8], msg: &[u8]) -> String {
    let mut m = <HmacSha256 as KeyInit>::new_from_slice(key).expect("hmac accepts any key length");
    m.update(msg);
    b64(&m.finalize().into_bytes())
}

pub fn ct_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

// ---- passphrase encryption -------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SealedBlob {
    pub v: u8,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    pub salt: String,
    pub nonce: String,
    pub ct: String,
}

#[cfg(any(test, feature = "test-support"))]
static FAST_KDF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Cheap KDF cost for unit/integration tests. Only compiled with the `test-support` feature.
#[cfg(any(test, feature = "test-support"))]
pub fn use_fast_kdf_for_tests() {
    FAST_KDF.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Argon2id cost: 64 MiB, 3 passes, 1 lane.
fn kdf_params() -> (u32, u32, u32) {
    #[cfg(any(test, feature = "test-support"))]
    if FAST_KDF.load(std::sync::atomic::Ordering::SeqCst) {
        return (8, 1, 1);
    }
    (64 * 1024, 3, 1)
}

fn derive(pass: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Zeroizing<[u8; 32]>> {
    let params =
        Params::new(m, t, p, Some(32)).map_err(|e| Error::invalid(format!("kdf params: {e}")))?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pass.as_bytes(), salt, out.as_mut())
        .map_err(|e| Error::invalid(format!("kdf: {e}")))?;
    Ok(out)
}

pub fn seal(passphrase: &str, plaintext: &[u8], aad: &[u8]) -> Result<SealedBlob> {
    let (m, t, p) = kdf_params();
    let salt = random_bytes::<16>();
    let nonce = random_bytes::<12>();
    let key = derive(passphrase, &salt, m, t, p)?;
    let cipher = ChaCha20Poly1305::new((&*key).into());
    let ct = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Integrity("encryption failed".into()))?;
    Ok(SealedBlob {
        v: 1,
        m_kib: m,
        t,
        p,
        salt: b64(&salt),
        nonce: b64(&nonce),
        ct: b64(&ct),
    })
}

pub fn open(passphrase: &str, blob: &SealedBlob, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if blob.v != 1 {
        return Err(Error::invalid("unsupported sealed blob version"));
    }
    // Guard against attacker-supplied parameters that would exhaust memory.
    if blob.m_kib > 256 * 1024 || blob.t > 10 || blob.p > 4 {
        return Err(Error::invalid("kdf parameters out of range"));
    }
    let salt = unb64(&blob.salt)?;
    let nonce: [u8; 12] = unb64(&blob.nonce)?
        .try_into()
        .map_err(|_| Error::invalid("bad nonce"))?;
    let key = derive(passphrase, &salt, blob.m_kib, blob.t, blob.p)?;
    let cipher = ChaCha20Poly1305::new((&*key).into());
    let pt = cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &unb64(&blob.ct)?,
                aad,
            },
        )
        .map_err(|_| Error::Integrity("wrong passphrase or corrupted data".into()))?;
    Ok(Zeroizing::new(pt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip() {
        use_fast_kdf_for_tests();
        let kp = KeyPair::generate();
        let sig = kp.sign(b"hello");
        verify(&kp.public_b64(), b"hello", &sig).unwrap();
        assert!(verify(&kp.public_b64(), b"hellp", &sig).is_err());
        let other = KeyPair::generate();
        assert!(verify(&other.public_b64(), b"hello", &sig).is_err());
    }

    #[test]
    fn seal_open() {
        use_fast_kdf_for_tests();
        let blob = seal("correct horse", b"secret", b"aad").unwrap();
        assert_eq!(&*open("correct horse", &blob, b"aad").unwrap(), b"secret");
        assert!(open("wrong", &blob, b"aad").is_err());
        assert!(open("correct horse", &blob, b"other-aad").is_err());
    }

    #[test]
    fn rejects_hostile_kdf_params() {
        use_fast_kdf_for_tests();
        let mut blob = seal("p", b"x", b"").unwrap();
        blob.m_kib = u32::MAX;
        assert!(open("p", &blob, b"").is_err());
    }

    #[test]
    fn hmac_differs_by_key() {
        assert_ne!(hmac_b64(b"a", b"m"), hmac_b64(b"b", b"m"));
        assert!(ct_eq(&hmac_b64(b"a", b"m"), &hmac_b64(b"a", b"m")));
    }
}
