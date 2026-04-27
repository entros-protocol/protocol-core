import * as fs from "node:fs";
import * as path from "node:path";
import { web3 } from "@coral-xyz/anchor";

type PublicKey = web3.PublicKey;

//--------- entrosAnchor
export const deriveIdentityPda = (
  user: PublicKey,
  iamAnchorProgId: PublicKey,
) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), user.toBuffer()],
    iamAnchorProgId,
  );

export const deriveMintPda = (user: PublicKey, iamAnchorProgId: PublicKey) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), user.toBuffer()],
    iamAnchorProgId,
  );

//--------- entrosVerifier
// Load pre-generated Groth16 proof fixture
export const loadProofFixture = () =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "fixtures/test_proof.json"),
      "utf-8",
    ),
  );

export const generateNonce = (): number[] =>
  Array.from(web3.Keypair.generate().publicKey.toBytes());

export const deriveChallengePda = (
  challenger: PublicKey,
  nonce: number[],
  verifierProgId: PublicKey,
) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("challenge"), challenger.toBuffer(), Buffer.from(nonce)],
    verifierProgId,
  );

export const deriveVerificationPda = (
  verifier: PublicKey,
  nonce: number[],
  verifierProgId: PublicKey,
) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("verification"), verifier.toBuffer(), Buffer.from(nonce)],
    verifierProgId,
  );

/**
 * Bootstrap a fresh user through mint + create_challenge + verify_proof,
 * leaving them ready to call update_anchor with the post-patch binding.
 *
 * The initial commitment is set to the fixture's commitment_prev so that
 * the subsequent update_anchor (with new_commitment = fixture's commitment_new)
 * passes the binding check. Caller airdrops SOL to `user` before invoking.
 *
 * Returns everything the caller needs to build the updateAnchor instruction.
 */
export interface BootstrappedUser {
  user: web3.Keypair;
  identityPda: PublicKey;
  mintPda: PublicKey;
  nonce: number[];
  challengePda: PublicKey;
  verificationPda: PublicKey;
}

export async function bootstrapVerifiedUser(params: {
  user: web3.Keypair;
  entrosAnchor: any;
  entrosVerifier: any;
  fixture: any;
  protocolConfigPda: PublicKey;
  treasuryPda: PublicKey;
  mintAuthorityPda: PublicKey;
}): Promise<BootstrappedUser> {
  const { user, entrosAnchor, entrosVerifier, fixture, protocolConfigPda, treasuryPda, mintAuthorityPda } = params;
  const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");

  const [identityPda] = deriveIdentityPda(user.publicKey, entrosAnchor.programId);
  const [mintPda] = deriveMintPda(user.publicKey, entrosAnchor.programId);
  const ata = getAssociatedTokenAddressSync(mintPda, user.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

  await entrosAnchor.methods
    .mintAnchor(Array.from(initialCommitment))
    .accountsStrict({
      user: user.publicKey,
      identityState: identityPda,
      mint: mintPda,
      mintAuthority: mintAuthorityPda,
      tokenAccount: ata,
      associatedTokenProgram: new web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
    })
    .signers([user])
    .rpc();

  const nonce = generateNonce();
  const [challengePda] = deriveChallengePda(user.publicKey, nonce, entrosVerifier.programId);
  const [verificationPda] = deriveVerificationPda(user.publicKey, nonce, entrosVerifier.programId);

  await entrosVerifier.methods
    .createChallenge(nonce)
    .accountsStrict({
      challenger: user.publicKey,
      challenge: challengePda,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([user])
    .rpc();

  const proofBytes = Buffer.from(fixture.proof_bytes);
  await entrosVerifier.methods
    .verifyProof(proofBytes, fixture.public_inputs, nonce)
    .accountsStrict({
      verifier: user.publicKey,
      challenge: challengePda,
      verificationResult: verificationPda,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([user])
    .rpc();

  return { user, identityPda, mintPda, nonce, challengePda, verificationPda };
}

/**
 * Airdrop and wait for confirmation.
 */
export async function airdrop(
  connection: web3.Connection,
  pubkey: PublicKey,
  lamports: number,
): Promise<void> {
  const sig = await connection.requestAirdrop(pubkey, lamports);
  await connection.confirmTransaction(sig, "confirmed");
}
