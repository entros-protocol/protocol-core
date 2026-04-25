import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  decodeIdentityPdaDev,
  deriveIdentityPda,
  deriveMintPda,
  entrosAnchorAddr,
  mintAuthorityPda,
  protocolConfigPda,
  treasuryPda,
} from "./encodeDecode.ts";
import {
  acctEqual,
  adminKp,
  ataBalCk,
  expireBlockhash,
  getJsTime,
  initializeProtocol,
  mintAnchor,
  readAcct,
  resetIdentityState,
  setTime,
  warpTime,
} from "./litesvm-utils.ts";

/* Build the Solana programs first:
$ anchor build
Then run with Bun: bun test tests-litesvm-ts/reset-tests.ts
Or with Node 22.18+/25.9+: node tests-litesvm-ts/reset-tests.ts
*/

const initialCommitment = Buffer.alloc(32);
initialCommitment.write("initial_commitment_reset", "utf-8");

const resetCommitment = Buffer.alloc(32);
resetCommitment.write("post_reset_commitment_v1", "utf-8");

const resetCommitment2 = Buffer.alloc(32);
resetCommitment2.write("post_reset_commitment_v2", "utf-8");

const zeroCommitment = Buffer.alloc(32);

const RESET_COOLDOWN_SECS = 604_800;

let signerKp: Keypair;
let signer: PublicKey;
setTime(BigInt(getJsTime()));

test("registry.initializeProtocol()", async () => {
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const min_stake = BigInt(1_000_000_000);
  const challenge_expiry = BigInt(300);
  const max_trust_score = 10000;
  const base_trust_increment = 100;
  const verification_fee = BigInt(5_000_000); // 0.005 SOL — tests fee charged on reset
  initializeProtocol(
    signerKp,
    protocolConfigPda,
    min_stake,
    challenge_expiry,
    max_trust_score,
    base_trust_increment,
    verification_fee,
  );
});

test("entrosAnchor.mintAnchor() to establish baseline", async () => {
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
    initialCommitment,
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
  const decoded = decodeIdentityPdaDev(rawAccountData);
  acctEqual(decoded.owner, signer);
  expect(decoded.verification_count).to.equal(0);
  expect(decoded.trust_score).to.equal(0);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(
    initialCommitment,
  );
  expect(decoded.last_reset_timestamp).to.equal(BigInt(0));
  ataBalCk(ata, BigInt(1), "IdentityMint", 0);
});

test("entrosAnchor.resetIdentityState() happy path on fresh mint", async () => {
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);

  // First-ever reset on a freshly minted account: last_reset_timestamp is 0,
  // so cooldown check `now - 0 >= 604800` passes trivially.
  resetIdentityState(
    signerKp,
    resetCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );

  const rawAccountData = readAcct(identityPda, entrosAnchorAddr);
  const decoded = decodeIdentityPdaDev(rawAccountData);

  // Commitment rotated
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(
    resetCommitment,
  );
  // Full-reset semantics: verification_count, trust_score, recent_timestamps cleared
  expect(decoded.verification_count).to.equal(0);
  expect(decoded.trust_score).to.equal(0);
  for (const ts of decoded.recent_timestamps) {
    expect(ts).to.equal(BigInt(0));
  }
  // last_reset_timestamp now > 0. chai's greaterThan is number-only, so compare via Number.
  expect(Number(decoded.last_reset_timestamp)).to.be.greaterThan(0);
});

test("entrosAnchor.resetIdentityState() fails while cooldown active", async () => {
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);

  // Second reset in the same clock second — cooldown has not elapsed.
  // Expire the prior blockhash so the runtime doesn't dedup this tx as
  // AlreadyProcessed against the successful reset above.
  expireBlockhash();
  resetIdentityState(
    signerKp,
    resetCommitment2,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    "ResetCooldownActive",
  );

  // Verify state did not mutate — commitment is still the first-reset value.
  const rawAccountData = readAcct(identityPda, entrosAnchorAddr);
  const decoded = decodeIdentityPdaDev(rawAccountData);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(
    resetCommitment,
  );
});

test("entrosAnchor.resetIdentityState() succeeds after cooldown elapses", async () => {
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);

  // Warp past the cooldown window (7 days + 1s safety margin).
  warpTime(RESET_COOLDOWN_SECS + 1);
  expireBlockhash();

  resetIdentityState(
    signerKp,
    resetCommitment2,
    identityPda,
    protocolConfigPda,
    treasuryPda,
  );

  const rawAccountData = readAcct(identityPda, entrosAnchorAddr);
  const decoded = decodeIdentityPdaDev(rawAccountData);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(
    resetCommitment2,
  );
  expect(decoded.verification_count).to.equal(0);
  expect(decoded.trust_score).to.equal(0);
});

test("entrosAnchor.resetIdentityState() rejects zero commitment", async () => {
  signerKp = adminKp;
  signer = signerKp.publicKey;
  const [identityPda] = deriveIdentityPda(signer);

  // Warp again to clear cooldown from the previous test.
  warpTime(RESET_COOLDOWN_SECS + 1);
  expireBlockhash();

  resetIdentityState(
    signerKp,
    zeroCommitment,
    identityPda,
    protocolConfigPda,
    treasuryPda,
    "InvalidCommitment",
  );

  // State still matches the prior successful reset.
  const rawAccountData = readAcct(identityPda, entrosAnchorAddr);
  const decoded = decodeIdentityPdaDev(rawAccountData);
  expect(Buffer.from(decoded.current_commitment)).to.deep.equal(
    resetCommitment2,
  );
});
