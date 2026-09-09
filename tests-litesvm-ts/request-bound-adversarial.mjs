import assert from "node:assert/strict";
import { join } from "node:path";
import { BN } from "@anchor-lang/core";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { deterministicKeypair } from "./litesvm-utils.ts";
import {
  anchorAddr,
  verifierAddr,
  protocolConfigPda,
  treasuryPda,
} from "./encodeDecode.ts";

export async function runAdversarialChecks({
  deploymentDomain,
  svm,
  dir,
  artifacts,
  addresses,
  ix,
  meta,
  send,
  counter,
  receipt,
  pda,
  createProof,
  input,
  previous,
  next,
}) {
  const wallet = deterministicKeypair(180);
  const map = addresses(wallet.publicKey);
  const attestation = deterministicKeypair(210).publicKey;
  const sasProgram = new PublicKey(
    "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
  );
  const credential = new PublicKey(
    "AMBtabCgRFwGLjoZ21Z2LhSKJ6c47NckxUkMogJ3Lpuw",
  );
  const attestationData = Buffer.alloc(204);
  credential.toBuffer().copy(attestationData, 33);
  svm.setAccount(attestation, {
    data: attestationData,
    owner: sasProgram,
    lamports: 3_000_000,
    executable: false,
    rentEpoch: 0,
  });
  svm.airdrop(wallet.publicKey, 10_000_000_000n);
  const hex = (key) => key.toBuffer().toString("hex");
  const clone = (account) =>
    account && { ...account, data: Buffer.from(account.data) };
  const tracked = [
    map.identity_state,
    map.mint,
    map.token_account,
    map.encrypted_baseline,
    map.proof_request_state,
    protocolConfigPda,
    treasuryPda,
    attestation,
  ];
  function aggregate(identityKeys) {
    const identities = identityKeys
      .map((key) => svm.getAccount(key))
      .filter(Boolean);
    let totalTrust = 0,
      highestTrustScore = 0,
      totalVerifications = 0,
      mostRecentTimestamp = 0;
    for (const account of identities) {
      const data = Buffer.from(account.data).subarray(48, 62);
      const trust = data.readUInt16LE(12);
      totalTrust += trust;
      highestTrustScore = Math.max(highestTrustScore, trust);
      totalVerifications += data.readUInt32LE(8) + 1;
      mostRecentTimestamp = Math.max(
        mostRecentTimestamp,
        Number(data.readBigInt64LE(0)),
      );
    }
    const sas = svm.getAccount(attestation);
    const matchesCredential =
      sas &&
      new PublicKey(sas.owner).equals(sasProgram) &&
      Buffer.from(sas.data).subarray(33, 65).equals(credential.toBuffer());
    return {
      totalAnchors: identities.length,
      averageTrustScore: identities.length
        ? Math.round(totalTrust / identities.length)
        : 0,
      highestTrustScore,
      totalVerifications,
      mostRecentTimestamp: mostRecentTimestamp || null,
      attestationCount: matchesCredential ? 1 : 0,
    };
  }
  function snapshot(keys = tracked) {
    return keys.map((key) => [key.toBase58(), clone(svm.getAccount(key))]);
  }
  function unchanged(before) {
    for (const [address, account] of before)
      assert.deepEqual(
        clone(svm.getAccount(new PublicKey(address))),
        account,
        address,
      );
  }
  function fail(label, instructions, expected, signers = [wallet]) {
    const before = snapshot();
    send(label, instructions, signers, expected);
    unchanged(before);
  }
  svm.addProgramFromFile(
    anchorAddr,
    join(dir, "default-programs/entros_anchor.so"),
  );
  svm.addProgramFromFile(
    verifierAddr,
    join(dir, "default-programs/entros_verifier.so"),
  );
  send(
    "preservation fixture legacy mint",
    [
      receipt(wallet.publicKey, previous, 1),
      ix("entros_anchor", "mint_anchor", { initial_commitment: previous }, map),
    ],
    [wallet],
  );
  send(
    "preservation fixture encrypted baseline",
    [
      ix(
        "entros_anchor",
        "set_encrypted_baseline",
        { blob: Buffer.alloc(96, 29) },
        map,
      ),
    ],
    [wallet],
  );
  const history = clone(svm.getAccount(map.identity_state));
  history.data.writeUInt32LE(42, 56);
  history.data.writeUInt16LE(355, 60);
  history.data.writeBigInt64LE(svm.getClock().unixTimestamp - 86400n, 127);
  history.data.writeBigInt64LE(svm.getClock().unixTimestamp - 864000n, 543);
  history.data.writeBigInt64LE(svm.getClock().unixTimestamp - 604800n, 585);
  svm.setAccount(map.identity_state, history);
  const original = snapshot();
  const beforeActivationStats = aggregate([map.identity_state]);
  assert.equal(beforeActivationStats.totalVerifications, 43);
  assert.equal(beforeActivationStats.averageTrustScore, 355);
  svm.addProgramFromFile(anchorAddr, join(dir, "programs/entros_anchor.so"));
  unchanged(original);
  fail(
    "anchor-first partial upgrade rejects legacy state update",
    [
      ix(
        "entros_anchor",
        "update_anchor_compact",
        { verification_nonce: Buffer.alloc(32, 180) },
        {
          ...map,
          verification_result: pda(
            "verification",
            wallet.publicKey,
            verifierAddr,
            [Buffer.alloc(32, 180)],
          ),
        },
      ),
    ],
    "UnsupportedProofGeneration",
  );
  svm.addProgramFromFile(
    verifierAddr,
    join(dir, "programs/entros_verifier.so"),
  );
  unchanged(original);
  send(
    "same-ID activation preserves existing identity layout",
    [ix("entros_anchor", "upgrade_identity_layout", {}, map)],
    [wallet],
  );
  unchanged(original);
  send(
    "existing identity prepares a separate counter",
    [ix("entros_anchor", "prepare_proof_request", {}, map)],
    [wallet],
  );
  unchanged(
    original.filter(
      ([address]) => address !== map.proof_request_state.toBase58(),
    ),
  );
  assert.equal(counter(wallet.publicKey), 0n);
  const afterActivationStats = aggregate([map.identity_state]);
  assert.deepEqual(afterActivationStats, beforeActivationStats);

  const validUntil = svm.getClock().unixTimestamp + 120n;
  async function request(seed, requestCounter = counter(wallet.publicKey)) {
    const nonce = Buffer.alloc(32, seed);
    const context = {
      schema: "request-bound-v1",
      fields: {
        deployment: deploymentDomain,
        verifier: hex(verifierAddr),
        consumer: hex(anchorAddr),
        wallet: hex(wallet.publicKey),
        nonce: hex(new PublicKey(nonce)),
        identity: hex(map.identity_state),
        mint: hex(map.mint),
      },
      counter: String(requestCounter),
      projection: 1,
      commitmentNew: next.toString("hex"),
      commitmentPrevious: previous.toString("hex"),
      threshold: 30,
      minDistance: 3,
      validUntil: String(validUntil),
    };
    const proof = await createProof(artifacts, context, input);
    const accounts = {
      ...map,
      challenge: pda("challenge", wallet.publicKey, verifierAddr, [nonce]),
      verification_result: pda(
        "verification_bound",
        wallet.publicKey,
        verifierAddr,
        [nonce],
      ),
    };
    const args = {
      nonce,
      proof_bytes: Buffer.from(proof.proof_bytes),
      commitment_new: next,
      commitment_prev: previous,
      threshold: 30,
      min_distance: 3,
      valid_until: new BN(String(validUntil)),
    };
    return {
      accounts,
      args,
      create: ix("entros_verifier", "create_challenge", { nonce }, accounts),
      verify: ix("entros_verifier", "verify_proof_bound", args, accounts),
      update: ix(
        "entros_anchor",
        "update_anchor_bound",
        { verification_nonce: nonce },
        accounts,
      ),
    };
  }
  const candidates = [];
  for (let index = 0; index < 8; index++) {
    const candidate = await request(180 + index);
    if (index === 0) {
      svm.addProgramFromFile(
        verifierAddr,
        join(dir, "default-programs/entros_verifier.so"),
      );
      fail(
        "anchor-first partial upgrade rejects new proof until verifier activates",
        [candidate.create, candidate.verify],
        "UnsupportedProofGeneration",
      );
      assert.equal(svm.getAccount(candidate.accounts.challenge), null);
      assert.equal(
        svm.getAccount(candidate.accounts.verification_result),
        null,
      );
      svm.addProgramFromFile(
        verifierAddr,
        join(dir, "programs/entros_verifier.so"),
      );
    }
    send(
      `competing request ${index} verifies the same counter`,
      [candidate.create, candidate.verify],
      [wallet],
    );
    candidates.push(candidate);
  }
  const first = candidates[0];
  const resultOriginal = clone(
    svm.getAccount(first.accounts.verification_result),
  );
  const resultVariants = [
    [
      "foreign result owner",
      (a) => {
        a.owner = SystemProgram.programId;
      },
      "VerificationResultWrongOwner",
    ],
    [
      "truncated result",
      (a) => {
        a.data = a.data.subarray(0, 197);
      },
      "InvalidRequestContext",
    ],
    [
      "extended result",
      (a) => {
        a.data = Buffer.concat([a.data, Buffer.from([0])]);
      },
      "InvalidRequestContext",
    ],
    [
      "wrong result discriminator",
      (a) => {
        a.data[0] ^= 1;
      },
      "InvalidRequestContext",
    ],
    [
      "unknown result generation",
      (a) => {
        a.data[8] = 2;
      },
      "InvalidRequestContext",
    ],
    [
      "different result wallet",
      (a) => {
        a.data[9] ^= 1;
      },
      "InvalidRequestContext",
    ],
    [
      "different result nonce",
      (a) => {
        a.data[41] ^= 1;
      },
      "InvalidRequestContext",
    ],
    [
      "different result digest",
      (a) => {
        a.data[165] ^= 1;
      },
      "InvalidRequestContext",
    ],
  ];
  for (const [label, mutate, reason] of resultVariants) {
    const malformed = clone(resultOriginal);
    mutate(malformed);
    svm.setAccount(first.accounts.verification_result, malformed);
    fail(`reject ${label} without changing accounts`, [first.update], reason);
    assert.deepEqual(
      clone(svm.getAccount(first.accounts.verification_result)),
      malformed,
    );
    svm.setAccount(first.accounts.verification_result, resultOriginal);
  }
  const identityOriginal = clone(svm.getAccount(map.identity_state));
  const overflowIdentity = clone(identityOriginal);
  overflowIdentity.data.writeUInt32LE(0xffffffff, 56);
  svm.setAccount(map.identity_state, overflowIdentity);
  fail(
    "late identity overflow rolls back advanced request counter",
    [first.update],
    "ArithmeticOverflow",
  );
  svm.setAccount(map.identity_state, identityOriginal);
  const order = [5, 2, 7, 0, 6, 1, 4, 3];
  send(
    "one competing request consumes the shared counter",
    [candidates[order[0]].update],
    [wallet],
  );
  assert.equal(counter(wallet.publicKey), 1n);
  assert.equal(
    Buffer.from(svm.getAccount(map.identity_state).data).readUInt32LE(56),
    43,
  );
  for (let round = 0; round < 4; round++) {
    for (const index of order)
      fail(
        `contention replay round ${round} request ${index}`,
        [candidates[index].update],
        "InvalidRequestContext",
      );
  }
  const reset = ix(
    "entros_anchor",
    "reset_identity_state",
    { new_commitment: previous, projection_version: 1 },
    map,
    [meta(SYSVAR_INSTRUCTIONS_PUBKEY, false), meta(map.proof_request_state)],
  );
  fail(
    "late invalid receipt rolls back lifecycle counter",
    [receipt(wallet.publicKey, next, 3), reset],
    "ReceiptCommitmentMismatch",
  );

  const counterOriginal = clone(svm.getAccount(map.proof_request_state));
  for (const [label, mutate] of [
    [
      "unknown counter generation",
      (a) => {
        a.data[8] = 2;
      },
    ],
    [
      "foreign counter wallet",
      (a) => {
        a.data[9] ^= 1;
      },
    ],
    [
      "wrong counter bump",
      (a) => {
        a.data[49] ^= 1;
      },
    ],
  ]) {
    const malformed = clone(counterOriginal);
    mutate(malformed);
    svm.setAccount(map.proof_request_state, malformed);
    fail(
      `reject ${label}`,
      [ix("entros_anchor", "prepare_proof_request", {}, map)],
      "InvalidRequestContext",
    );
    svm.setAccount(map.proof_request_state, counterOriginal);
  }
  const destination = deterministicKeypair(190);
  svm.airdrop(destination.publicKey, 10_000_000_000n);
  const destMap = addresses(destination.publicKey);
  fail(
    "foreign signer cannot use another identity",
    [
      ix(
        "entros_anchor",
        "upgrade_identity_layout",
        {},
        { ...map, authority: destination.publicKey },
      ),
    ],
    "ConstraintSeeds",
    [destination],
  );
  send(
    "prepare migration destination counter",
    [ix("entros_anchor", "prepare_proof_request", {}, destMap)],
    [destination],
  );
  const migrate = ix(
    "entros_anchor",
    "migrate_identity",
    {},
    {
      ...destMap,
      wallet_old: wallet.publicKey,
      identity_state_old: map.identity_state,
      mint_old: map.mint,
      token_account_old: map.token_account,
    },
    [meta(map.proof_request_state), meta(destMap.proof_request_state)],
  );
  fail(
    "migration without delegated authority fails",
    [migrate],
    "UnauthorizedNewWallet",
    [destination],
  );
  send(
    "authorize account preservation migration",
    [
      ix(
        "entros_anchor",
        "authorize_new_wallet",
        {},
        { ...map, signer: wallet.publicKey, signer_new: destination.publicKey },
      ),
    ],
    [wallet, destination],
  );
  const destinationCounter = clone(svm.getAccount(destMap.proof_request_state));
  const destinationOverflow = clone(destinationCounter);
  destinationOverflow.data.writeBigUInt64LE(2n ** 64n - 1n, 41);
  svm.setAccount(destMap.proof_request_state, destinationOverflow);
  const failedMigrationBefore = snapshot([
    ...tracked,
    destMap.identity_state,
    destMap.mint,
    destMap.token_account,
    destMap.proof_request_state,
  ]);
  send(
    "migration destination overflow rolls back source counter",
    [migrate],
    [destination],
    "ArithmeticOverflow",
  );
  unchanged(failedMigrationBefore);
  svm.setAccount(destMap.proof_request_state, destinationCounter);
  const beforeMigration = Buffer.from(svm.getAccount(map.identity_state).data);
  const beforeMigrationStats = aggregate([
    map.identity_state,
    destMap.identity_state,
  ]);
  const baselineBefore = snapshot([map.encrypted_baseline]);
  send(
    "migration preserves accumulated identity history",
    [migrate],
    [destination],
  );
  const migrated = Buffer.from(svm.getAccount(destMap.identity_state).data);
  for (const [start, end] of [
    [40, 94],
    [127, 551],
    [583, 593],
  ])
    assert.deepEqual(
      migrated.subarray(start, end),
      beforeMigration.subarray(start, end),
    );
  assert.deepEqual(migrated.subarray(8, 40), destination.publicKey.toBuffer());
  assert.deepEqual(migrated.subarray(94, 126), destMap.mint.toBuffer());
  assert.equal(svm.getAccount(map.identity_state), null);
  assert.equal(svm.getAccount(map.mint), null);
  assert.equal(counter(wallet.publicKey), 2n);
  assert.equal(counter(destination.publicKey), 1n);
  unchanged(baselineBefore);
  const afterMigrationStats = aggregate([
    map.identity_state,
    destMap.identity_state,
  ]);
  assert.deepEqual(afterMigrationStats, beforeMigrationStats);
  return {
    beforeActivationStats,
    afterActivationStats,
    beforeMigrationStats,
    afterMigrationStats,
    contention: {
      preparedRequests: 8,
      successfulConsumptions: 1,
      rejectedReplayAttempts: 32,
    },
    scope:
      "Synthetic single-identity cohort. The SAS account is an opaque storage fixture, not an issued or cryptographically verified attestation.",
  };
}
