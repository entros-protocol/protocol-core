import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BorshInstructionCoder, BN } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TransactionMetadata } from "litesvm";
import {
  svm,
  adminKp,
  deterministicKeypair,
  initializeProtocol,
  LITESVM_VALIDATOR,
  setProjectionVersions,
  setTime,
} from "./litesvm-utils.ts";
import {
  anchorAddr,
  verifierAddr,
  registryAddr,
  protocolConfigPda,
  treasuryPda,
  mintAuthorityPda,
} from "./encodeDecode.ts";
const generatorPath = process.env.ENTROS_BOUND_PROOF_GENERATOR;
assert.ok(
  generatorPath,
  "ENTROS_BOUND_PROOF_GENERATOR must name an explicit local proof generator module",
);
const { generateValidInput, createProof } = await import(
  pathToFileURL(resolve(generatorPath)).href
);
assert.equal(typeof generateValidInput, "function");
assert.equal(typeof createProof, "function");

const dir = process.env.ENTROS_BOUND_PROGRAM_DIR;
const artifacts = process.env.ENTROS_BOUND_ARTIFACT_DIR;
assert.ok(
  dir && artifacts,
  "Isolated program and artifact directories are required",
);
const idls = Object.fromEntries(
  ["entros_anchor", "entros_verifier"].map((name) => [
    name,
    JSON.parse(readFileSync(join(dir, name + ".json"), "utf8")),
  ]),
);
const coders = Object.fromEntries(
  Object.entries(idls).map(([name, idl]) => [
    name,
    new BorshInstructionCoder(idl),
  ]),
);
for (const [name, id] of [
  ["entros_anchor", anchorAddr],
  ["entros_verifier", verifierAddr],
  ["entros_registry", registryAddr],
])
  svm.addProgramFromFile(id, join(dir, "programs", name + ".so"));
setTime(1_800_000_000n);
initializeProtocol(adminKp, protocolConfigPda, 1n, 300n, 1000, 10, 0n);

const reports = [];
const hex = (key) => key.toBuffer().toString("hex");
const field = (value) => BigInt(value).toString(16).padStart(64, "0");
const pda = (seed, wallet, program = anchorAddr, extra = []) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), wallet.toBuffer(), ...extra],
    program,
  )[0];
const addresses = (wallet) => ({
  authority: wallet,
  user: wallet,
  verifier: wallet,
  challenger: wallet,
  identity_state: pda("identity", wallet),
  mint: pda("mint", wallet),
  mint_authority: mintAuthorityPda,
  token_account: getAssociatedTokenAddressSync(
    pda("mint", wallet),
    wallet,
    false,
    TOKEN_2022_PROGRAM_ID,
  ),
  associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
  token_program: TOKEN_2022_PROGRAM_ID,
  system_program: SystemProgram.programId,
  protocol_config: protocolConfigPda,
  treasury: treasuryPda,
  instructions_sysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  proof_request_state: pda("proof_request_state", wallet),
  encrypted_baseline: pda("encrypted_baseline", wallet),
});
const meta = (pubkey, isWritable = true) => ({
  pubkey,
  isSigner: false,
  isWritable,
});
function ix(program, name, args, map, remaining = []) {
  const definition = idls[program].instructions.find(
    (item) => item.name === name,
  );
  assert.ok(definition, name);
  return new TransactionInstruction({
    programId: new PublicKey(idls[program].address),
    data: coders[program].encode(name, args),
    keys: [
      ...definition.accounts.map((account) => {
        const key =
          map[account.name] ??
          (account.address ? new PublicKey(account.address) : undefined);
        assert.ok(key, account.name);
        return {
          pubkey: key,
          isSigner: account.signer ?? false,
          isWritable: account.writable ?? false,
        };
      }),
      ...remaining,
    ],
  });
}
function send(label, instructions, signers, expected) {
  svm.expireBlockhash();
  const tx = new Transaction({
    feePayer: signers[0].publicKey,
    recentBlockhash: svm.latestBlockhash(),
  }).add(...instructions);
  tx.sign(...signers);
  const result = svm.sendTransaction(tx);
  const logs =
    result instanceof TransactionMetadata
      ? result.logs()
      : result.meta().logs();
  if (expected) {
    assert.ok(!(result instanceof TransactionMetadata), label + " must fail");
    assert.ok(
      logs.some((line) => line.includes(expected)),
      label + " expected " + expected + "\n" + logs.join("\n"),
    );
  } else
    assert.ok(
      result instanceof TransactionMetadata,
      label + "\n" + logs.join("\n"),
    );
  const entry = {
    label,
    accepted: result instanceof TransactionMetadata,
    bytes: tx.serialize().length,
    computeUnits: Number(
      result instanceof TransactionMetadata
        ? result.computeUnitsConsumed()
        : result.meta().computeUnitsConsumed(),
    ),
  };
  reports.push(entry);
  console.log(JSON.stringify(entry));
  return result;
}
function counter(wallet) {
  return Buffer.from(
    svm.getAccount(pda("proof_request_state", wallet)).data,
  ).readBigUInt64LE(41);
}
function receipt(wallet, commitment, purpose, projection = 1) {
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(svm.getClock().unixTimestamp);
  const version = Buffer.alloc(2);
  version.writeUInt16LE(projection);
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: LITESVM_VALIDATOR.secretKey,
    message: Buffer.concat([
      Buffer.from("entros-validator-receipt-v2\0"),
      Buffer.from([purpose]),
      version,
      wallet.toBuffer(),
      commitment,
      ts,
    ]),
  });
}
const input = await generateValidInput(10, 30, 3, "bound-protocol");
const previous = Buffer.from(field(input.commitment_prev), "hex"),
  next = Buffer.from(field(input.commitment_new), "hex");
const legacyWallet = deterministicKeypair(90);
svm.airdrop(legacyWallet.publicKey, 10_000_000_000n);
const legacyMap = addresses(legacyWallet.publicKey);
const legacyTs = Buffer.alloc(8);
legacyTs.writeBigInt64LE(svm.getClock().unixTimestamp);
const legacyReceipt = Ed25519Program.createInstructionWithPrivateKey({
  privateKey: LITESVM_VALIDATOR.secretKey,
  message: Buffer.concat([
    legacyWallet.publicKey.toBuffer(),
    previous,
    legacyTs,
  ]),
});
send(
  "projection zero identity creation advances counter",
  [
    legacyReceipt,
    ix(
      "entros_anchor",
      "mint_anchor",
      { initial_commitment: previous },
      legacyMap,
      [meta(legacyMap.proof_request_state)],
    ),
  ],
  [legacyWallet],
);
setProjectionVersions(adminKp, 1, 0, protocolConfigPda);
const wallet = deterministicKeypair(87);
svm.airdrop(wallet.publicKey, 10_000_000_000n);
const map = addresses(wallet.publicKey);
send(
  "mint advances durable counter",
  [
    receipt(wallet.publicKey, previous, 1),
    ix("entros_anchor", "mint_anchor", { initial_commitment: previous }, map, [
      meta(map.proof_request_state),
    ]),
  ],
  [wallet],
);
assert.equal(counter(wallet.publicKey), 1n);
const nonce = Buffer.alloc(32, 91),
  now = svm.getClock().unixTimestamp;
const context = {
  schema: "request-bound-v1",
  fields: {
    deployment: "11".repeat(32),
    verifier: hex(verifierAddr),
    consumer: hex(anchorAddr),
    wallet: hex(wallet.publicKey),
    nonce: nonce.toString("hex"),
    identity: hex(map.identity_state),
    mint: hex(map.mint),
  },
  counter: "1",
  projection: 1,
  commitmentNew: next.toString("hex"),
  commitmentPrevious: previous.toString("hex"),
  threshold: 30,
  minDistance: 3,
  validUntil: String(now + 120n),
};
const proof = await createProof(artifacts, context, input);
const boundMap = {
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
  valid_until: new BN(context.validUntil),
};
const create = ix("entros_verifier", "create_challenge", { nonce }, boundMap);
const verify = ix("entros_verifier", "verify_proof_bound", args, boundMap);
const update = ix(
  "entros_anchor",
  "update_anchor_bound",
  { verification_nonce: nonce },
  boundMap,
);
send(
  "wrong expiry fails",
  [
    create,
    ix(
      "entros_verifier",
      "verify_proof_bound",
      { ...args, valid_until: new BN(context.validUntil).addn(1) },
      boundMap,
    ),
  ],
  [wallet],
  "ProofVerificationFailed",
);
assert.equal(counter(wallet.publicKey), 1n);
const nonce2 = Buffer.alloc(32, 92);
const map2 = {
  ...map,
  challenge: pda("challenge", wallet.publicKey, verifierAddr, [nonce2]),
  verification_result: pda(
    "verification_bound",
    wallet.publicKey,
    verifierAddr,
    [nonce2],
  ),
};
send(
  "nonce substitution fails",
  [
    ix("entros_verifier", "create_challenge", { nonce: nonce2 }, map2),
    ix(
      "entros_verifier",
      "verify_proof_bound",
      { ...args, nonce: nonce2 },
      map2,
    ),
  ],
  [wallet],
  "ProofVerificationFailed",
);
const proof2 = await createProof(
  artifacts,
  { ...context, fields: { ...context.fields, nonce: nonce2.toString("hex") } },
  input,
);
send(
  "concurrent counter result created",
  [
    ix("entros_verifier", "create_challenge", { nonce: nonce2 }, map2),
    ix(
      "entros_verifier",
      "verify_proof_bound",
      { ...args, nonce: nonce2, proof_bytes: Buffer.from(proof2.proof_bytes) },
      map2,
    ),
  ],
  [wallet],
);
const other = deterministicKeypair(88);
svm.airdrop(other.publicKey, 10_000_000_000n);
const otherMap = addresses(other.publicKey);
send(
  "second wallet mint",
  [
    receipt(other.publicKey, previous, 1),
    ix(
      "entros_anchor",
      "mint_anchor",
      { initial_commitment: previous },
      otherMap,
      [meta(otherMap.proof_request_state)],
    ),
  ],
  [other],
);
const otherBound = {
  ...otherMap,
  challenge: pda("challenge", other.publicKey, verifierAddr, [nonce]),
  verification_result: pda(
    "verification_bound",
    other.publicKey,
    verifierAddr,
    [nonce],
  ),
};
send(
  "wallet substitution fails",
  [
    ix("entros_verifier", "create_challenge", { nonce }, otherBound),
    ix("entros_verifier", "verify_proof_bound", args, otherBound),
  ],
  [other],
  "ProofVerificationFailed",
);
send(
  "complete request bound update",
  [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ix("entros_anchor", "prepare_proof_request", {}, map),
    create,
    verify,
    update,
    ix(
      "entros_anchor",
      "set_encrypted_baseline",
      { blob: Buffer.alloc(96, 9) },
      map,
    ),
  ],
  [wallet],
);
assert.equal(counter(wallet.publicKey), 2n);
send(
  "result consumption repeats fail",
  [update],
  [wallet],
  "InvalidRequestContext",
);
send(
  "concurrent result loses consumption race",
  [
    ix(
      "entros_anchor",
      "update_anchor_bound",
      { verification_nonce: nonce2 },
      map2,
    ),
  ],
  [wallet],
  "InvalidRequestContext",
);
send(
  "reset advances counter",
  [
    receipt(wallet.publicKey, previous, 3),
    ix(
      "entros_anchor",
      "reset_identity_state",
      { new_commitment: previous, projection_version: 1 },
      map,
      [meta(SYSVAR_INSTRUCTIONS_PUBKEY, false), meta(map.proof_request_state)],
    ),
  ],
  [wallet],
);
assert.equal(counter(wallet.publicKey), 3n);
send(
  "old result fails after commitment restoration",
  [update],
  [wallet],
  "InvalidRequestContext",
);
send(
  "close used proof accounts",
  [
    ix(
      "entros_verifier",
      "close_bound_verification_result",
      { _nonce: nonce },
      boundMap,
    ),
    ix("entros_verifier", "close_challenge", {}, boundMap),
  ],
  [wallet],
);
send(
  "recreated nonce cannot replay old proof",
  [create, verify],
  [wallet],
  "ProofVerificationFailed",
);
send(
  "legacy update fails after activation",
  [
    ix(
      "entros_anchor",
      "update_anchor_compact",
      { verification_nonce: nonce },
      {
        ...boundMap,
        verification_result: pda(
          "verification",
          wallet.publicKey,
          verifierAddr,
          [nonce],
        ),
      },
    ),
  ],
  [wallet],
  "UnsupportedProofGeneration",
);
const destination = deterministicKeypair(89);
svm.airdrop(destination.publicKey, 10_000_000_000n);
const destMap = addresses(destination.publicKey);
send(
  "prefund destination counter",
  [
    SystemProgram.transfer({
      fromPubkey: destination.publicKey,
      toPubkey: destMap.proof_request_state,
      lamports: 1_000_000,
    }),
  ],
  [destination],
);
function authorize(from, to) {
  const source = addresses(from.publicKey);
  send(
    "authorize migration",
    [
      ix(
        "entros_anchor",
        "authorize_new_wallet",
        {},
        { ...source, signer: from.publicKey, signer_new: to.publicKey },
      ),
    ],
    [from, to],
  );
}
function migrate(from, to, label) {
  const source = addresses(from.publicKey),
    target = addresses(to.publicKey);
  send(
    label,
    [
      ix(
        "entros_anchor",
        "migrate_identity",
        {},
        {
          ...target,
          wallet_old: from.publicKey,
          identity_state_old: source.identity_state,
          mint_old: source.mint,
          token_account_old: source.token_account,
        },
        [meta(source.proof_request_state), meta(target.proof_request_state)],
      ),
    ],
    [to],
  );
}
authorize(wallet, destination);
migrate(wallet, destination, "delegated migration advances both counters");
assert.equal(counter(wallet.publicKey), 4n);
assert.equal(counter(destination.publicKey), 1n);
assert.equal(svm.getAccount(map.identity_state), null);
authorize(destination, wallet);
migrate(destination, wallet, "migration back retains both counters");
assert.equal(counter(wallet.publicKey), 5n);
assert.equal(counter(destination.publicKey), 2n);
send(
  "rebaseline advances counter",
  [
    receipt(legacyWallet.publicKey, next, 2),
    ix(
      "entros_anchor",
      "rebaseline_anchor",
      { new_commitment: next, projection_version: 1 },
      legacyMap,
      [meta(legacyMap.proof_request_state)],
    ),
  ],
  [legacyWallet],
);
assert.equal(counter(legacyWallet.publicKey), 2n);
send(
  "rebaseline without counter fails",
  [
    receipt(legacyWallet.publicKey, next, 2),
    ix(
      "entros_anchor",
      "rebaseline_anchor",
      { new_commitment: next, projection_version: 1 },
      legacyMap,
    ),
  ],
  [legacyWallet],
  "InvalidRequestContext",
);
assert.equal(counter(legacyWallet.publicKey), 2n);
const prepareWallet = deterministicKeypair(91);
svm.airdrop(prepareWallet.publicKey, 10_000_000_000n);
const prepareMap = addresses(prepareWallet.publicKey);
send(
  "prefund preparation state",
  [
    SystemProgram.transfer({
      fromPubkey: prepareWallet.publicKey,
      toPubkey: prepareMap.proof_request_state,
      lamports: 1_000_000,
    }),
  ],
  [prepareWallet],
);
send(
  "prepare prefunded state",
  [ix("entros_anchor", "prepare_proof_request", {}, prepareMap)],
  [prepareWallet],
);
assert.equal(counter(prepareWallet.publicKey), 0n);
send(
  "preparation preserves counter",
  [ix("entros_anchor", "prepare_proof_request", {}, prepareMap)],
  [prepareWallet],
);
assert.equal(counter(prepareWallet.publicKey), 0n);
const invalidState = svm.getAccount(prepareMap.proof_request_state);
invalidState.data = Buffer.from(invalidState.data);
invalidState.data[8] = 2;
svm.setAccount(prepareMap.proof_request_state, invalidState);
send(
  "unknown state version rejects",
  [ix("entros_anchor", "prepare_proof_request", {}, prepareMap)],
  [prepareWallet],
  "InvalidRequestContext",
);
const overflowState = svm.getAccount(otherMap.proof_request_state);
overflowState.data = Buffer.from(overflowState.data);
overflowState.data.writeBigUInt64LE(2n ** 64n - 1n, 41);
svm.setAccount(otherMap.proof_request_state, overflowState);
send(
  "counter overflow rejects reset",
  [
    receipt(other.publicKey, next, 3),
    ix(
      "entros_anchor",
      "reset_identity_state",
      { new_commitment: next, projection_version: 1 },
      otherMap,
      [
        meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
        meta(otherMap.proof_request_state),
      ],
    ),
  ],
  [other],
  "ArithmeticOverflow",
);
assert.equal(counter(other.publicKey), 2n ** 64n - 1n);
svm.addProgramFromFile(
  anchorAddr,
  join(dir, "default-programs", "entros_anchor.so"),
);
const preactivation = deterministicKeypair(92);
svm.airdrop(preactivation.publicKey, 10_000_000_000n);
const beforeMap = addresses(preactivation.publicKey);
send(
  "default mint preserves legacy account ABI",
  [
    receipt(preactivation.publicKey, previous, 1),
    ix(
      "entros_anchor",
      "mint_anchor",
      { initial_commitment: previous },
      beforeMap,
    ),
  ],
  [preactivation],
);
assert.equal(svm.getAccount(beforeMap.proof_request_state), null);
svm.addProgramFromFile(anchorAddr, join(dir, "programs", "entros_anchor.so"));
const newDestination = deterministicKeypair(93);
svm.airdrop(newDestination.publicKey, 10_000_000_000n);
authorize(preactivation, newDestination);
migrate(
  preactivation,
  newDestination,
  "delegated migration initializes absent source state",
);
assert.equal(counter(preactivation.publicKey), 1n);
assert.equal(counter(newDestination.publicKey), 1n);
for (const [index, length] of [543, 551, 583].entries()) {
  const oldWallet = deterministicKeypair(94 + index);
  svm.airdrop(oldWallet.publicKey, 10_000_000_000n);
  const oldMap = addresses(oldWallet.publicKey);
  send(
    `create layout fixture ${length}`,
    [
      receipt(oldWallet.publicKey, previous, 1),
      ix(
        "entros_anchor",
        "mint_anchor",
        { initial_commitment: previous },
        oldMap,
        [meta(oldMap.proof_request_state)],
      ),
    ],
    [oldWallet],
  );
  const original = svm.getAccount(oldMap.identity_state);
  const prefix = Buffer.from(original.data).subarray(0, length);
  svm.setAccount(oldMap.identity_state, { ...original, data: prefix });
  const oldNonce = Buffer.alloc(32, 94 + index);
  const oldBound = {
    ...oldMap,
    challenge: pda("challenge", oldWallet.publicKey, verifierAddr, [oldNonce]),
    verification_result: pda(
      "verification_bound",
      oldWallet.publicKey,
      verifierAddr,
      [oldNonce],
    ),
  };
  send(
    `old layout ${length} fails proof read`,
    [
      ix("entros_verifier", "create_challenge", { nonce: oldNonce }, oldBound),
      ix(
        "entros_verifier",
        "verify_proof_bound",
        { ...args, nonce: oldNonce },
        oldBound,
      ),
    ],
    [oldWallet],
    "InvalidRequestContext",
  );
  send(
    `upgrade layout ${length}`,
    [ix("entros_anchor", "upgrade_identity_layout", {}, oldMap)],
    [oldWallet],
  );
  const upgraded = Buffer.from(svm.getAccount(oldMap.identity_state).data);
  assert.equal(upgraded.length, 593);
  assert.deepEqual(upgraded.subarray(0, length), prefix);
  assert.ok(upgraded.subarray(length).every((byte) => byte === 0));
  assert.equal(counter(oldWallet.publicKey), 1n);
  send(
    `upgrade layout ${length} is idempotent`,
    [ix("entros_anchor", "upgrade_identity_layout", {}, oldMap)],
    [oldWallet],
  );
}
for (const length of [207, 592]) {
  const original = svm.getAccount(map.identity_state);
  svm.setAccount(map.identity_state, {
    ...original,
    data: Buffer.from(original.data).subarray(0, length),
  });
  send(
    `unknown layout ${length} rejects upgrade`,
    [ix("entros_anchor", "upgrade_identity_layout", {}, map)],
    [wallet],
    "InvalidIdentityState",
  );
  svm.setAccount(map.identity_state, original);
}
const { runAdversarialChecks } =
  await import("./request-bound-adversarial.mjs");
const adversarial = await runAdversarialChecks({
  svm,
  dir,
  artifacts,
  idls,
  addresses,
  ix,
  meta,
  send,
  counter,
  receipt,
  pda,
  generateValidInput,
  createProof,
  input,
  previous,
  next,
});
writeFileSync(
  join(dir, "request-bound-report.json"),
  JSON.stringify(
    { syntheticOnly: true, context, proof, results: reports, adversarial },
    null,
    2,
  ),
);
process.exit(0);
