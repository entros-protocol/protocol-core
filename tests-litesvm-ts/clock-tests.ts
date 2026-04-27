import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from 
import {
  BASE_TDev,
  decodeProtocolConfigDb3js,
  iamAnchorAddr,
  loadProofFixtuityPda,
  protocolConfigBump,
  protocolConfigPda,
  treasuryPda,
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
  entrosAnchorAddr,
  expectTheSameArray,
  getJsTime,
  initializeProtocol,
  migrateIdentity,
  mintAnchor,
  read
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
Then Install NodeJs v25.9.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/
const commitment = Buffer.alloc(32);
commitment.write("initial_commitment_test", "utf-8");

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
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const min_stake = BigInt(1_000_000_000);
  const challenge_expiry = BigInt(300); //i64,
  const max_trust_score = 10000; //u16,
  const base_trust_increment = 100; //u16,
  const verification_fee = BigInt(0);
  acctIsNull(protocolConfigPda);
  initializeProtocol(
    signerKp,
    protocolConfigPda,
    min_stake,
    challenge_expiry,
    max_trust_score,
    base_trust_increment,
    verification_fee,
  );

  const rawAccountData = readAcct(protocolConfigPda, registryAddr);
  const decoded = decodeProtocolConfigWeb3js(rawAccountData);
  acctEqual(decoded.admin, signer);
  expect(decoded.min_stake).eq(min_stake);
  expect(decoded.challenge_expiry).eq(challenge_expiry);
  expect(decoded.max_trust_score).eq(max_trust_score);
  expect(decoded.base_trust_increment).eq(base_trust_increment);
  expect(decoded.bump).eq(protocolConfigBump);
  expect(decoded.verification_fee).eq(verification_fee);
});

test("registry.mintAnchor()", async () => {
  signerKp = adminKp;
  pdas = pdasBySignerKp(signerKp);
  const initialCommitment = Buffer.from(fixture.public_inputs[1]);

  mintAnchor(
    signerKp,
    commitment,
    identityPda,
    mintPda,
    mintAuthorityPda,
    pdas.ata,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram,
    protocolConfigPda,
    treasuryPda,
  );
  const rawAccountData = readAcct(pdas.identityPda, iamAnchorAddr);
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
  //update_anchor() at T=0 → trust score = 100
  signerKp = adminKp;
  const { identityPda, nonce, verificationPda, fixture } = verifyUser(signerKp);
  const newCommitment = Buffer.from(fixture.public_inputs[0]);

  updateAnchor(
    signerKp,
    newCommitment,
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

<<<<<<< HEAD
test("iamAnchor.authorizeNewWallet()", async () =>
{
  console.log("\n----------------== iamAnchor.authorizeNewWallet()");
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
  rawAccData = readAcct(pdas.identityPda, iamAnchorAddr);
  identity = decodeIdentityPdaDev(rawAccData);
  acctEqual(identity.owner, signerKp.publicKey);
  console.log("user1:", user1.toBase58());
  acctEqual(identity.new_wallet, newWalletKp.publicKey);
}
)

test("iamAnchor.migrateIdentity() by user1", async () => {
  console.log("\n----------------== iamAnchor.migrateIdentity() by user1");
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

  console.log(
    "identity new recent_timestamps:",
    identity.recent_timestamps,
    ", trust_score:",
    identity.trust_score,
    ", verification_count:",
    identity.verification_count,
  );
  expect(balcSol(pdasAdmin.identityPda)).eq(null);
  acctIsNull(pdasAdmin.identityPda);
  balcAtaCk(pdasAdmin.ata, zero, "Mint_Old", 0);
  acctIsNull(pdasAdmin.mintPda);
});

// TODO: A second successful updateAnchor would need another fixture proof where commitment_prev = public_inputs[0] of the first, which means regenerating fixtures
test.skip("iamAnchor.updateAnchor() 2nd & 3rd time", async () => {
  console.log("\n----------------== iamAnchor.updateAnchor() 2nd & 3rd time");
=======
test("entrosAnchor.updateAnchor() 2nd & 3rd time", async () => {
>>>>>>> upstream/develop
  //warp 1 day + create_challenge + verify_proof + update_anchor: trust score should be ~196
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);
  const newCommitment = Buffer.alloc(32);
  newCommitment.write("updated_commitment_v2!", "utf-8");

  warpTime(1 * day);

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
  expect(decoded.trust_score).greaterThan(trustscorePrev); //198
  trustscorePrev = decoded.trust_score;

  const newCommitment3 = Buffer.alloc(32);
  newCommitment3.write("updated_commitment_v3!", "utf-8");
  warpTime(1 * day);

  updateAnchor(
    signerKp,
    newCommitment3,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );
  const rawAccountData3 = readAcct(identityPda);
  const decoded3 = decodeIdentityStateWeb3js(rawAccountData3);
  expect(decoded3.verification_count).to.equal(3);
  expect(decoded3.trust_score).greaterThan(trustscorePrev); //311
});
<<<<<<< HEAD
=======

test("entrosVerifier.createChallenge()", async () => {
  signerKp = adminKp;
  signer = signerKp.publicKey;

  const nonce = generateNonce(); // array of 32 u8 in Anchor IDL
  const [challengePda] = deriveChallengePda(signer, nonce);
  const [_verificationPda] = deriveVerificationPda(signer, nonce);

  createChallenge(signerKp, nonce, challengePda);
});
/* challengeExpiry test:
const fixture = loadProofFixture();
const proofBytes = Buffer.from(fixture.proof_bytes); // Vec<u8>
const publicInputs: number[][] = fixture.public_inputs; // Vec<[u8; 32]>
*/
>>>>>>> upstream/develop
