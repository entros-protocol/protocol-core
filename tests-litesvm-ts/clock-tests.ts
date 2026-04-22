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
  decodeProtocolConfigDev,
  getAta,
  iamAnchorAddr,
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
  adminKp,
  ataBalCk,
  day,
  getJsTime,
  initializeProtocol,
  mintAnchor,
  pdasBySignerKp,
  readAcct,
  setTime,
  updateAnchor,
  verifyUser,
  warpTime,
} from "./litesvm-utils.ts";

/* Build the Solana programs first:
$ anchor build
Then Install NodeJs v25.9.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/
const fixture = loadProofFixture();

let signerKp: Keypair;
let pdas: Pdas;
let trustscorePrev: number;
setTime(BigInt(getJsTime()));

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
  const tokenProgram = TOKEN_2022_PROGRAM_ID;
  const ata = getAta(pdas.mintPda, pdas.signer, false, tokenProgram);

  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

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
  const rawAccountData = readAcct(pdas.identityPda, iamAnchorAddr);
  const decoded = decodeIdentityPdaDev(rawAccountData);
  acctEqual(decoded.owner, pdas.signer);
  expect(decoded.verification_count).to.equal(0);
  expect(decoded.trust_score).to.equal(0);
  console.log("expected initialCommitment:", initialCommitment.buffer);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(
    initialCommitment,
  );
  acctEqual(decoded.mint, pdas.mintPda);
  ataBalCk(ata, BigInt(1), "IdentityMint", 0);
});

test("iamAnchor.updateAnchor()", async () => {
  console.log("\n----------------== iamAnchor.updateAnchor()");
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
  const rawAccountData = readAcct(identityPda);
  const decoded = decodeIdentityPdaDev(rawAccountData);
  expect(decoded.verification_count).to.equal(1);
  expect(decoded.trust_score).to.equal(100);
  trustscorePrev = decoded.trust_score;
});

// TODO: A second successful updateAnchor would need another fixture proof where commitment_prev = public_inputs[0] of the first, which means regenerating fixtures
test.skip("iamAnchor.updateAnchor() 2nd & 3rd time", async () => {
  console.log("\n----------------== iamAnchor.updateAnchor() 2nd & 3rd time");
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

/* challengeExpiry test:
const fixture = loadProofFixture();
const proofBytes = Buffer.from(fixture.proof_bytes); // Vec<u8>
const publicInputs: number[][] = fixture.public_inputs; // Vec<[u8; 32]>
*/
