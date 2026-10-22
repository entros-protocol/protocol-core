import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { BN, BorshCoder, type Idl } from "@anchor-lang/core";
import {
  Ed25519Program,
  type Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  getPdas,
  INSTRUCTIONS_SYSVAR,
  loadProofFixture,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  protocolConfigPda,
  registryAddr,
  SYSTEM_PROGRAM,
  treasuryPda,
  VERIFICATION_FEE,
  verifierAddr,
} from "./encodeDecode.ts";
import {
  adminKp,
  buildUpdateReceiptV4Digest,
  deterministicKeypair,
  initializeProtocol,
  LITESVM_VALIDATOR,
  mintAnchor,
  sendTxns,
  setProjectionVersions,
  setTime,
  svm,
  verifyProof,
} from "./litesvm-utils.ts";

const anchorIdl = JSON.parse(
  readFileSync(resolve(process.cwd(), "target/idl/entros_anchor.json"), "utf8"),
) as Idl;
const registryIdl = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "target/idl/entros_registry.json"),
    "utf8",
  ),
) as Idl;
const anchorCoder = new BorshCoder(anchorIdl);
const registryCoder = new BorshCoder(registryIdl);
const proofFixture = loadProofFixture();
const proofBytes = Buffer.from(proofFixture.proof_bytes);
const publicInputs: number[][] = proofFixture.public_inputs;

const baseTime = 1_700_000_000n;
setTime(baseTime);

function execTx(
  signer: Keypair,
  ixs: TransactionInstruction[],
  programId: PublicKey,
  expectedError = "",
) {
  svm.expireBlockhash();
  return sendTxns(
    svm.latestBlockhash(),
    ixs,
    [signer],
    programId,
    200_000,
    expectedError,
  );
}

function buildUpdateAnchorIx(
  signer: PublicKey,
  identityPda: PublicKey,
  verificationPda: PublicKey,
  newCommitment: Buffer,
  validatedAt: bigint,
  assuranceTier = 0,
  sessionFinalDigest: number[] | null = null,
): TransactionInstruction {
  const data = anchorCoder.instruction.encode("update_anchor", {
    new_commitment: Array.from(newCommitment),
    receipt: {
      validated_at: new BN(validatedAt.toString()),
      assurance_tier: assuranceTier,
      session_final_digest: sessionFinalDigest,
    },
  });
  return new TransactionInstruction({
    programId: anchorAddr,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: identityPda, isSigner: false, isWritable: true },
      { pubkey: verificationPda, isSigner: false, isWritable: true },
      { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: verifierAddr, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function bootstrapUserForUpdate(
  seed: number,
  validatorKeypair: Keypair = LITESVM_VALIDATOR,
): {
  user: Keypair;
  identityPda: PublicKey;
  verificationPda: PublicKey;
  newCommitment: Buffer;
} {
  const user = deterministicKeypair(seed);
  svm.airdrop(user.publicKey, 10_000_000_000n);
  const pdas = getPdas(user.publicKey);
  const prevCommitment = Buffer.from(publicInputs[1]);
  const newCommitment = Buffer.from(publicInputs[0]);
  const now = svm.getClock().unixTimestamp;

  const mintTs = Buffer.alloc(8);
  mintTs.writeBigInt64LE(now);
  const mintVersion = Buffer.alloc(2);
  mintVersion.writeUInt16LE(1);
  const mintReceiptMsg = Buffer.concat([
    Buffer.from("entros-validator-receipt-v2\0", "ascii"),
    Buffer.from([1]),
    mintVersion,
    user.publicKey.toBuffer(),
    prevCommitment,
    mintTs,
  ]);
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: validatorKeypair.secretKey,
        message: mintReceiptMsg,
      }),
      new TransactionInstruction({
        programId: anchorAddr,
        keys: [
          { pubkey: user.publicKey, isSigner: true, isWritable: true },
          { pubkey: pdas.identityPda, isSigner: false, isWritable: true },
          { pubkey: pdas.mintPda, isSigner: false, isWritable: true },
          { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
          { pubkey: pdas.ata, isSigner: false, isWritable: true },
          {
            pubkey: new PublicKey(
              "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
            ),
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: new PublicKey(
              "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            ),
            isSigner: false,
            isWritable: false,
          },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
          { pubkey: treasuryPda, isSigner: false, isWritable: true },
          { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
        ],
        data: anchorCoder.instruction.encode("mint_anchor", {
          initial_commitment: Array.from(prevCommitment),
        }),
      }),
    ],
    anchorAddr,
  );
  verifyProof(
    user,
    proofBytes,
    publicInputs,
    pdas.nonce,
    pdas.challengePda,
    pdas.verificationPda,
  );
  expect(svm.getAccount(pdas.verificationPda)).to.not.be.null;
  return {
    user,
    identityPda: pdas.identityPda,
    verificationPda: pdas.verificationPda,
    newCommitment,
  };
}

test("setup protocol at projection version 1", () => {
  initializeProtocol(
    adminKp,
    protocolConfigPda,
    MIN_STAKE,
    CHALLENGE_EXPIRY,
    MAX_TRUST_SCORE,
    BASE_TRUST_INCREMENT,
    VERIFICATION_FEE,
    LITESVM_VALIDATOR.publicKey,
  );
  setProjectionVersions(adminKp, 1, 1, protocolConfigPda);
});

test("update_anchor enforces v4 receipt digest invariants and atomically closes VerificationResult", () => {
  const { user, identityPda, verificationPda, newCommitment } =
    bootstrapUserForUpdate(61);
  const now = svm.getClock().unixTimestamp;

  // 1. Missing preceding Ed25519 receipt instruction -> MissingValidatorReceipt
  execTx(
    user,
    [
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        now,
      ),
    ],
    anchorAddr,
    "MissingValidatorReceipt",
  );

  // 2. Wrong commitment in digest -> ReceiptCommitmentMismatch
  const wrongCommitmentDigest = buildUpdateReceiptV4Digest(
    user.publicKey,
    Buffer.alloc(32, 0xaa),
    1,
    now,
  );
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: wrongCommitmentDigest,
      }),
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        now,
      ),
    ],
    anchorAddr,
    "ReceiptCommitmentMismatch",
  );

  // 3. Expired receipt (now - 301) -> ReceiptExpired
  const expiredTs = now - 301n;
  const expiredDigest = buildUpdateReceiptV4Digest(
    user.publicKey,
    newCommitment,
    1,
    expiredTs,
  );
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: expiredDigest,
      }),
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        expiredTs,
      ),
    ],
    anchorAddr,
    "ReceiptExpired",
  );

  // 4. Future receipt (now + 1) -> ReceiptFromFuture
  const futureTs = now + 1n;
  const futureDigest = buildUpdateReceiptV4Digest(
    user.publicKey,
    newCommitment,
    1,
    futureTs,
  );
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: futureDigest,
      }),
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        futureTs,
      ),
    ],
    anchorAddr,
    "ReceiptFromFuture",
  );

  // 4b. Pre-verification receipt (now - 10, within 300s window but older than last_verification_timestamp) -> ReceiptAlreadyUsed
  const staleReceiptTs = now - 10n;
  const staleReceiptDigest = buildUpdateReceiptV4Digest(
    user.publicKey,
    newCommitment,
    1,
    staleReceiptTs,
  );
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: staleReceiptDigest,
      }),
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        staleReceiptTs,
      ),
    ],
    anchorAddr,
    "ReceiptAlreadyUsed",
  );

  // 5. Invalid assurance tier (3 > MAX_ASSURANCE_TIER=2) -> ReceiptInvalidAssuranceTier
  const badTierDigest = buildUpdateReceiptV4Digest(
    user.publicKey,
    newCommitment,
    1,
    now,
    3,
  );
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: badTierDigest,
      }),
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        now,
        3,
      ),
    ],
    anchorAddr,
    "InvalidAssuranceTier",
  );

  // 6. Mismatched session_final_digest -> ReceiptCommitmentMismatch
  const sessionDigestA = Array.from(Buffer.alloc(32, 0x42));
  const sessionDigestB = Array.from(Buffer.alloc(32, 0x43));
  const signedWithA = buildUpdateReceiptV4Digest(
    user.publicKey,
    newCommitment,
    1,
    now,
    1,
    sessionDigestA,
  );
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: signedWithA,
      }),
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        now,
        1,
        sessionDigestB,
      ),
    ],
    anchorAddr,
    "ReceiptCommitmentMismatch",
  );

  // VerificationResult is still open after all rejected attempts
  expect(svm.getAccount(verificationPda)).to.not.be.null;

  // 7. Valid v4 receipt with session_final_digest succeeds and atomically closes VerificationResult
  execTx(
    user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: signedWithA,
      }),
      buildUpdateAnchorIx(
        user.publicKey,
        identityPda,
        verificationPda,
        newCommitment,
        now,
        1,
        sessionDigestA,
      ),
    ],
    anchorAddr,
  );
  expect(svm.getAccount(verificationPda)).to.be.null;
});

test("rotate_validator_pubkey accepts both primary and secondary validator keys during grace window and rejects secondary after expiry", () => {
  const newValidatorKp = deterministicKeypair(77);
  const rotateData = registryCoder.instruction.encode(
    "rotate_validator_pubkey",
    {
      new_validator_pubkey: newValidatorKp.publicKey,
      grace_period_secs: new BN(3600),
    },
  );
  execTx(
    adminKp,
    [
      new TransactionInstruction({
        programId: registryAddr,
        keys: [
          { pubkey: adminKp.publicKey, isSigner: true, isWritable: true },
          { pubkey: protocolConfigPda, isSigner: false, isWritable: true },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: rotateData,
      }),
    ],
    registryAddr,
  );

  // Advance 1800s (inside 3600s grace window): old secondary key (LITESVM_VALIDATOR) still accepted
  setTime(baseTime + 1800n);
  const userOldKey = bootstrapUserForUpdate(62);
  const nowInsideGrace = svm.getClock().unixTimestamp;
  const oldKeyDigest = buildUpdateReceiptV4Digest(
    userOldKey.user.publicKey,
    userOldKey.newCommitment,
    1,
    nowInsideGrace,
  );
  execTx(
    userOldKey.user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: oldKeyDigest,
      }),
      buildUpdateAnchorIx(
        userOldKey.user.publicKey,
        userOldKey.identityPda,
        userOldKey.verificationPda,
        userOldKey.newCommitment,
        nowInsideGrace,
      ),
    ],
    anchorAddr,
  );
  expect(svm.getAccount(userOldKey.verificationPda)).to.be.null;

  // Advance past grace window (baseTime + 3601s): old secondary key rejected with ReceiptWrongSigner (6018 = 0x1782)
  setTime(baseTime + 3601n);
  const userAfterGrace = bootstrapUserForUpdate(63, newValidatorKp);
  const nowAfterGrace = svm.getClock().unixTimestamp;

  // Old secondary key fails with ReceiptValidatorMismatch
  const afterGraceDigest = buildUpdateReceiptV4Digest(
    userAfterGrace.user.publicKey,
    userAfterGrace.newCommitment,
    1,
    nowAfterGrace,
  );
  execTx(
    userAfterGrace.user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: LITESVM_VALIDATOR.secretKey,
        message: afterGraceDigest,
      }),
      buildUpdateAnchorIx(
        userAfterGrace.user.publicKey,
        userAfterGrace.identityPda,
        userAfterGrace.verificationPda,
        userAfterGrace.newCommitment,
        nowAfterGrace,
      ),
    ],
    anchorAddr,
    "ReceiptValidatorMismatch",
  );

  // New primary key succeeds
  execTx(
    userAfterGrace.user,
    [
      Ed25519Program.createInstructionWithPrivateKey({
        privateKey: newValidatorKp.secretKey,
        message: afterGraceDigest,
      }),
      buildUpdateAnchorIx(
        userAfterGrace.user.publicKey,
        userAfterGrace.identityPda,
        userAfterGrace.verificationPda,
        userAfterGrace.newCommitment,
        nowAfterGrace,
      ),
    ],
    anchorAddr,
  );
  expect(svm.getAccount(userAfterGrace.verificationPda)).to.be.null;
});

test("propose_authority and accept_authority enforce two-step authority transfer", () => {
  const nextAdminKp = deterministicKeypair(78);
  const wrongKp = deterministicKeypair(79);
  svm.airdrop(nextAdminKp.publicKey, 2_000_000_000n);
  svm.airdrop(wrongKp.publicKey, 2_000_000_000n);

  const proposeData = registryCoder.instruction.encode("propose_authority", {
    new_authority: nextAdminKp.publicKey,
  });
  execTx(
    adminKp,
    [
      new TransactionInstruction({
        programId: registryAddr,
        keys: [
          { pubkey: adminKp.publicKey, isSigner: true, isWritable: true },
          { pubkey: protocolConfigPda, isSigner: false, isWritable: true },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: proposeData,
      }),
    ],
    registryAddr,
  );

  const acceptData = registryCoder.instruction.encode("accept_authority", {});
  // Non-pending authority rejected with Unauthorized (6003 = 0x1773)
  execTx(
    wrongKp,
    [
      new TransactionInstruction({
        programId: registryAddr,
        keys: [
          { pubkey: wrongKp.publicKey, isSigner: true, isWritable: false },
          { pubkey: protocolConfigPda, isSigner: false, isWritable: true },
        ],
        data: acceptData,
      }),
    ],
    registryAddr,
    "0x1773",
  );

  // Pending authority accepts
  execTx(
    nextAdminKp,
    [
      new TransactionInstruction({
        programId: registryAddr,
        keys: [
          { pubkey: nextAdminKp.publicKey, isSigner: true, isWritable: false },
          { pubkey: protocolConfigPda, isSigner: false, isWritable: true },
        ],
        data: acceptData,
      }),
    ],
    registryAddr,
  );
});
