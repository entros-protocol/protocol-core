use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

use crate::errors::VerifierError;
use crate::verifying_key::VERIFYINGKEY;

/// Number of public inputs for the IAM Hamming circuit.
/// commitment_new, commitment_prev, threshold
const NR_PUBLIC_INPUTS: usize = 3;

/// Verify a Groth16 proof against the IAM Hamming circuit verification key.
///
/// # Arguments
/// * `proof_bytes` - 256 bytes: proof_a (64, negated) + proof_b (128) + proof_c (64)
/// * `public_inputs` - 3 x 32-byte big-endian field elements
pub fn verify_proof(
    proof_bytes: &[u8],
    public_inputs: &[[u8; 32]],
) -> Result<()> {
    if proof_bytes.len() != 256 {
        return Err(VerifierError::InvalidProofFormat.into());
    }
    if public_inputs.len() != NR_PUBLIC_INPUTS {
        return Err(VerifierError::InvalidPublicInputs.into());
    }

    let proof_a: [u8; 64] = proof_bytes[0..64]
        .try_into()
        .map_err(|_| VerifierError::InvalidProofFormat)?;
    let proof_b: [u8; 128] = proof_bytes[64..192]
        .try_into()
        .map_err(|_| VerifierError::InvalidProofFormat)?;
    let proof_c: [u8; 64] = proof_bytes[192..256]
        .try_into()
        .map_err(|_| VerifierError::InvalidProofFormat)?;

    let pub_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
        public_inputs[0],
        public_inputs[1],
        public_inputs[2],
    ];

    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &pub_inputs,
        &VERIFYINGKEY,
    )
    .map_err(|_| VerifierError::ProofVerificationFailed)?;

    verifier
        .verify()
        .map_err(|_| VerifierError::ProofVerificationFailed)?;

    Ok(())
}
