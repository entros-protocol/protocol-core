import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  decodeIdentityPdaDev,
  decodeProtocolConfigDev,
  deriveValidatorState,
  type IdentityStateAcctWeb3js,
  loadProofFixture,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  type Pdas,
  programdataAddr,
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
  admin2Kp,
  adminKp,
  balcAtaCk,
  balcSolCk,
  baseSOL,
  closeChallenge,
  closeVerificationResult,
  createChallenge,
  expireBlockhash,
  hackerKp,
  initializeProtocol,
  migrateAdmin,
  mintAnchor,
  pdasAdmin,
  pdasBySignerKp,
  readAcct,
  registerValidator,
  sendSol,
  setProgramDataAcct,
  setValidatorPubkey,
  updateAnchor,
  updateProtocolConfig,
  user1,
  user1Kp,
  verifyProof,
  withdrawTreasury,
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
const tokenProgram = TOKEN_2022_PROGRAM_ID;
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

test("ProtocolConfig byte offsets match Borsh layout", async () => {
  console.log(
    "\n----------------== ProtocolConfig byte offsets match Borsh layout",
  );
  // entros-anchor reads ProtocolConfig fields via hardcoded byte offsets on
  // an UncheckedAccount + raw try_borrow_data. If state.rs reorders fields
  // or changes a field type, the IDL deserialization shifts but the raw
  // reads do not — this test fails fast on that drift.
  if (!rawAccData) {
    throw new Error("rawAccData not initialized — initializeProtocol must run first");
  }
  const config = decodeProtocolConfigDev(rawAccData);
  const view = new DataView(
    rawAccData.buffer,
    rawAccData.byteOffset,
    rawAccData.byteLength,
  );

  // Mirror the hardcoded offsets read by programs/entros-anchor/src/lib.rs.
  expect(view.getUint16(56, true)).eq(config.max_trust_score);
  expect(view.getUint16(58, true)).eq(config.base_trust_increment);
  expect(view.getBigUint64(61, true)).eq(config.verification_fee);
  expect(view.getBigUint64(69, true)).eq(config.migration_fee);
});

test("entrosAnchor.updateAnchor(): calling this before mint_anchor() should fail", async () => {
  console.log(
    "\n----------------== entrosAnchor.updateAnchor(): calling this before mint_anchor() should fail",
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

test("entrosAnchor.mintAnchor()", async () => {
  console.log("\n----------------== entrosAnchor.mintAnchor()");
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
  rawAccData = readAcct(pdas.identityPda, anchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  acctEqual(identity.owner, signerKp.publicKey);
  expect(identity.verification_count).to.equal(0);
  expect(identity.trust_score).to.equal(0);
  console.log("expected initialCommitment:", initialCommitment.buffer);
  expect(Buffer.from(identity.current_commitment)).to.deep.equal(
    initialCommitment,
  );
  acctEqual(identity.mint, pdas.mintPda);
  balcAtaCk(pdas.ata, BigInt(1), "IdentityMint", 0);
});

test("entrosVerifier.createChallenge()", async () => {
  console.log("\n----------------== entrosVerifier.createChallenge()");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  createChallenge(signerKp, pdas.nonce, pdas.challengePda);
});
test("entrosVerifier.verifyProof()", async () => {
  console.log("\n----------------== entrosVerifier.verifyProof()");
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

test("entrosAnchor.updateAnchor(): 1st time", async () => {
  console.log("\n----------------== entrosAnchor.updateAnchor(): 1st time");
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

test("entrosAnchor.mintAnchor(): 2nd time from the same wallet should fail", async () => {
  console.log(
    "\n----------------== entrosAnchor.mintAnchor(): 2nd time from the same wallet should fail",
  );
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);

  expectedErr = "custom program error: 0x0";
  expireBlockhash();
  mintAnchor(
    signerKp,
    commitment,
    pdas.identityPda,
    pdas.mintPda,
    mintAuthorityPda,
    pdas.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("entrosAnchor.updateAnchor(): passing 32 zero bytes as commitment should fail", async () => {
  console.log(
    "\n----------------== entrosAnchor.updateAnchor(): passing 32 zero bytes as commitment should fail",
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

test("entrosAnchor.updateAnchor(): a wallet calling this on another wallet's IdentityState should fail", async () => {
  console.log(
    "\n----------------== entrosAnchor.updateAnchor(): a wallet calling this on another wallet's IdentityState should fail",
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
test.skip("entrosAnchor.updateAnchor(): 2nd time", async () => {
  console.log("\n----------------== entrosAnchor.updateAnchor(): 2nd time");
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
test("entrosVerifier.createChallenge(): 2nd time with the same nonce should fail", async () => {
  console.log(
    "\n----------------== entrosVerifier.createChallenge(): 2nd time with the same nonce should fail",
  );
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);

  expectedErr = "custom program error: 0x0";
  expireBlockhash();
  createChallenge(signerKp, pdas.nonce, pdas.challengePda, expectedErr);
});

test("entrosVerifier.createChallenge() with another wallet's challenge should fail", async () => {
  console.log(
    "\n----------------== entrosVerifier.createChallenge() with another wallet's challenge should fail",
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

test("registry.updateProtocolConfig() with verification fee", async () => {
  console.log(
    "\n----------------== registry.updateProtocolConfig() with verification fee",
  );
  signerKp = adminKp;
  const verification_fee = BigInt(10);

  updateProtocolConfig(signerKp, verification_fee, protocolConfigPda);

  rawAccData = readAcct(protocolConfigPda, registryAddr);
  const config = decodeProtocolConfigDev(rawAccData);
  acctEqual(config.admin, signerKp.publicKey);
  expect(config.min_stake).eq(MIN_STAKE);
  expect(config.challenge_expiry).eq(CHALLENGE_EXPIRY);
  expect(config.max_trust_score).eq(MAX_TRUST_SCORE);
  expect(config.base_trust_increment).eq(BASE_TRUST_INCREMENT);
  expect(config.bump).eq(protocolConfigBump);
  expect(config.verification_fee).eq(verification_fee);
});

test("registry.setValidatorPubkey() should fail with zero pubkey", async () => {
  console.log(
    "\n----------------== registry.setValidatorPubkey() should fail with zero pubkey",
  );
  // master-list #146 Phase 3: zero pubkey would silently disable the
  // mint receipt check (entros-anchor treats it as 'not yet configured'),
  // so the registry refuses to write it. Forces operators to use a real
  // signing key for rotation.
  expectedErr =
    "Error Number: 6009. Error Message: Validator pubkey must be non-zero";
  setValidatorPubkey(adminKp, PublicKey.default, protocolConfigPda, expectedErr);
});

test("registry.setValidatorPubkey() should fail by non-admin", async () => {
  console.log(
    "\n----------------== registry.setValidatorPubkey() should fail by non-admin",
  );
  expectedErr =
    "Error Code: Unauthorized. Error Number: 6003. Error Message: Unauthorized: caller is not the expected authority.";
  // Use a fresh non-admin keypair (user1Kp) — admin constraint should reject.
  const fakeValidator = Keypair.generate().publicKey;
  setValidatorPubkey(user1Kp, fakeValidator, protocolConfigPda, expectedErr);
});

test("registry.setValidatorPubkey()", async () => {
  console.log("\n----------------== registry.setValidatorPubkey()");
  // First call: writes the validator pubkey (no realloc needed since
  // ProtocolConfig was initialized at the new 109-byte length earlier
  // in this test sequence — the realloc path is exercised in the live
  // devnet migration when an existing 77-byte account is upgraded).
  const validator = Keypair.generate().publicKey;
  setValidatorPubkey(adminKp, validator, protocolConfigPda);

  rawAccData = readAcct(protocolConfigPda, registryAddr);
  const config = decodeProtocolConfigDev(rawAccData);
  acctEqual(config.validator_pubkey, validator);

  // Rotation: set a different pubkey, confirm it overwrites.
  const validator2 = Keypair.generate().publicKey;
  setValidatorPubkey(adminKp, validator2, protocolConfigPda);
  rawAccData = readAcct(protocolConfigPda, registryAddr);
  const configRotated = decodeProtocolConfigDev(rawAccData);
  acctEqual(configRotated.validator_pubkey, validator2);
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

test("registry.withdrawTreasury()", async () => {
  console.log("\n----------------== registry.withdrawTreasury()");
  // Send SOL to treasury PDA to simulate accumulated fees; Formally, those SOL should be deposited from mintAnchor(), migrateIdentity(), updateAnchor(), or resetIdentityState()
  const depositAmount = baseSOL;
  sendSol(user1Kp, treasuryPda, depositAmount);
  balcSolCk(treasuryPda, depositAmount, "TreasuryPda");

  signerKp = adminKp;
  const amount = BigInt(50_000_000);
  withdrawTreasury(signerKp, amount, protocolConfigPda, treasuryPda);
});

test("registry.migrateAdmin() should fail by Wrong Upgrade Authority", async () => {
  console.log(
    "\n----------------== registry.migrateAdmin() should fail by Wrong Upgrade Authority",
  );
  const upgrade_authority = user1;
  setProgramDataAcct(programdataAddr, upgrade_authority, upgrade_authority);

  migrateAdmin(
    hackerKp, // a hacker tries to invoke this
    protocolConfigPda,
    programdataAddr,
    "Error Code: WrongUpgradeAuthority. Error Number: 6007. Error Message: Caller is not the program upgrade authority",
  );
});

test("registry.migrateAdmin()", async () => {
  console.log("\n----------------== registry.migrateAdmin()");
  const upgrade_authorityKp = admin2Kp;
  const upgrade_authority = upgrade_authorityKp.publicKey;

  setProgramDataAcct(programdataAddr, upgrade_authority, upgrade_authority);

  migrateAdmin(upgrade_authorityKp, protocolConfigPda, programdataAddr);
});

test("entrosVerifier.closeChallenge()", async () => {
  console.log("\n----------------== entrosVerifier.closeChallenge()");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  closeChallenge(signerKp, pdas.challengePda);
});

test("entrosVerifier.closeVerificationResult()", async () => {
  console.log("\n----------------== entrosVerifier.closeVerificationResult()");
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  closeVerificationResult(signerKp, pdas.verificationPda);
});
