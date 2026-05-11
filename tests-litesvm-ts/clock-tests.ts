import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  decodeIdentityPdaDev,
  decodeProtocolConfigDev,
  type IdentityStateAcctWeb3js,
  loadProofFixture,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  type Pdas,
  protocolConfigBump,
  protocolConfigPda,
  registryAddr,
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
  expectTheSameArray,
  getJsTime,
  initializeProtocol,
  migrateIdentity,
  mintAnchor,
  pdasBySignerKp,
  readAcct,
  setTime,
  updateAnchor,
  user1,
  user1Kp,
  verifyUser,
  warpTime,
  zero,
} from "./litesvm-utils.ts";

/* Build the Solana programs first:
$ anchor build
Then Install NodeJs v26.0.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/
const fixture = loadProofFixture();

let signerKp: Keypair;
let newWalletKp: Keypair;
let pdas: Pdas;
let trustscorePrev: number;
const tokenProgram = TOKEN_2022_PROGRAM_ID;
let rawAccData: Uint8Array<ArrayBufferLike> | undefined;
let identity: IdentityStateAcctWeb3js;
let identityOld: IdentityStateAcctWeb3js;
setTime(getJsTime());

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

  const rawAccountData = readAcct(protocolConfigPda, registryAddr);
  const decoded = decodeProtocolConfigDev(rawAccountData);
  acctEqual(decoded.admin, signerKp.publicKey);
  expect(decoded.min_stake).eq(MIN_STAKE);
  expect(decoded.challenge_expiry).eq(CHALLENGE_EXPIRY);
  expect(decoded.max_trust_score).eq(MAX_TRUST_SCORE);
  expect(decoded.base_trust_increment).eq(BASE_TRUST_INCREMENT);
  expect(decoded.bump).eq(protocolConfigBump);
  expect(decoded.verification_fee).eq(VERIFICATION_FEE);
});

test("registry.mintAnchor()", async () => {
  console.log("\n----------------== registry.mintAnchor()");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

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
  const rawAccountData = readAcct(pdas.identityPda, anchorAddr);
  const decoded = decodeIdentityPdaDev(rawAccountData);
  acctEqual(decoded.owner, signerKp.publicKey);
  expect(decoded.verification_count).to.equal(0);
  expect(decoded.trust_score).to.equal(0);
  console.log("expected initialCommitment:", initialCommitment.buffer);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(
    initialCommitment,
  );
  acctEqual(decoded.mint, pdas.mintPda);
  balcAtaCk(pdas.ata, BigInt(1), "IdentityMint", 0);
});

test("entrosAnchor.updateAnchor()", async () => {
  console.log("\n----------------== entrosAnchor.updateAnchor()");
  //update_anchor() at T=0 → trust score = 100
  signerKp = adminKp;
  const { identityPda, nonce, verificationPda, fixture } = verifyUser(signerKp);
  const newCommitment = Buffer.from(fixture.public_inputs[0]);

  updateAnchor(
    signerKp,
    newCommitment,
    nonce,
    verificationPda,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  const rawData = readAcct(identityPda);
  const decoded = decodeIdentityPdaDev(rawData);
  identityOld = decoded;
  expect(decoded.verification_count).to.equal(1);
  expect(decoded.trust_score).to.equal(100);
  trustscorePrev = decoded.trust_score;
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
  acctEqual(identity.owner, signerKp.publicKey);
  console.log("user1:", user1.toBase58());
  acctEqual(identity.new_wallet, newWalletKp.publicKey);
});

test("entrosAnchor.migrateIdentity() by user1", async () => {
  console.log("\n----------------== entrosAnchor.migrateIdentity() by user1");
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

  console.log(
    "identity new recent_timestamps:",
    identity.recent_timestamps,
    ", trust_score:",
    identity.trust_score,
    ", verification_count:",
    identity.verification_count,
  );
  console.log("migrateAuthority 7");
  acctIsNull(pdasAdmin.identityPda);
  expect(balcSol(pdasAdmin.identityPda)).eq(zero);
  console.log("migrateAuthority 8");
  balcAtaCk(pdasAdmin.ata, zero, "Mint_Old", 0);
  acctIsNull(pdasAdmin.mintPda);
});

// TODO: A second successful updateAnchor would need another fixture proof where commitment_prev = public_inputs[0] of the first, which means regenerating fixtures
test.skip("entrosAnchor.updateAnchor() 2nd & 3rd time", async () => {
  console.log(
    "\n----------------== entrosAnchor.updateAnchor() 2nd & 3rd time",
  );
  //warp 1 day + create_challenge + verify_proof + update_anchor: trust score should be ~196
  signerKp = adminKp;
  const { identityPda, nonce, verificationPda } = pdasBySignerKp(signerKp);
  const newCommitment = Buffer.alloc(32);
  newCommitment.write("updated_commitment_v2!", "utf-8");

  warpTime(1 * day);

  updateAnchor(
    signerKp,
    newCommitment,
    nonce,
    verificationPda,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  const rawAccountData = readAcct(identityPda);
  const decoded = decodeIdentityPdaDev(rawAccountData);
  expect(decoded.verification_count).to.equal(2);
  expect(decoded.trust_score).greaterThan(trustscorePrev); //198
  trustscorePrev = decoded.trust_score;

  const newCommitment3 = Buffer.alloc(32);
  newCommitment3.write("updated_commitment_v3!", "utf-8");
  warpTime(1 * day);

  updateAnchor(
    signerKp,
    newCommitment3,
    nonce,
    verificationPda,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  const rawAccountData3 = readAcct(identityPda);
  const decoded3 = decodeIdentityPdaDev(rawAccountData3);
  expect(decoded3.verification_count).to.equal(3);
  expect(decoded3.trust_score).greaterThan(trustscorePrev); //311
});
