/* Build the Solana programs first:
$ anchor build
Then run with NodeJs v22.18.0 or newer:
$ node ./tests-litesvm-ts/paired-receipt-tests.ts
*/

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Ed25519Program,
  type Keypair,
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
  deriveIdentityPda,
  deriveMintPda,
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
  LITESVM_VALIDATOR,
  sendTxns,
  setProjectionVersions,
  setTime,
  svm,
} from "./litesvm-utils.ts";

const VECTORS_SHA256 =
  "cb88f752aed0e29a0f2321e85a2ff3006e3c1f65a933d2c729c069574445e63d";
const vectorsText = readFileSync(
  resolve(process.cwd(), "tests-litesvm-ts/fixtures/paired-round-vectors.json"),
  "utf8",
);
const vectors = JSON.parse(vectorsText);

const fixedNowSecs = BigInt(1_700_000_000);
setTime(fixedNowSecs);

const signer = adminKp;
const identityPda = deriveIdentityPda(signer.publicKey)[0];
const mintPda = deriveMintPda(signer.publicKey)[0];
const tokenAccount = getAssociatedTokenAddressSync(
  mintPda,
  signer.publicKey,
  false,
  TOKEN_2022_PROGRAM_ID,
);
const finalDigest = Buffer.from(vectors.receipts.finalDigestHex, "hex");

const EVENT_DISCRIMINATOR = createHash("sha256")
  .update("event:ReceiptSessionBound")
  .digest()
  .subarray(0, 8);

function receiptV3(
  purpose: number,
  projectionVersion: number,
  wallet: Buffer,
  commitment: Buffer,
  validatedAt: bigint,
  digest: Buffer,
  tier: number,
  domain = "entros-validator-receipt-v3\0",
): Buffer {
  const message = Buffer.alloc(136);
  Buffer.from(domain, "ascii").copy(message, 0);
  message[28] = purpose;
  message.writeUInt16LE(projectionVersion, 29);
  wallet.copy(message, 31);
  commitment.copy(message, 63);
  message.writeBigInt64LE(validatedAt, 95);
  digest.copy(message, 103);
  message[135] = tier;
  return message;
}

function receiptIx(message: Buffer): TransactionInstruction {
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: LITESVM_VALIDATOR.secretKey,
    message,
  });
}

function mintIx(commitment: Buffer): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: identityPda, isSigner: false, isWritable: true },
      { pubkey: mintPda, isSigner: false, isWritable: true },
      { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId: anchorAddr,
    data: Buffer.concat([
      Buffer.from([68, 56, 113, 102, 236, 152, 146, 60]),
      commitment,
    ]),
  });
}

function versioned(
  discriminator: number[],
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  commitment: Buffer,
  projectionVersion: number,
): TransactionInstruction {
  const version = Buffer.alloc(2);
  version.writeUInt16LE(projectionVersion);
  return new TransactionInstruction({
    keys,
    programId: anchorAddr,
    data: Buffer.concat([Buffer.from(discriminator), commitment, version]),
  });
}

function resetIx(commitment: Buffer, projectionVersion: number) {
  return versioned(
    [26, 78, 86, 143, 247, 132, 85, 203],
    [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: identityPda, isSigner: false, isWritable: true },
      { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    commitment,
    projectionVersion,
  );
}

function rebaselineIx(commitment: Buffer, projectionVersion: number) {
  return versioned(
    [129, 211, 18, 16, 17, 54, 143, 18],
    [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: identityPda, isSigner: false, isWritable: true },
      { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    commitment,
    projectionVersion,
  );
}

interface SessionEvent {
  owner: string;
  purpose: number;
  projectionVersion: number;
  finalDigest: string;
  assuranceTier: number;
}

/** Sends a transaction that must succeed and returns its session events and compute units. */
function sendAndRead(
  ixs: TransactionInstruction[],
  signers: Keypair[],
): { events: SessionEvent[]; computeUnits: bigint } {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.add(...ixs);
  tx.sign(...signers);
  const result = svm.sendTransaction(tx);
  if (!("logs" in result) || "err" in result) {
    throw new Error(`transaction failed: ${result.toString()}`);
  }
  const events: SessionEvent[] = [];
  for (const line of result.logs()) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice("Program data: ".length), "base64");
    if (!data.subarray(0, 8).equals(EVENT_DISCRIMINATOR)) continue;
    events.push({
      owner: data.subarray(8, 40).toString("hex"),
      purpose: data[40],
      projectionVersion: data.readUInt16LE(41),
      finalDigest: data.subarray(43, 75).toString("hex"),
      assuranceTier: data[75],
    });
  }
  const computeUnits = result.computeUnitsConsumed();
  console.log("computeUnits Consumed:", computeUnits);
  return { events, computeUnits };
}

test("the vector copy is the pinned generation", () => {
  expect(createHash("sha256").update(vectorsText).digest("hex")).to.equal(
    VECTORS_SHA256,
  );
});

test("this receipt builder reproduces every v3 vector", () => {
  const receipts = vectors.receipts;
  for (const entry of receipts.v3) {
    const built = receiptV3(
      entry.purpose,
      receipts.projectionVersion,
      Buffer.from(receipts.walletHex, "hex"),
      Buffer.from(receipts.commitmentHex, "hex"),
      BigInt(receipts.validatedAt),
      finalDigest,
      entry.assuranceTier,
    );
    expect(built.toString("hex")).to.equal(entry.messageHex);
  }
});

test("setup: protocol at projection 1", () => {
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
  setProjectionVersions(adminKp, 1, 0, protocolConfigPda);
});

test("a v3 mint receipt with an unknown tier is refused", () => {
  const commitment = Buffer.alloc(32, 3);
  const message = receiptV3(
    1,
    1,
    signer.publicKey.toBuffer(),
    commitment,
    fixedNowSecs,
    finalDigest,
    3,
  );
  sendTxns(
    svm.latestBlockhash(),
    [receiptIx(message), mintIx(commitment)],
    [signer],
    anchorAddr,
    maxComputeBudgets.mint_anchor,
    "InvalidAssuranceTier",
  );
});

test("a 136-byte receipt under the v2 domain is refused", () => {
  const commitment = Buffer.alloc(32, 3);
  const message = receiptV3(
    1,
    1,
    signer.publicKey.toBuffer(),
    commitment,
    fixedNowSecs,
    finalDigest,
    2,
    "entros-validator-receipt-v2\0",
  );
  sendTxns(
    svm.latestBlockhash(),
    [receiptIx(message), mintIx(commitment)],
    [signer],
    anchorAddr,
    maxComputeBudgets.mint_anchor,
    "MalformedReceiptMessage",
  );
});

test("a receipt whose length and domain disagree is refused", () => {
  const commitment = Buffer.alloc(32, 3);
  const v3 = receiptV3(
    1,
    1,
    signer.publicKey.toBuffer(),
    commitment,
    fixedNowSecs,
    finalDigest,
    2,
  );
  // The v3 domain on a v2-length body, one byte short, one byte over.
  for (const message of [
    v3.subarray(0, 103),
    v3.subarray(0, 135),
    Buffer.concat([v3, Buffer.from([0])]),
  ]) {
    sendTxns(
      svm.latestBlockhash(),
      [receiptIx(message), mintIx(commitment)],
      [signer],
      anchorAddr,
      maxComputeBudgets.mint_anchor,
      "MalformedReceiptMessage",
    );
  }
});

test("a v3 mint emits the session it consumed with its tier", () => {
  const commitment = Buffer.alloc(32, 3);
  const message = receiptV3(
    1,
    1,
    signer.publicKey.toBuffer(),
    commitment,
    fixedNowSecs,
    finalDigest,
    2,
  );
  const { events, computeUnits } = sendAndRead(
    [receiptIx(message), mintIx(commitment)],
    [signer],
  );
  expect(Number(computeUnits)).to.be.at.most(maxComputeBudgets.mint_anchor);
  expect(events).to.deep.equal([
    {
      owner: signer.publicKey.toBuffer().toString("hex"),
      purpose: 1,
      projectionVersion: 1,
      finalDigest: finalDigest.toString("hex"),
      assuranceTier: 2,
    },
  ]);
});

test("a v3 reset emits the session with the open tier", () => {
  const commitment = Buffer.alloc(32, 4);
  const message = receiptV3(
    3,
    1,
    signer.publicKey.toBuffer(),
    commitment,
    fixedNowSecs,
    finalDigest,
    0,
  );
  const { events, computeUnits } = sendAndRead(
    [receiptIx(message), resetIx(commitment, 1)],
    [signer],
  );
  expect(Number(computeUnits)).to.be.at.most(
    maxComputeBudgets.reset_identity_state,
  );
  expect(events).to.have.length(1);
  expect(events[0].purpose).to.equal(3);
  expect(events[0].assuranceTier).to.equal(0);
});

test("a v3 rebaseline emits the session after the projection advances", () => {
  setProjectionVersions(adminKp, 2, 1, protocolConfigPda);
  const commitment = Buffer.alloc(32, 5);
  const message = receiptV3(
    2,
    2,
    signer.publicKey.toBuffer(),
    commitment,
    fixedNowSecs,
    finalDigest,
    1,
  );
  const { events, computeUnits } = sendAndRead(
    [receiptIx(message), rebaselineIx(commitment, 2)],
    [signer],
  );
  expect(Number(computeUnits)).to.be.at.most(maxComputeBudgets.rebaseline_anchor);
  expect(events).to.have.length(1);
  expect(events[0].purpose).to.equal(2);
  expect(events[0].projectionVersion).to.equal(2);
  expect(events[0].assuranceTier).to.equal(1);
});

test("a v2 receipt emits no session event", () => {
  // Past the reset cooldown the v3 reset above started.
  const later = fixedNowSecs + BigInt(8 * 86_400);
  setTime(later);
  const commitment = Buffer.alloc(32, 6);
  const message = receiptV3(
    3,
    2,
    signer.publicKey.toBuffer(),
    commitment,
    later,
    finalDigest,
    0,
    "entros-validator-receipt-v2\0",
  ).subarray(0, 103);
  const { events } = sendAndRead(
    [receiptIx(message), resetIx(commitment, 2)],
    [signer],
  );
  expect(events).to.deep.equal([]);
});
