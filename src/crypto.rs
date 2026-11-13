use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, rand_core::RngCore};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};

/// Encrypts InstaBox API keys at rest with a local master key.
///
/// The master key never leaves the machine and is created with 0600
/// permissions. Ciphertexts are `base64(nonce || ciphertext)`.
pub struct Vault {
    cipher: ChaCha20Poly1305,
}

impl Vault {
    pub fn load_or_create(path: &Path) -> Result<Self> {
        let key = if path.exists() {
            let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
            if bytes.len() != 32 {
                bail!("master key at {} is not 32 bytes", path.display());
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            key
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            let mut file = fs::File::create(path)
                .with_context(|| format!("creating {}", path.display()))?;
            file.write_all(&key)?;
            file.sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            }
            key
        };

        Ok(Self {
            cipher: ChaCha20Poly1305::new((&key).into()),
        })
    }

    pub fn seal(&self, plaintext: &str) -> Result<String> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
            .map_err(|_| anyhow::anyhow!("encryption failed"))?;
        let mut out = Vec::with_capacity(12 + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(B64.encode(out))
    }

    pub fn open(&self, sealed: &str) -> Result<String> {
        let raw = B64.decode(sealed).context("stored key is not valid base64")?;
        if raw.len() < 13 {
            bail!("stored key is too short");
        }
        let (nonce, ct) = raw.split_at(12);
        let pt = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| anyhow::anyhow!("could not decrypt stored key"))?;
        Ok(String::from_utf8(pt)?)
    }
}

pub fn hint(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("…{tail}")
}

pub fn fingerprint(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    digest.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        Vault {
            cipher: ChaCha20Poly1305::new((&[7u8; 32]).into()),
        }
    }

    #[test]
    fn seals_and_opens() {
        let vault = vault();
        let sealed = vault.seal("ibk_abcdef").unwrap();
        assert_ne!(sealed, "ibk_abcdef");
        assert_eq!(vault.open(&sealed).unwrap(), "ibk_abcdef");
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let vault = vault();
        let sealed = vault.seal("secret").unwrap();
        let mut bytes = B64.decode(&sealed).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(vault.open(&B64.encode(bytes)).is_err());
    }

    #[test]
    fn hints_only_the_tail() {
        assert_eq!(hint("ibk_12345678"), "…5678");
        assert_eq!(fingerprint("ibk_same"), fingerprint("ibk_same"));
        assert_ne!(fingerprint("ibk_a"), fingerprint("ibk_b"));
    }
}
