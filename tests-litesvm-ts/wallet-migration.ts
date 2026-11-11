import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { type Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  decodeIdentityPdaDev,
  deriveMigrationRecordPda,
  type IdentityStateAcctWeb3js,
  loadProofFixture,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  type Pdas,
  protocolConfigPda,
  treasuryPda,
  VERIFICATION_FEE,
} from "./encodeDecode.ts";
import {
  acctEqual,
  acctIsNull,
  admin,
  adminKp,
  authorizeNewWallet,
  balcAtaCk,
  balcSol,
  day,
  defaultRecentTimestamps,
  expectTheSameArray,
  expireBlockhash,
  getJsTime,
  getSolTime,
  initializeProtocol,
  migrateIdentity,
  mintAnchor,
  pdasBySignerKp,
  readAcct,
  readAnchorMintAcct,
  setTime,
  user1,
  svm,
  user1Kp,
  warpSlot,
  warpTime,
  zero,
} from "./litesvm-utils.ts";

/*
Build the Solana programs first:
$ anchor build
Then Install NodeJs v26.0.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/

const fixture = loadProofFixture();
const commitment = Buffer.alloc(32);
commitment.write("initial_commitment_test", "utf-8");

let signerKp: Keypair;
let newWalletKp: Keypair;
const _expectedErr = "";
let pdas: Pdas;
const tokenProgram = TOKEN_2022_PROGRAM_ID;
let rawAccData: Uint8Array<ArrayBufferLike> | undefined;
let identity: IdentityStateAcctWeb3js;
let identityOld: IdentityStateAcctWeb3js;
const tInit = getJsTime();
let t0: bigint;
const one = BigInt(1);

setTime(tInit);
//Follow z-e2e.ts tests
test("registry.initializeProtocol()", async () => {
  console.log("\n----------------== registry.initializeProtocol()");
  signerKp = adminKp;

  acctIsNull(protocolConfigPda);
  initializeProtocol(
    signerKp,
    protocolConfigPda,
    MIN_STAKE,
    CHALLENGE_EXPIRY,
    MAX_TRUST_SCORE,
    BASE_TRUST_INCREMENT,
    VERIFICATION_FEE,
  );
});

test("entrosAnchor.migrateIdentity() should fail by user1 with empty Old Identity", async () => {
  console.log(
    "\n----------------== entrosAnchor.migrateIdentity() should fail by user1 with empty Old Identity",
  );
  signerKp = user1Kp;
  pdas = pdasBySignerKp(signerKp);
  const pdasAdmin = pdasBySignerKp(adminKp);

  migrateIdentity(
    signerKp,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    pdas.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
    admin,
    pdasAdmin.mintPda,
    pdasAdmin.identityPda,
    pdasAdmin.ata,
    "AnchorError caused by account: identity_state_old. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
  );
});

test("entrosAnchor.mintAnchor() by admin", async () => {
  console.log("\n----------------== entrosAnchor.mintAnchor() by admin");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

  warpTime(5 * day + 5);
  t0 = getSolTime();
  mintAnchor(
    signerKp,
    initialCommitment,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    pdas.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
  );
  rawAccData = readAcct(pdas.identityPda, anchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  expect(identity.creation_timestamp).to.equal(t0);
  expect(identity.last_verification_timestamp).to.equal(t0);
  expectTheSameArray(identity.recent_timestamps, defaultRecentTimestamps);
});

test("entrosAnchor.authorizeNewWallet()", async () => {
  console.log("\n----------------== entrosAnchor.authorizeNewWallet()");
  signerKp = adminKp;
  newWalletKp = user1Kp;
  pdas = pdasBySignerKp(signerKp); //{signer, identityPda, mintPda, nonce, challengePda, verificationPda }

  warpTime(13 * day + 7);
  authorizeNewWallet(
    adminKp,
    pdas.identityPda,
    newWalletKp,
    tokenProgram,
    pdas.mintPda,
    pdas.ata,
  );
  rawAccData = readAcct(pdas.identityPda, anchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  identityOld = identity;
  acctEqual(identity.owner, signerKp.publicKey);
  console.log("user1:", user1.toBase58());
  acctEqual(identity.new_wallet, newWalletKp.publicKey);
});

test("entrosAnchor.migrateIdentity() by user1", async () => {
  console.log("\n----------------== entrosAnchor.migrateIdentity() by user1");
  signerKp = user1Kp;
  pdas = pdasBySignerKp(signerKp);
  const pdasAdmin = pdasBySignerKp(adminKp);

  console.log("entrosAnchor:", anchorAddr.toBase58());
  balcAtaCk(pdasAdmin.ata, one, "Mint_Old", 0);
  expireBlockhash();
  migrateIdentity(
    signerKp,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    pdas.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
    admin,
    pdasAdmin.identityPda,
    pdasAdmin.mintPda,
    pdasAdmin.ata,
  );
  rawAccData = readAcct(pdas.identityPda, anchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  acctEqual(identity.owner, signerKp.publicKey);

  expect(identity.last_verification_timestamp).to.equal(
    identityOld.last_verification_timestamp,
  );
  expect(identity.verification_count).to.equal(identityOld.verification_count);

  expect(identity.trust_score).to.equal(identityOld.trust_score);

  expect(Buffer.from(identity.current_commitment)).to.deep.equal(
    identityOld.current_commitment,
  );
  expectTheSameArray(identity.recent_timestamps, identityOld.recent_timestamps);
  acctEqual(identity.mint, pdas.mintPda);
  console.log("t0", t0);

  console.log("migrateAuthority 7");
  acctIsNull(pdasAdmin.identityPda);
  expect(balcSol(pdasAdmin.identityPda)).eq(zero);
  console.log("migrateAuthority 8");
  balcAtaCk(pdasAdmin.ata, zero, "Mint_Old", 0);
  acctIsNull(pdasAdmin.mintPda);
  readAnchorMintAcct(pdas.mintPda);

  const record = readMigrationRecord(signerKp.publicKey);
  expect(record.migratedAt).to.equal(getSolTime());
  expect(record.migratedSlot).to.equal(svm.getClock().slot);
  expect(record.previousWallet).to.equal(admin.toBase58());
  // The wallet that gave the identity away never received one.
  acctIsNull(deriveMigrationRecordPda(admin)[0]);
});

const readMigrationRecord = (wallet: PublicKey) => {
  const data = Buffer.from(
    readAcct(deriveMigrationRecordPda(wallet)[0], anchorAddr) ?? [],
  );
  expect(data.length).to.equal(57);
  return {
    migratedAt: data.readBigInt64LE(8),
    migratedSlot: data.readBigUInt64LE(16),
    previousWallet: new PublicKey(data.subarray(25, 57)).toBase58(),
  };
};

// Migration burns the old token and leaves its empty account open. The old
// wallet closes that account before it can hold an identity again.
const closeEmptyTokenAccount = (ownerKp: Keypair, tokenAccount: PublicKey) => {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.add(
    createCloseAccountInstruction(
      tokenAccount,
      ownerKp.publicKey,
      ownerKp.publicKey,
      [],
      tokenProgram,
    ),
  );
  tx.sign(ownerKp);
  svm.sendTransaction(tx);
  acctIsNull(tokenAccount);
};

const migrate = (fromKp: Keypair, toKp: Keypair) => {
  const source = pdasBySignerKp(fromKp);
  const target = pdasBySignerKp(toKp);
  expireBlockhash();
  authorizeNewWallet(
    fromKp,
    source.identityPda,
    toKp,
    tokenProgram,
    source.mintPda,
    source.ata,
  );
  expireBlockhash();
  migrateIdentity(
    toKp,
    target.identityPda,
    target.mintPda,
    mintAuthorityPda,
    target.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
    fromKp.publicKey,
    source.identityPda,
    source.mintPda,
    source.ata,
  );
};

test("a later migration to the same wallet overwrites its record", async () => {
  const first = readMigrationRecord(user1);

  // user1 -> admin. The admin wallet receives a migration for the first time.
  closeEmptyTokenAccount(adminKp, pdasBySignerKp(adminKp).ata);
  warpSlot(Number(svm.getClock().slot) + 50);
  warpTime(day);
  migrate(user1Kp, adminKp);
  const back = readMigrationRecord(admin);
  expect(back.migratedAt).to.equal(getSolTime());
  expect(back.migratedSlot).to.equal(svm.getClock().slot);
  expect(back.previousWallet).to.equal(user1.toBase58());
  expect(readMigrationRecord(user1)).to.deep.equal(first);

  // admin -> user1 again. The record at user1 moves to the new slot and time.
  closeEmptyTokenAccount(user1Kp, pdasBySignerKp(user1Kp).ata);
  warpSlot(Number(svm.getClock().slot) + 50);
  warpTime(day);
  migrate(adminKp, user1Kp);
  const second = readMigrationRecord(user1);
  expect(second.migratedAt).to.equal(getSolTime());
  expect(second.migratedSlot).to.equal(svm.getClock().slot);
  expect(second.migratedSlot > first.migratedSlot).to.equal(true);
  expect(second.migratedAt > first.migratedAt).to.equal(true);
  expect(second.previousWallet).to.equal(admin.toBase58());
  expect(readMigrationRecord(admin)).to.deep.equal(back);
});
