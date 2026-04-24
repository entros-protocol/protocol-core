import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import {
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  decodeIdentityPdaDev,
  getAta,
  type IdentityStateAcctWeb3js,
  iamAnchorAddr,
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
  adminKp,
  ataBalCk,
  authorizeNewWallet,
  balcSol,
  day,
  defaultRecentTimestamps,
  expectTheSameArray,
  getJsTime,
  getSolTime,
  initializeProtocol,
  migrateIdentity,
  mintAnchor,
  pdasBySignerKp,
  readAcct,
  setTime,
  user1,
  user1Kp,
  warpTime,
} from "./litesvm-utils.ts";

/*
Build the Solana programs first:
$ anchor build
Then Install NodeJs v25.9.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/

const fixture = loadProofFixture();
const commitment = Buffer.alloc(32);
commitment.write("initial_commitment_test", "utf-8");

let signerKp: Keypair;
let signer2Kp: Keypair;
const _expectedErr = "";
let pdas: Pdas;
const tokenProgram = TOKEN_2022_PROGRAM_ID;
let rawAccData: Uint8Array<ArrayBufferLike> | undefined;
let identity: IdentityStateAcctWeb3js;
let identityOld: IdentityStateAcctWeb3js;
const tInit = getJsTime();
let t0: bigint;
let t1: bigint;

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

test("iamAnchor.mintAnchor() by admin", async () => {
  console.log("\n----------------== iamAnchor.mintAnchor() by admin");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const ata = getAta(pdas.mintPda, pdas.signer, false, tokenProgram);
  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

  warpTime(5 * day + 5);
  t0 = getSolTime();
  mintAnchor(
    signerKp,
    initialCommitment,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
  );
  rawAccData = readAcct(pdas.identityPda, iamAnchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  expect(identity.creation_timestamp).to.equal(t0);
  expect(identity.last_verification_timestamp).to.equal(t0);
  expectTheSameArray(identity.recent_timestamps, defaultRecentTimestamps);
});

test("iamAnchor.authorizeNewWallet()", async () => {
  console.log("\n----------------== iamAnchor.authorizeNewWallet()");
  signerKp = adminKp;
  signer2Kp = user1Kp;
  pdas = pdasBySignerKp(signerKp); //{signer, identityPda, mintPda, nonce, challengePda, verificationPda }

  warpTime(13 * day + 7);
  authorizeNewWallet(adminKp, pdas.identityPda, signer2Kp);
  rawAccData = readAcct(pdas.identityPda, iamAnchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  identityOld = identity;
  acctEqual(identity.owner, signerKp.publicKey);
  console.log("user1:", user1.toBase58());
  acctEqual(identity.new_wallet, signer2Kp.publicKey);
});

test("iamAnchor.mintAnchor() by user1", async () => {
  console.log("\n----------------== iamAnchor.mintAnchor() by user1");
  signerKp = user1Kp;
  pdas = pdasBySignerKp(signerKp);
  const ata = getAta(pdas.mintPda, pdas.signer, false, tokenProgram);
  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

  warpTime(33 * day + 3);
  t1 = getSolTime();
  mintAnchor(
    signerKp,
    initialCommitment,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
  );
  rawAccData = readAcct(pdas.identityPda, iamAnchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  acctEqual(identity.owner, signerKp.publicKey);
  expect(identity.verification_count).to.equal(0);
  expect(identity.trust_score).to.equal(0);
  console.log("expected initialCommitment:", initialCommitment.buffer);
  expect(Buffer.from(identity.current_commitment)).to.deep.equal(
    initialCommitment,
  );
  acctEqual(identity.mint, pdas.mintPda);
  ataBalCk(ata, BigInt(1), "IdentityMint", 0);

  expect(identity.creation_timestamp).to.equal(t1);
  expect(identity.last_verification_timestamp).to.equal(t1);
  expectTheSameArray(identity.recent_timestamps, defaultRecentTimestamps);
});

test("iamAnchor.migrateIdentity() by user1", async () => {
  console.log("\n----------------== iamAnchor.migrateIdentity() by user1");
  signerKp = user1Kp;
  pdas = pdasBySignerKp(signerKp);
  const pdasAdmin = pdasBySignerKp(adminKp);
  const ata = getAta(pdas.mintPda, pdas.signer, false, tokenProgram);

  migrateIdentity(
    signerKp,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
    pdasAdmin.signer,
    pdasAdmin.identityPda,
  );
  rawAccData = readAcct(pdas.identityPda, iamAnchorAddr);
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
  console.log("t0", t0, ", t1", t1);

  expect(balcSol(pdasAdmin.identityPda)).eq(null);
  acctIsNull(pdasAdmin.identityPda);
  //TODO: test fail:
  //TODO: Make TokenProgram to close old Mint and burn tokens, close TokenAccount...
  //acctIsNull(pdasAdmin.mintPda);
  //acctIsNull(ata);
});
