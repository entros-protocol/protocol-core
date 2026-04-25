import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  decodeIdentityStateWeb3js,
  decodeProtocolConfigWeb3js,
  deriveChallengePda,
  deriveIdentityPda,
  deriveMintPda,
  deriveValidatorState,
  deriveVerificationPda,
  generateNonce,
  mintAuthorityPda,
  protocolConfigBump,
  protocolConfigPda,
  treasuryPda,
  vaultPda,
} from "./encodeDecode.ts";
import {
  acctEqual,
  acctIsNull,
  admin,
  adminKp,
  ataBalCk,
  createChallenge,
  expireBlockhash,
  entrosAnchorAddr,
  initializeProtocol,
  mintAnchor,
  readAcct,
  registerValidator,
  registryAddr,
  updateAnchor,
  updateProtocolConfig,
  user1Kp,
} from "./litesvm-utils.ts";

/*
Build the Solana programs first:
$ anchor build
Then Install NodeJs v25.9.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/

const commitment = Buffer.alloc(32);
commitment.write("initial_commitment_test", "utf-8");

let signerKp: Keypair;
let signer: PublicKey;
let expectedErr = "";
let nonce1: number[]; // [u8, 32]
let challengePda1: PublicKey;
let _verificationPda1: PublicKey;
const MIN_STAKE = BigInt(1_000_000_000);

test("registry.initializeProtocol()", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const challenge_expiry = BigInt(300); //i64,
  const max_trust_score = 10000; //u16,
  const base_trust_increment = 100; //u16,
  const verification_fee = BigInt(0);

  acctIsNull(protocolConfigPda);
  initializeProtocol(
    signerKp,
    protocolConfigPda,
    MIN_STAKE,
    challenge_expiry,
    max_trust_score,
    base_trust_increment,
    verification_fee,
  );
  const rawAccountData = readAcct(protocolConfigPda, registryAddr);
  const decoded = decodeProtocolConfigWeb3js(rawAccountData);
  acctEqual(decoded.admin, signer);
  expect(decoded.min_stake).eq(MIN_STAKE);
  expect(decoded.challenge_expiry).eq(challenge_expiry);
  expect(decoded.max_trust_score).eq(max_trust_score);
  expect(decoded.base_trust_increment).eq(base_trust_increment);
  expect(decoded.bump).eq(protocolConfigBump);
  expect(decoded.verification_fee).eq(verification_fee);
});

test("entrosAnchor.updateAnchor(): calling this before mint_anchor() should fail", async () => {
  console.log("\n----------------==");
  //update_anchor() at T=0 → trust score = 100
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);
  const newCommitment = Buffer.alloc(32);
  newCommitment.write("updated_commitment_v1!", "utf-8");

  expectedErr = "instruction modified data of an account it does not own";
  updateAnchor(
    signerKp,
    newCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("registry.mintAnchor()", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);
  const [mintPda] = deriveMintPda(signer);
  const tokenProgram = TOKEN_2022_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(
    mintPda,
    signer,
    false,
    tokenProgram,
  );

  mintAnchor(
    signerKp,
    commitment,
    identityPda,
    mintPda,
    mintAuthorityPda,
    ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
  );
  const rawAccountData = readAcct(identityPda, entrosAnchorAddr);
  const decoded = decodeIdentityStateWeb3js(rawAccountData);
  acctEqual(decoded.owner, signer);
  expect(decoded.verification_count).to.equal(0);
  expect(decoded.trust_score).to.equal(0);
  console.log("expected commitment:", commitment.buffer);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(commitment);
  acctEqual(decoded.mint, mintPda);
  ataBalCk(ata, BigInt(1), "IdentityMint", 0);
});

test("entrosAnchor.updateAnchor(): 1st time", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);
  const newCommitment = Buffer.alloc(32);
  newCommitment.write("updated_commitment_v2!", "utf-8");

  updateAnchor(
    signerKp,
    newCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  const rawAccountData = readAcct(identityPda);
  const decoded = decodeIdentityStateWeb3js(rawAccountData);
  expect(decoded.verification_count).to.equal(1);
});

test("entrosAnchor.mintAnchor(): 2nd time from the same wallet should fail", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);
  const [mintPda] = deriveMintPda(signer);
  const tokenProgram = TOKEN_2022_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(
    mintPda,
    signer,
    false,
    tokenProgram,
  );

  expectedErr = "custom program error: 0x0";
  expireBlockhash();
  mintAnchor(
    signerKp,
    commitment,
    identityPda,
    mintPda,
    mintAuthorityPda,
    ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("entrosAnchor.updateAnchor(): passing 32 zero bytes as commitment should fail", async () => {
  console.log("\n----------------==");
  //update_anchor() at T=0 → trust score = 100
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);
  const newCommitment = Buffer.alloc(32);
  console.log("newCommitment", newCommitment);

  expectedErr =
    "Error Number: 6000. Error Message: Invalid commitment: must be 32 non-zero bytes";
  updateAnchor(
    signerKp,
    newCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("entrosAnchor.updateAnchor(): a wallet calling this on another wallet's IdentityState should fail", async () => {
  console.log("\n----------------==");
  //update_anchor() at T=0 → trust score = 100
  signerKp = user1Kp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(admin);
  const newCommitment = Buffer.alloc(32);
  newCommitment.write("updated_commitment_v3!", "utf-8");

  expectedErr =
    "identity_state. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.";
  updateAnchor(
    signerKp,
    newCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    expectedErr,
  );
});

test("entrosAnchor.updateAnchor()", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);
  const newCommitment = Buffer.alloc(32);
  newCommitment.write("updated_commitment_v3!", "utf-8");

  updateAnchor(
    signerKp,
    newCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  const rawAccountData = readAcct(identityPda);
  const decoded = decodeIdentityStateWeb3js(rawAccountData);
  expect(decoded.verification_count).to.equal(2);
  //expect(decoded.trust_score).to.equal(100);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(newCommitment);
});

//----------------== iam-Verifier methods
test("entrosVerifier.createChallenge()", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;
  nonce1 = generateNonce();
  const [challengePda] = deriveChallengePda(signer, nonce1);
  const [verificationPda] = deriveVerificationPda(signer, nonce1);
  _verificationPda1 = verificationPda;
  challengePda1 = challengePda;
  console.log("challengePda:", challengePda.toBase58());
  createChallenge(signerKp, nonce1, challengePda);
});

test("entrosVerifier.createChallenge(): 2nd time with the same nonce should fail", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;

  expectedErr = "custom program error: 0x0";
  expireBlockhash();
  createChallenge(signerKp, nonce1, challengePda1, expectedErr);
});

test("entrosVerifier.createChallenge() with another wallet's challenge should fail", async () => {
  console.log("\n----------------==");
  signerKp = user1Kp;
  console.log("challengePda1:", challengePda1.toBase58());

  expectedErr =
    "AnchorError caused by account: challenge. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated";
  createChallenge(signerKp, nonce1, challengePda1, expectedErr);
});

//----------------== iam-Registry methods
test("registry.initializeProtocol(): 2nd time should fail", async () => {
  console.log("\n----------------==");
  signerKp = adminKp;
  signer = signerKp.publicKey;
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
  console.log("\n----------------==");
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

//------== registerValidator
test("registry.registerValidator() with insufficient SOL", async () => {
  console.log("\n----------------==");
  signerKp = user1Kp;
  signer = signerKp.publicKey;
  const minStake = MIN_STAKE - BigInt(100);
  const [validatorStatePda] = deriveValidatorState(signer);

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
  console.log("\n----------------==");
  signerKp = user1Kp;
  signer = signerKp.publicKey;
  const minStake = MIN_STAKE;
  const [validatorStatePda] = deriveValidatorState(signer);

  registerValidator(
    signerKp,
    minStake,
    protocolConfigPda,
    validatorStatePda,
    vaultPda,
  );
});
test("registry.registerValidator(): the same validator registering 2nd time should fail", async () => {
  console.log("\n----------------==");
  signerKp = user1Kp;
  signer = signerKp.publicKey;
  const [validatorStatePda] = deriveValidatorState(signer);
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
