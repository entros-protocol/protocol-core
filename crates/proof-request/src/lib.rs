#![deny(clippy::all)]
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

declare_id!("4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV");
pub const ANCHOR_ID: Pubkey = pubkey!("GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2");
pub const GENERATION: u8 = 1;
pub const STATE_LEN: usize = 50;
pub const MAX_REQUEST_LIFETIME: u64 = 300;
pub const REQUEST_DOMAIN: [u8; 32] = *b"ENTROS_PROOF_REQUEST_V1\0\0\0\0\0\0\0\0\0";
pub const ACTION_DOMAIN: [u8; 32] = *b"ENTROS_ANCHOR_UPDATE_V1\0\0\0\0\0\0\0\0\0";
pub const SCALAR_MODULUS: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 40, 51, 232, 72, 121,
    185, 112, 145, 67, 225, 245, 147, 240, 0, 0, 1,
];
#[cfg(feature = "request-bound-v1")]
include!(env!("ENTROS_BOUND_DEPLOYMENT_CONFIG"));

pub fn account_hash(bytes: &[u8]) -> [u8; 32] {
    hash(bytes).to_bytes()
}

pub fn canonical_scalar(value: &[u8; 32]) -> bool {
    value < &SCALAR_MODULUS
}

#[derive(Clone, Copy)]
pub struct Action {
    pub identity: Pubkey,
    pub mint: Pubkey,
    pub counter: u64,
    pub projection: u16,
    pub commitment_new: [u8; 32],
    pub commitment_prev: [u8; 32],
    pub threshold: u16,
    pub min_distance: u16,
    pub valid_until: u64,
}
impl Action {
    pub fn encode(&self) -> Option<[u8; 182]> {
        if !canonical_scalar(&self.commitment_new)
            || !canonical_scalar(&self.commitment_prev)
            || self.commitment_new == [0; 32]
            || self.commitment_prev == [0; 32]
            || self.valid_until == 0
            || self.threshold > 256
            || self.min_distance > self.threshold
        {
            return None;
        }
        let mut bytes = [0; 182];
        bytes[..32].copy_from_slice(&ACTION_DOMAIN);
        bytes[32..64].copy_from_slice(self.identity.as_ref());
        bytes[64..96].copy_from_slice(self.mint.as_ref());
        bytes[96..104].copy_from_slice(&self.counter.to_be_bytes());
        bytes[104..106].copy_from_slice(&self.projection.to_be_bytes());
        bytes[106..138].copy_from_slice(&self.commitment_new);
        bytes[138..170].copy_from_slice(&self.commitment_prev);
        bytes[170..172].copy_from_slice(&self.threshold.to_be_bytes());
        bytes[172..174].copy_from_slice(&self.min_distance.to_be_bytes());
        bytes[174..].copy_from_slice(&self.valid_until.to_be_bytes());
        Some(bytes)
    }
}
pub fn request_digest(
    deployment: [u8; 32],
    verifier: Pubkey,
    consumer: Pubkey,
    wallet: Pubkey,
    nonce: [u8; 32],
    action: &Action,
) -> Option<[u8; 32]> {
    let action_bytes = action.encode()?;
    let mut bytes = [0; 225];
    bytes[..32].copy_from_slice(&REQUEST_DOMAIN);
    bytes[32..64].copy_from_slice(&deployment);
    bytes[64..96].copy_from_slice(verifier.as_ref());
    bytes[96..128].copy_from_slice(consumer.as_ref());
    bytes[128..160].copy_from_slice(wallet.as_ref());
    bytes[160..192].copy_from_slice(&nonce);
    bytes[192] = 1;
    bytes[193..].copy_from_slice(hash(&action_bytes).as_ref());
    Some(hash(&bytes).to_bytes())
}
pub fn digest_limbs(digest: [u8; 32]) -> [[u8; 32]; 2] {
    let mut limbs = [[0; 32]; 2];
    limbs[0][16..].copy_from_slice(&digest[..16]);
    limbs[1][16..].copy_from_slice(&digest[16..]);
    limbs
}

#[account]
pub struct BoundVerificationResult {
    pub version: u8,
    pub wallet: Pubkey,
    pub nonce: [u8; 32],
    pub commitment_new: [u8; 32],
    pub commitment_prev: [u8; 32],
    pub threshold: u16,
    pub min_distance: u16,
    pub counter: u64,
    pub valid_until: u64,
    pub verified_at: i64,
    pub request_digest: [u8; 32],
    pub bump: u8,
}
impl BoundVerificationResult {
    pub const LEN: usize = 198;
}

pub fn read_counter(data: &[u8], wallet: Pubkey, bump: u8) -> Option<u64> {
    if data.len() != STATE_LEN
        || data[..8] != hash(b"account:ProofRequestState").to_bytes()[..8]
        || data[8] != GENERATION
        || data[9..41] != wallet.to_bytes()
        || data[49] != bump
    {
        return None;
    }
    Some(u64::from_le_bytes(data[41..49].try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_boundaries() {
        assert!(!canonical_scalar(&SCALAR_MODULUS));
        let mut max = SCALAR_MODULUS;
        max[31] -= 1;
        assert!(canonical_scalar(&max));
        assert!(!canonical_scalar(&[255; 32]));
    }
    #[test]
    fn shared_schema_vector() {
        let mut new = [0; 32];
        new[31] = 1;
        let mut prev = [0; 32];
        prev[31] = 2;
        let action = Action {
            identity: Pubkey::new_from_array([0x16; 32]),
            mint: Pubkey::new_from_array([0x17; 32]),
            counter: 7,
            projection: 1,
            commitment_new: new,
            commitment_prev: prev,
            threshold: 30,
            min_distance: 3,
            valid_until: 1_800_000_000,
        };
        let digest = request_digest(
            [0x11; 32],
            Pubkey::new_from_array([0x12; 32]),
            Pubkey::new_from_array([0x13; 32]),
            Pubkey::new_from_array([0x14; 32]),
            [0x15; 32],
            &action,
        )
        .expect("canonical vector");
        assert_eq!(
            digest,
            [
                0x26, 0xb6, 0xe0, 0xfa, 0xef, 0x73, 0x1f, 0x3e, 0x3f, 0x56, 0x99, 0xb5, 0xe8, 0x5d,
                0x55, 0x3c, 0xa5, 0xba, 0x6d, 0x9c, 0xbe, 0x34, 0x78, 0x35, 0xf1, 0x4f, 0x1e, 0x51,
                0x56, 0x83, 0x55, 0x2b
            ]
        );
        assert_eq!(digest_limbs(digest)[0][..16], [0; 16]);
        assert!(Action {
            commitment_new: [0; 32],
            ..action
        }
        .encode()
        .is_none());
        assert!(Action {
            commitment_prev: [0; 32],
            ..action
        }
        .encode()
        .is_none());
        assert!(Action {
            valid_until: 0,
            ..action
        }
        .encode()
        .is_none());
        assert!(Action {
            threshold: 257,
            ..action
        }
        .encode()
        .is_none());
        assert!(Action {
            min_distance: 31,
            ..action
        }
        .encode()
        .is_none());
        assert!(Action {
            commitment_new: SCALAR_MODULUS,
            ..action
        }
        .encode()
        .is_none());
    }
}
