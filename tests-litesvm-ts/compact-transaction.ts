import { test } from "node:test";
import { expect } from "chai";
import { BN, BorshInstructionCoder, type Idl } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  deriveChallengePda,
  deriveEncryptedBaselinePda,
  deriveVerificationPda,
  getPdas,
  INSTRUCTIONS_SYSVAR,
  loadProofFixture,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  protocolConfigPda,
  treasuryPda,
  VERIFICATION_FEE,
  verifierAddr,
} from "./encodeDecode.ts";
import {
  adminKp,
  buildUpdateReceiptV4Digest,
  createChallenge,
  deterministicKeypair,
  initializeProtocol,
  initSolBalc,
  LITESVM_VALIDATOR,
  mintAnchor,
  pdasAdmin,
  sendTxns,
  svm,
  verifyProof,
  verifyProofCompact,
} from "./litesvm-utils.ts";

function loadIdl(name: "entros_anchor" | "entros_verifier"): Idl {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `target/idl/${name}.json`), "utf8"),
  ) as Idl;
}

const anchorCoder = new BorshInstructionCoder(loadIdl("entros_anchor"));
const verifierCoder = new BorshInstructionCoder(loadIdl("entros_verifier"));

function encodeInstruction(
  coder: BorshInstructionCoder,
  name: string,
  args: Record<string, unknown>,
): Buffer {
  return Buffer.from(coder.encode(name, args));
}

test("compact proof verification costs no more than the legacy instruction", () => {
  const fixture = loadProofFixture();
  const proofBytes = Buffer.from(fixture.proof_bytes);
  const legacySigner = deterministicKeypair(7);
  const compactSigner = deterministicKeypair(10);
  const legacyPdas = getPdas(legacySigner.publicKey);
  const compactPdas = getPdas(compactSigner.publicKey);
  expect(
    deriveChallengePda(legacySigner.publicKey, legacyPdas.nonce)[1],
  ).to.equal(
    deriveChallengePda(compactSigner.publicKey, compactPdas.nonce)[1],
  );
  expect(
    deriveVerificationPda(legacySigner.publicKey, legacyPdas.nonce)[1],
  ).to.equal(
    deriveVerificationPda(compactSigner.publicKey, compactPdas.nonce)[1],
  );
  svm.airdrop(legacySigner.publicKey, initSolBalc);
  svm.airdrop(compactSigner.publicKey, initSolBalc);

  const legacyConsumed = verifyProof(
    legacySigner,
    proofBytes,
    fixture.public_inputs,
    legacyPdas.nonce,
    legacyPdas.challengePda,
    legacyPdas.verificationPda,
  );

  const compactConsumed = verifyProofCompact(
    compactSigner,
    proofBytes,
    fixture.public_inputs,
    compactPdas.nonce,
    compactPdas.challengePda,
    compactPdas.verificationPda,
  );

  expect(legacyConsumed).to.not.equal(null);
  expect(compactConsumed).to.not.equal(null);
  if (legacyConsumed === null || compactConsumed === null) {
    throw new Error("proof verification did not report compute consumption");
  }
  expect(compactConsumed <= legacyConsumed).to.equal(true);
});

test("challenge creation covers observed canonical bump variance", () => {
  const signer = deterministicKeypair(38);
  const pdas = getPdas(signer.publicKey);
  svm.airdrop(signer.publicKey, initSolBalc);

  const consumed = createChallenge(
    signer,
    pdas.nonce,
    pdas.challengePda,
  );

  expect(consumed).to.not.equal(null);
});

test("the complete compact re-verification stays below the default transaction limit", () => {
  const fixture = loadProofFixture();
  const proofBytes = Buffer.from(fixture.proof_bytes);
  const publicInputs = (fixture.public_inputs as number[][]).map((input) =>
    Buffer.from(input),
  );
  const threshold = publicInputs[2].readUInt16BE(30);
  const minDistance = publicInputs[3].readUInt16BE(30);
  const [encryptedBaseline] = deriveEncryptedBaselinePda(adminKp.publicKey);

  initializeProtocol(
    adminKp,
    protocolConfigPda,
    MIN_STAKE,
    CHALLENGE_EXPIRY,
    MAX_TRUST_SCORE,
    BASE_TRUST_INCREMENT,
    VERIFICATION_FEE,
  );
  mintAnchor(
    adminKp,
    publicInputs[1],
    pdasAdmin.identityPda,
    pdasAdmin.mintPda,
    mintAuthorityPda,
    pdasAdmin.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    protocolConfigPda,
    treasuryPda,
  );

  const validatedAt = svm.getClock().unixTimestamp;
  const receiptDigest = buildUpdateReceiptV4Digest(
    adminKp.publicKey,
    publicInputs[0],
    0,
    validatedAt,
  );
  const receiptIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: LITESVM_VALIDATOR.secretKey,
    message: receiptDigest,
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({
      programId: verifierAddr,
      keys: [
        { pubkey: adminKp.publicKey, isSigner: true, isWritable: true },
        {
          pubkey: pdasAdmin.verificationPda,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: encodeInstruction(verifierCoder, "verify_proof_compact", {
        nonce: Buffer.from(pdasAdmin.nonce),
        proof_bytes: proofBytes,
        commitment_new: publicInputs[0],
        commitment_prev: publicInputs[1],
        threshold,
        min_distance: minDistance,
      }),
    }),
    receiptIx,
    new TransactionInstruction({
      programId: anchorAddr,
      keys: [
        { pubkey: adminKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: pdasAdmin.identityPda, isSigner: false, isWritable: true },
        {
          pubkey: pdasAdmin.verificationPda,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
        { pubkey: treasuryPda, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: INSTRUCTIONS_SYSVAR,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: verifierAddr,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: encodeInstruction(anchorCoder, "update_anchor_compact", {
        receipt: {
          validated_at: new BN(validatedAt.toString()),
          assurance_tier: 0,
          session_final_digest: null,
        },
      }),
    }),
    new TransactionInstruction({
      programId: anchorAddr,
      keys: [
        { pubkey: adminKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: pdasAdmin.identityPda, isSigner: false, isWritable: false },
        { pubkey: encryptedBaseline, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: encodeInstruction(anchorCoder, "set_encrypted_baseline", {
        blob: Buffer.alloc(96, 9),
      }),
    }),
  ];

  const consumed = sendTxns(
    svm.latestBlockhash(),
    instructions,
    [adminKp],
    anchorAddr,
    200_000,
  );

  expect(consumed).to.not.equal(null);
});
