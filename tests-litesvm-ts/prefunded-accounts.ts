import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  deriveMigrationRecordPda,
  getPdas,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  protocolConfigPda,
  treasuryPda,
  VERIFICATION_FEE,
} from "./encodeDecode.ts";
import {
  admin,
  admin2Kp,
  adminKp,
  authorizeNewWallet,
  getJsTime,
  hackerKp,
  initializeProtocol,
  migrateIdentity,
  mintAnchor,
  ownerKp,
  sendSol,
  setTime,
  svm,
  user1Kp,
} from "./litesvm-utils.ts";

/*
A program-derived address can hold lamports before its account exists, because a transfer needs
no signature from the recipient. Each case funds an address first, then runs the instruction
that creates the account there.

Build the programs first: anchor build
Run: node tests-litesvm-ts/prefunded-accounts.ts
*/

const commitment = Buffer.alloc(32);
commitment.write("initial_commitment_test", "utf-8");
const emptyAccountRent = svm.minimumBalanceForRentExemption(BigInt(0));

const mint = (signer: Keypair, expectedError = "") => {
  const pdas = getPdas(signer.publicKey);
  mintAnchor(
    signer,
    commitment,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    pdas.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    protocolConfigPda,
    treasuryPda,
    expectedError,
  );
  return pdas;
};

const expectLiveMint = (mintPda: PublicKey) => {
  const account = svm.getAccount(mintPda);
  assert.ok(account, "the mint account exists");
  assert.equal(account.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.ok(
    BigInt(account.lamports) >=
      svm.minimumBalanceForRentExemption(BigInt(account.data.length)),
    "the mint account is rent exempt at its final size",
  );
  return account;
};

setTime(getJsTime());

test("initialize the protocol", () => {
  initializeProtocol(
    adminKp,
    protocolConfigPda,
    MIN_STAKE,
    CHALLENGE_EXPIRY,
    MAX_TRUST_SCORE,
    BASE_TRUST_INCREMENT,
    VERIFICATION_FEE,
  );
});

test("a wallet with an untouched mint address mints", () => {
  const pdas = mint(adminKp);
  assert.notEqual(svm.getAccount(pdas.identityPda), null);
  expectLiveMint(pdas.mintPda);
});

test("a mint address funded at the empty-account rent floor still mints", () => {
  const pdas = getPdas(user1Kp.publicKey);
  assert.equal(svm.getAccount(pdas.mintPda), null);
  sendSol(hackerKp, pdas.mintPda, emptyAccountRent, 1000);
  assert.equal(svm.getAccount(pdas.mintPda)?.data.length, 0);

  mint(user1Kp);
  assert.notEqual(svm.getAccount(pdas.identityPda), null);
  expectLiveMint(pdas.mintPda);
});

test("a mint address funded above the full requirement keeps the surplus", () => {
  const pdas = getPdas(ownerKp.publicKey);
  const surplus = BigInt(LAMPORTS_PER_SOL);
  sendSol(hackerKp, pdas.mintPda, surplus, 1000);

  mint(ownerKp);
  const account = expectLiveMint(pdas.mintPda);
  assert.equal(BigInt(account.lamports), surplus);
});

test("a migration creates its accounts at funded addresses", () => {
  const source = getPdas(admin);
  const target = getPdas(admin2Kp.publicKey);
  const [recordPda] = deriveMigrationRecordPda(admin2Kp.publicKey);
  sendSol(hackerKp, target.mintPda, emptyAccountRent, 1000);
  sendSol(hackerKp, recordPda, emptyAccountRent, 1000);

  authorizeNewWallet(
    adminKp,
    source.identityPda,
    admin2Kp,
    TOKEN_2022_PROGRAM_ID,
    source.mintPda,
    source.ata,
  );
  migrateIdentity(
    admin2Kp,
    target.identityPda,
    target.mintPda,
    mintAuthorityPda,
    target.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    protocolConfigPda,
    treasuryPda,
    admin,
    source.identityPda,
    source.mintPda,
    source.ata,
  );
  assert.notEqual(svm.getAccount(target.identityPda), null);
  assert.equal(svm.getAccount(source.identityPda), null);
  expectLiveMint(target.mintPda);
  assert.equal(
    svm.getAccount(recordPda)?.owner.toBase58(),
    anchorAddr.toBase58(),
  );
});

test("a mint address that another program owns is refused", () => {
  const pdas = getPdas(hackerKp.publicKey);
  svm.setAccount(pdas.mintPda, {
    lamports: Number(emptyAccountRent),
    data: new Uint8Array(0),
    owner: ASSOCIATED_TOKEN_PROGRAM_ID,
    executable: false,
  });

  mint(hackerKp, "DerivedAccountInUse");
  assert.equal(svm.getAccount(pdas.identityPda), null);
});
