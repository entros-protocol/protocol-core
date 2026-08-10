import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  decodeIdentityPdaDev,
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
  mintAnchor,
  readAcct,
  resetIdentityStateVersioned,
  setProjectionVersions,
  setTime,
  svm,
} from "./litesvm-utils.ts";

const fixedNowSecs = BigInt(1_700_000_000);
const initialCommitment = Buffer.alloc(32, 7);
const resetCommitment = Buffer.alloc(32, 9);
const identityPda = deriveIdentityPda(adminKp.publicKey)[0];
const mintPda = deriveMintPda(adminKp.publicKey)[0];
const tokenProgram = TOKEN_2022_PROGRAM_ID;
const tokenAccount = getAssociatedTokenAddressSync(
  mintPda,
  adminKp.publicKey,
  false,
  tokenProgram,
);

setTime(fixedNowSecs);

test("setup a projection-zero identity and advance the protocol", () => {
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
  mintAnchor(
    adminKp,
    initialCommitment,
    identityPda,
    mintPda,
    mintAuthorityPda,
    tokenAccount,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
  );
});

test("projection-zero reset rejects unexpected receipt accounts", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    0,
    { purpose: 3, validatedAt: fixedNowSecs },
    "InvalidResetReceiptAccounts",
  );
});

test("advance the protocol projection", () => {
  setProjectionVersions(adminKp, 1, 0, protocolConfigPda);
});

test("versioned reset rejects a missing instructions sysvar", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    null,
    "InvalidResetReceiptAccounts",
    [],
  );
});

test("versioned reset rejects the wrong remaining account", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    null,
    "InvalidResetReceiptAccounts",
    [SYSTEM_PROGRAM],
  );
});

test("versioned reset rejects duplicate remaining accounts", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    null,
    "InvalidResetReceiptAccounts",
    [INSTRUCTIONS_SYSVAR, INSTRUCTIONS_SYSVAR],
  );
});

test("versioned reset rejects an extra remaining account", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    null,
    "InvalidResetReceiptAccounts",
    [INSTRUCTIONS_SYSVAR, SYSTEM_PROGRAM],
  );
});

test("versioned reset rejects a missing receipt", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    null,
    "MissingValidatorReceipt",
  );
});

test("versioned reset rejects a receipt for another purpose", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    { purpose: 2, validatedAt: fixedNowSecs },
    "ReceiptPurposeMismatch",
  );
});

test("versioned reset rejects an expired receipt", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    { purpose: 3, validatedAt: fixedNowSecs - BigInt(301) },
    "ReceiptExpired",
  );
});

test("versioned reset rejects a receipt for another wallet", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    { purpose: 3, validatedAt: fixedNowSecs, wallet: mintPda },
    "ReceiptWalletMismatch",
  );
});

test("versioned reset rejects a receipt for another projection", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    { purpose: 3, validatedAt: fixedNowSecs, projectionVersion: 2 },
    "ReceiptProjectionVersionMismatch",
  );
});

test("versioned reset accepts a fresh reset receipt", () => {
  resetIdentityStateVersioned(
    adminKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    1,
    { purpose: 3, validatedAt: fixedNowSecs },
  );

  const rawAccountData = readAcct(identityPda, anchorAddr);
  const identity = decodeIdentityPdaDev(rawAccountData);
  expect(Buffer.from(identity.current_commitment)).to.deep.equal(
    resetCommitment,
  );
  expect(Buffer.from(rawAccountData ?? []).readUInt16LE(583)).to.equal(1);
  expect(identity.verification_count).to.equal(0);
  expect(identity.trust_score).to.equal(0);
});
