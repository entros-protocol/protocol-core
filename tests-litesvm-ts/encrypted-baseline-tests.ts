/* Build the Solana programs first:
$ anchor build
Then run with NodeJs v26.0.0 (or v22.18.0+):
$ node ./tests-litesvm-ts/encrypted-baseline-tests.ts

Tests for master-list #98 — separate EncryptedBaseline PDA design.
Verifies:
  1. Pre-mint guard rejects with IdentityStateNotFound (6022)
  2. Init creates PDA at the derived seeds with correct blob + bump
  3. Update overwrites existing blob without creating a new account
  4. Different wallets target different PDAs (one cannot overwrite another)
  5. Account discriminator matches SHA256("account:EncryptedBaseline")[..8]
*/

import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Ed25519Program,
  Keypair,
  type PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { maxComputeBudgets } from "./cu-budgets.ts";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  decodeEncryptedBaseline,
  deriveEncryptedBaselinePda,
  INSTRUCTIONS_SYSVAR,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  protocolConfigPda,
  SYSTEM_PROGRAM,
  treasuryPda,
  VERIFICATION_FEE,
} from "./encodeDecode.ts";
import {
  adminKp,
  hackerKp,
  initializeProtocol,
  pdasBySignerKp,
  sendTxns,
  setEncryptedBaseline,
  setTime,
  setValidatorPubkey,
  svm,
  user1Kp,
} from "./litesvm-utils.ts";

// Pin svm clock so the validated_at timestamp baked into the receipt
// matches the on-chain Clock::get() result inside mint_anchor.
const fixedNowSecs = BigInt(1_700_000_000);
setTime(fixedNowSecs);

// Validator keypair signs the mint receipt (master-list #146 Phase 3).
const validatorKp = Keypair.generate();

const tokenProgram = TOKEN_2022_PROGRAM_ID;

const MINT_ANCHOR_DISCRIMINATOR = Buffer.from([
  68, 56, 113, 102, 236, 152, 146, 60,
]);

// Build the canonical receipt message:
//   wallet_pubkey (32) || commitment_new (32) || validated_at i64 LE (8) = 72 bytes
function buildReceiptMessage(
  wallet: PublicKey,
  commitment: Buffer,
  validatedAt: bigint,
): Buffer {
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(validatedAt);
  return Buffer.concat([wallet.toBuffer(), commitment, ts]);
}

function buildMintAnchorIx(
  signer: PublicKey,
  commitment: Buffer,
  identityPda: PublicKey,
  mintPda: PublicKey,
  ataPda: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: identityPda, isSigner: false, isWritable: true },
      { pubkey: mintPda, isSigner: false, isWritable: true },
      { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: ataPda, isSigner: false, isWritable: true },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId: anchorAddr,
    data: Buffer.concat([MINT_ANCHOR_DISCRIMINATOR, commitment]),
  });
}

// Mints user1's identity so subsequent encrypted-baseline tests have an
// IdentityState PDA to satisfy the pre-mint guard.
function mintUser1Identity(): void {
  const pdas = pdasBySignerKp(user1Kp);
  const commitment = Buffer.alloc(32);
  // Non-zero commitment (zero is rejected by InvalidCommitment).
  commitment.writeUInt32LE(0xdeadbeef, 0);
  const validatedAt = fixedNowSecs;

  const message = buildReceiptMessage(
    user1Kp.publicKey,
    commitment,
    validatedAt,
  );
  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: validatorKp.secretKey,
    message,
  });
  const mintIx = buildMintAnchorIx(
    user1Kp.publicKey,
    commitment,
    pdas.identityPda,
    pdas.mintPda,
    pdas.ata,
  );
  sendTxns(
    svm.latestBlockhash(),
    [ed25519Ix, mintIx],
    [user1Kp],
    anchorAddr,
    maxComputeBudgets.mint_anchor,
    "",
  );
}

test("setup: initializeProtocol + setValidatorPubkey + mint user1's identity", async () => {
  initializeProtocol(
    adminKp,
    protocolConfigPda,
    MIN_STAKE,
    CHALLENGE_EXPIRY,
    MAX_TRUST_SCORE,
    BASE_TRUST_INCREMENT,
    VERIFICATION_FEE,
  );
  setValidatorPubkey(adminKp, validatorKp.publicKey, protocolConfigPda);
  mintUser1Identity();

  const pdas = pdasBySignerKp(user1Kp);
  const identityAcct = svm.getAccount(pdas.identityPda);
  expect(identityAcct).to.not.equal(null);
});

test("encrypted-baseline: pre-mint guard rejects hackerKp with IdentityStateNotFound (6022)", async () => {
  // hackerKp has never minted, so its IdentityState PDA does not exist.
  const blob = new Uint8Array(96).fill(0x42);
  const expectedErr =
    "Error Number: 6022. Error Message: set_encrypted_baseline called before mint_anchor";
  setEncryptedBaseline(hackerKp, blob, expectedErr);
});

test("encrypted-baseline: init creates PDA with correct blob and bump", async () => {
  const blob = new Uint8Array(96);
  for (let i = 0; i < 96; i++) {
    blob[i] = i & 0xff; // distinguishable pattern: 0, 1, 2, ..., 95
  }
  setEncryptedBaseline(user1Kp, blob, "");

  const [baselinePda, expectedBump] = deriveEncryptedBaselinePda(
    user1Kp.publicKey,
  );
  const acct = svm.getAccount(baselinePda);
  expect(acct).to.not.equal(null);
  // 8-byte Anchor discriminator + 96-byte blob + 1-byte bump = 105 bytes
  expect(acct?.data.length).to.equal(105);

  const decoded = decodeEncryptedBaseline(new Uint8Array(acct?.data ?? []));
  expect(decoded.bump).to.equal(expectedBump);
  expect([...decoded.blob]).to.deep.equal([...blob]);
});

test("encrypted-baseline: update overwrites existing blob without creating a new account", async () => {
  const [baselinePda] = deriveEncryptedBaselinePda(user1Kp.publicKey);
  const acctBefore = svm.getAccount(baselinePda);
  const lamportsBefore = acctBefore?.lamports ?? BigInt(0);

  const newBlob = new Uint8Array(96).fill(0xab);
  setEncryptedBaseline(user1Kp, newBlob, "");

  const acctAfter = svm.getAccount(baselinePda);
  expect(acctAfter?.data.length).to.equal(105);
  // Same PDA address — rent is unchanged (no new account creation).
  expect(acctAfter?.lamports).to.equal(lamportsBefore);

  const decoded = decodeEncryptedBaseline(new Uint8Array(acctAfter?.data ?? []));
  expect([...decoded.blob]).to.deep.equal([...newBlob]);
});

test("encrypted-baseline: different wallets target different PDAs (carve-out invariant)", async () => {
  const [user1Pda] = deriveEncryptedBaselinePda(user1Kp.publicKey);
  const [hackerPda] = deriveEncryptedBaselinePda(hackerKp.publicKey);
  // The PDA derivation is wallet-bound — no wallet can target another's PDA.
  expect(user1Pda.toBase58()).to.not.equal(hackerPda.toBase58());
});

test("encrypted-baseline: account discriminator matches SHA256(\"account:EncryptedBaseline\")[..8]", async () => {
  const [baselinePda] = deriveEncryptedBaselinePda(user1Kp.publicKey);
  const acct = svm.getAccount(baselinePda);
  // Anchor account discriminator for "EncryptedBaseline" — see IDL.
  // Computed once via:
  //   require("crypto").createHash("sha256").update("account:EncryptedBaseline").digest().slice(0, 8)
  const expectedDisc = [235, 60, 246, 174, 131, 9, 248, 146];
  const actualDisc = Array.from(acct?.data.slice(0, 8) ?? []);
  expect(actualDisc).to.deep.equal(expectedDisc);
});
