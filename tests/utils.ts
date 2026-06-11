import * as fs from "node:fs";
import * as path from "node:path";
import { web3 } from "@coral-xyz/anchor";

type PublicKey = web3.PublicKey;

//--------- mint receipt (validator binding)
// Deterministic validator signing key for tests. ProtocolConfig.validator_pubkey
// is set to this key at initialize_protocol, so every receipt the tests build is
// signed by the key the on-chain verifier expects. A fixed seed keeps it
// identical across the test files that share the protocol_config PDA.
export const TEST_VALIDATOR = web3.Keypair.fromSeed(
  Uint8Array.from(new Array(32).fill(7)),
);

/**
 * Build the Ed25519Program instruction carrying a validator-signed mint
 * receipt. Prepend it (via `.preInstructions([...])`) immediately before
 * `mintAnchor`; `verify_mint_receipt` reads it from the preceding instruction.
 * Message layout matches the on-chain parser:
 *   wallet(32) || commitment(32) || validated_at i64 LE(8) = 72 bytes.
 * `validated_at` is backdated a few seconds so it is fresh but never ahead of
 * the cluster clock (the future-check rejects ts > now).
 */
export function buildMintReceiptIx(
  walletPubkey: PublicKey,
  commitment: Buffer,
): web3.TransactionInstruction {
  const validatedAt = Math.floor(Date.now() / 1000) - 30;
  const message = Buffer.alloc(72);
  walletPubkey.toBuffer().copy(message, 0);
  commitment.copy(message, 32);
  message.writeBigInt64LE(BigInt(validatedAt), 64);
  return web3.Ed25519Program.createInstructionWithPrivateKey({
    privateKey: TEST_VALIDATOR.secretKey,
    message,
  });
}

//--------- entrosAnchor
export const deriveIdentityPda = (
  user: PublicKey,
  entrosAnchorProgId: PublicKey,
) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), user.toBuffer()],
    entrosAnchorProgId,
  );

export const deriveMintPda = (user: PublicKey, entrosAnchorProgId: PublicKey) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), user.toBuffer()],
    entrosAnchorProgId,
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
  const {
    user,
    entrosAnchor,
    entrosVerifier,
    fixture,
    protocolConfigPda,
    treasuryPda,
    mintAuthorityPda,
  } = params;
  const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } = await import(
    "@solana/spl-token"
  );

  const [identityPda] = deriveIdentityPda(
    user.publicKey,
    entrosAnchor.programId,
  );
  const [mintPda] = deriveMintPda(user.publicKey, entrosAnchor.programId);
  const ata = getAssociatedTokenAddressSync(
    mintPda,
    user.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

  await entrosAnchor.methods
    .mintAnchor(Array.from(initialCommitment))
    .accountsStrict({
      user: user.publicKey,
      identityState: identityPda,
      mint: mintPda,
      mintAuthority: mintAuthorityPda,
      tokenAccount: ata,
      associatedTokenProgram: new web3.PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      instructionsSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .preInstructions([buildMintReceiptIx(user.publicKey, initialCommitment)])
    .signers([user])
    .rpc();

  const nonce = generateNonce();
  const [challengePda] = deriveChallengePda(
    user.publicKey,
    nonce,
    entrosVerifier.programId,
  );
  const [verificationPda] = deriveVerificationPda(
    user.publicKey,
    nonce,
    entrosVerifier.programId,
  );

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
