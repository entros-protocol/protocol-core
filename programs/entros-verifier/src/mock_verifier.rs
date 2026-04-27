// Mock Groth16 verification for Phase 1.
//
// Accepts any proof where the first 4 bytes equal [0x49, 0x41, 0x4D, 0x01] ("Entros\x01").
// This magic prefix allows tests to construct valid/invalid proofs trivially.
//
// In Phase 2, this is replaced by groth16_solana::groth16::Groth16Verifier
// with real circuit verification keys and proof validation.

const MOCK_PROOF_MAGIC: [u8; 4] = [0x49, 0x41, 0x4D, 0x01];

/// Verify a mock proof. Returns true if the proof has the correct magic prefix.
///
/// # Arguments
/// * `proof_bytes` - The proof data (must be at least 4 bytes)
/// * `_public_inputs` - Public inputs (ignored in mock, validated in Phase 2)
pub fn mock_verify_proof(proof_bytes: &[u8], _public_inputs: &[[u8; 32]]) -> bool {
    if proof_bytes.len() < 4 {
        return false;
    }
    proof_bytes[0..4] == MOCK_PROOF_MAGIC
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_mock_proof() {
        let proof = [0x49, 0x41, 0x4D, 0x01, 0x00, 0x00];
        assert!(mock_verify_proof(&proof, &[]));
    }

    #[test]
    fn test_invalid_mock_proof() {
        let proof = [0x00, 0x00, 0x00, 0x00];
        assert!(!mock_verify_proof(&proof, &[]));
    }

    #[test]
    fn test_too_short_proof() {
        let proof = [0x49, 0x41, 0x4D];
        assert!(!mock_verify_proof(&proof, &[]));
    }

    #[test]
    fn test_empty_proof() {
        assert!(!mock_verify_proof(&[], &[]));
    }
}
