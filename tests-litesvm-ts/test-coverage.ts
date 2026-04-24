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
  deriveValidatorState,
  getAta,
  type IdentityStateAcctWeb3js,
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
  vaultPda,
} from "./encodeDecode.ts";
import {
  acctEqual,
  acctIsNull,
  adminKp,
  ataBalCk,
  createChallenge,
  expireBlockhash,
  initializeProtocol,
  mintAnchor,
  pdasAdmin,
  pdasBySignerKp,
  readAcct,
  registerValidator,
  updateAnchor,
  updateProtocolConfig,
  user1Kp,
  verifyProof,
} from "./litesvm-utils.ts";

/*
Build the Solana programs first:
$ anchor build
Then Install NodeJs v25.9.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/

const fixture = loadProofFixture();
const commitment = Buffer.alloc(32);

let signerKp: Keypair;
let expectedErr = "";
let pdas: Pdas;
let rawAccData: Uint8Array<ArrayBufferLike> | undefined;
let identity: IdentityStateAcctWeb3js;

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
  rawAccData = readAcct(protocolConfigPda, registryAddr);
  const config = decodeProtocolConfigDev(rawAccData);
  acctEqual(config.admin, signerKp.publicKey);
  expect(config.min_stake).eq(MIN_STAKE);
  expect(config.challenge_expiry).eq(CHALLENGE_EXPIRY);
  expect(config.max_trust_score).eq(MAX_TRUST_SCORE);
  expect(config.base_trust_increment).eq(BASE_TRUST_INCREMENT);
  expect(config.bump).eq(protocolConfigBump);
  expect(config.verification_fee).eq(VERIFICATION_FEE);
});

test("iamAnchor.updateAnchor(): calling this before mint_anchor() should fail", async () => {
  console.log(
    "\n----------------== iamAnchor.updateAnchor(): calling this before mint_anchor() should fail",
  );
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const newCommitment = Buffer.from(fixture.public_inputs[0]);

  expectedErr =
    "Error Code: InvalidIdentityState. Error Number: 6004. Error Message: Identity state account failed to deserialize";
  updateAnchor(
    signerKp,
    newCommitment,
    pdas.nonce,
    pdas.verificationPda,
    pdas.identityPda,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("iamAnchor.mintAnchor()", async () => {
  console.log("\n----------------== iamAnchor.mintAnchor()");
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
});

test("iamVerifier.createChallenge()", async () => {
  console.log("\n----------------== iamVerifier.createChallenge()");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  createChallenge(signerKp, pdas.nonce, pdas.challengePda);
});
test("iamVerifier.verifyProof()", async () => {
  console.log("\n----------------== iamVerifier.verifyProof()");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);

  const proofBytes: Buffer<ArrayBuffer> = Buffer.from(fixture.proof_bytes); // for Rust Vec<u8>
  const publicInputs: number[][] = fixture.public_inputs; // for Rust Vec<[u8; 32]>
  verifyProof(
    signerKp,
    proofBytes,
    publicInputs,
    pdas.nonce,
    pdas.challengePda,
    pdas.verificationPda,
  );
});

test("iamAnchor.updateAnchor(): 1st time", async () => {
  console.log("\n----------------== iamAnchor.updateAnchor(): 1st time");
  signerKp = adminKp;
  const { identityPda, nonce, verificationPda } = pdasBySignerKp(signerKp); // verifyUser(signerKp) is broken into pdasBySignerKp, createChallenge, and verifyProof above

  const newCommitment = Buffer.from(fixture.public_inputs[0]);

  expireBlockhash();
  updateAnchor(
    signerKp,
    newCommitment,
    nonce,
    verificationPda,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  rawAccData = readAcct(identityPda);
  identity = decodeIdentityPdaDev(rawAccData);
  expect(identity.verification_count).to.equal(1);
  expect(Buffer.from(identity.current_commitment)).to.deep.equal(newCommitment);
});

test("iamAnchor.mintAnchor(): 2nd time from the same wallet should fail", async () => {
  console.log(
    "\n----------------== iamAnchor.mintAnchor(): 2nd time from the same wallet should fail",
  );
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const tokenProgram = TOKEN_2022_PROGRAM_ID;
  const ata = getAta(pdas.mintPda, pdas.signer, false, tokenProgram);

  expectedErr = "custom program error: 0x0";
  expireBlockhash();
  mintAnchor(
    signerKp,
    commitment,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("iamAnchor.updateAnchor(): passing 32 zero bytes as commitment should fail", async () => {
  console.log(
    "\n----------------== iamAnchor.updateAnchor(): passing 32 zero bytes as commitment should fail",
  );
  //update_anchor() at T=0 → trust score = 100
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const newCommitment = Buffer.alloc(32);
  console.log("newCommitment", newCommitment);

  expectedErr =
    "Error Number: 6000. Error Message: Invalid commitment: must be 32 non-zero bytes";
  updateAnchor(
    signerKp,
    newCommitment,
    pdas.nonce,
    pdas.verificationPda,
    pdas.identityPda,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("iamAnchor.updateAnchor(): a wallet calling this on another wallet's IdentityState should fail", async () => {
  console.log(
    "\n----------------== iamAnchor.updateAnchor(): a wallet calling this on another wallet's IdentityState should fail",
  );
  signerKp = user1Kp;
  pdas = pdasAdmin;
  const newCommitment = Buffer.from(fixture.public_inputs[0]);

  expectedErr =
    "identity_state. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.";
  updateAnchor(
    signerKp,
    newCommitment,
    pdas.nonce,
    pdas.verificationPda,
    pdas.identityPda,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

// TODO: A second successful updateAnchor would need another fixture proof where commitment_prev = public_inputs[0] of the first, which means regenerating fixtures
test.skip("iamAnchor.updateAnchor(): 2nd time", async () => {
  console.log("\n----------------== iamAnchor.updateAnchor(): 2nd time");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const newCommitment = Buffer.from(fixture.public_inputs[0]);

  updateAnchor(
    signerKp,
    newCommitment,
    pdas.nonce,
    pdas.verificationPda,
    pdas.identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  rawAccData = readAcct(pdas.identityPda);
  identity = decodeIdentityPdaDev(rawAccData);
  expect(identity.verification_count).to.equal(2);
  expect(Buffer.from(identity.current_commitment)).to.deep.equal(newCommitment);
});

//----------------==
test("iamVerifier.createChallenge(): 2nd time with the same nonce should fail", async () => {
  console.log(
    "\n----------------== iamVerifier.createChallenge(): 2nd time with the same nonce should fail",
  );
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);

  expectedErr = "custom program error: 0x0";
  expireBlockhash();
  createChallenge(signerKp, pdas.nonce, pdas.challengePda, expectedErr);
});

test("iamVerifier.createChallenge() with another wallet's challenge should fail", async () => {
  console.log(
    "\n----------------== iamVerifier.createChallenge() with another wallet's challenge should fail",
  );
  signerKp = user1Kp;
  const pdasAdmin = pdasBySignerKp(signerKp);

  expectedErr =
    "AnchorError caused by account: challenge. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated";
  createChallenge(
    signerKp,
    pdasAdmin.nonce,
    pdasAdmin.challengePda,
    expectedErr,
  );
});

//----------------==
test("registry.initializeProtocol(): 2nd time should fail", async () => {
  console.log(
    "\n----------------== registry.initializeProtocol(): 2nd time should fail",
  );
  signerKp = adminKp;
  const challenge_expiry = BigInt(300); //i64,
  const max_trust_score = 10000; //u16,
  const base_trust_increment = 100; //u16,
  const verification_fee = BigInt(0);

  expectedErr = "custom program error: 0x0";
  expireBlockhash();
  initializeProtocol(
    signerKp,
    protocolConfigPda,
    MIN_STAKE,
    challenge_expiry,
    max_trust_score,
    base_trust_increment,
    verification_fee,
    expectedErr,
  );
});

test("registry.updateProtocolConfig() should fail by non-admin", async () => {
  console.log(
    "\n----------------== registry.updateProtocolConfig() should fail by non-admin",
  );
  signerKp = user1Kp;
  const verification_fee = BigInt(0);

  expectedErr =
    "AnchorError caused by account: admin. Error Code: Unauthorized. Error Number: 6003. Error Message: Unauthorized: caller is not the expected authority";
  updateProtocolConfig(
    signerKp,
    verification_fee,
    protocolConfigPda,
    expectedErr,
  );
});

test("registry.registerValidator() with insufficient SOL", async () => {
  console.log(
    "\n----------------== registry.registerValidator() with insufficient SOL",
  );
  signerKp = user1Kp;
  const minStake = MIN_STAKE - BigInt(100);
  const [validatorStatePda] = deriveValidatorState(signerKp.publicKey);

  expectedErr =
    "InsufficientStake. Error Number: 6000. Error Message: Insufficient stake amount";
  registerValidator(
    signerKp,
    minStake,
    protocolConfigPda,
    validatorStatePda,
    vaultPda,
    expectedErr,
  );
});

test("registry.registerValidator() with sufficient SOL", async () => {
  console.log(
    "\n----------------== registry.registerValidator() with sufficient SOL",
  );
  signerKp = user1Kp;
  const minStake = MIN_STAKE;
  const [validatorStatePda] = deriveValidatorState(signerKp.publicKey);

  registerValidator(
    signerKp,
    minStake,
    protocolConfigPda,
    validatorStatePda,
    vaultPda,
  );
});

test("registry.registerValidator(): the same validator registering 2nd time should fail", async () => {
  console.log(
    "\n----------------== registry.registerValidator(): the same validator registering 2nd time should fail",
  );
  signerKp = user1Kp;
  const [validatorStatePda] = deriveValidatorState(signerKp.publicKey);
  const minStake = MIN_STAKE + BigInt(100);

  expectedErr = "custom program error: 0x0";
  registerValidator(
    signerKp,
    minStake,
    protocolConfigPda,
    validatorStatePda,
    vaultPda,
    expectedErr,
  );
});
