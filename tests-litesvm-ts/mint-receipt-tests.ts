/* Build the Solana programs first:
$ anchor build
Then run with NodeJs v26.0.0 (or v22.18.0+):
$ node ./tests-litesvm-ts/mint-receipt-tests.ts
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
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { maxComputeBudgets } from "./cu-budgets.ts";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
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
  initializeProtocol,
  pdasBySignerKp,
  sendTxns,
  setTime,
  setValidatorPubkey,
  svm,
  user1Kp,
} from "./litesvm-utils.ts";

// Pin svm clock so the validated_at timestamp baked into the receipt
// matches the on-chain Clock::get() result inside mint_anchor.
const fixedNowSecs = BigInt(1_700_000_000);
setTime(fixedNowSecs);

// Validator that will sign the receipt. The keypair is generated locally so
// we hold the secretKey and can produce a valid Ed25519 signature; the
// pubkey is registered on ProtocolConfig via setValidatorPubkey below.
const validatorKp = Keypair.generate();

const tokenProgram = TOKEN_2022_PROGRAM_ID;

const MINT_ANCHOR_DISCRIMINATOR = Buffer.from([
  68, 56, 113, 102, 236, 152, 146, 60,
]);

// Build the canonical receipt message:
//   wallet_pubkey (32) || commitment_new (32) || validated_at i64 LE (8) = 72 bytes
// Mirrors entros_validation::receipts and entros_anchor::verify_mint_receipt.
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

test("setup: initializeProtocol + setValidatorPubkey to a known signing keypair", async () => {
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
});

test("mint_anchor without an Ed25519 receipt rejects with MissingValidatorReceipt", async () => {
  // Use user1Kp so a parallel happy-path mint can run with adminKp without
  // colliding on the IdentityState PDA.
  const pdas = pdasBySignerKp(user1Kp);
  const commitment = Buffer.alloc(32, 7); // arbitrary non-zero commitment

  const expectedErr =
    "Error Number: 6015. Error Message: mint_anchor expected a preceding Ed25519Program::verify instruction with a validator-signed receipt";
  const ix = buildMintAnchorIx(
    user1Kp.publicKey,
    commitment,
    pdas.identityPda,
    pdas.mintPda,
    pdas.ata,
  );
  sendTxns(
    svm.latestBlockhash(),
    [ix],
    [user1Kp],
    anchorAddr,
    maxComputeBudgets.mint_anchor,
    expectedErr,
  );
});

test("mint_anchor with a valid Ed25519 receipt succeeds", async () => {
  const pdas = pdasBySignerKp(adminKp);
  const commitment = Buffer.alloc(32, 9); // arbitrary non-zero commitment

  const message = buildReceiptMessage(
    adminKp.publicKey,
    commitment,
    fixedNowSecs,
  );

  // createInstructionWithPrivateKey signs the message with the validator's
  // secretKey and constructs an Ed25519Program::verify ix whose three
  // *_instruction_index fields default to 0xFFFF (current ix), matching the
  // sentinel that entros_anchor pins to. The Solana runtime verifies the
  // signature before mint_anchor runs.
  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: validatorKp.secretKey,
    message,
  });

  const mintIx = buildMintAnchorIx(
    adminKp.publicKey,
    commitment,
    pdas.identityPda,
    pdas.mintPda,
    pdas.ata,
  );

  // Bundle order matters: the on-chain handler reads the ix at
  // current_index - 1 and expects it to be Ed25519Program::verify.
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.add(ed25519Ix, mintIx);
  tx.sign(adminKp);
  const sendRes = svm.sendTransaction(tx);

  // Inline assertion (instead of sendTxns/checkLogs) because the bundle
  // contains two program ids — checkLogs filters logs by a single program.
  if ("err" in sendRes) {
    throw new Error(
      `Expected mint_anchor to succeed with valid receipt, got: ${JSON.stringify((sendRes as unknown as { err: unknown }).err)}`,
    );
  }
  // The success path no longer logs from verify_mint_receipt; presence of
  // the standard mint_anchor program log is the success signal.
  const logs = (sendRes as unknown as { logs(): string[] }).logs();
  expect(
    logs.some((l) => l.includes("Program log: Instruction: MintAnchor")),
  ).to.equal(true);
});
