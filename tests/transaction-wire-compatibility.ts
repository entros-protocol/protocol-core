import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import { BorshInstructionCoder, type Idl } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

interface ProofFixture {
  proof_bytes: number[];
  public_inputs: number[][];
}

const ENTROS_ANCHOR_PROGRAM_ID = new PublicKey(
  "GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2",
);
const ENTROS_VERIFIER_PROGRAM_ID = new PublicKey(
  "4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV",
);

const LEGACY_FIXTURES = {
  createChallenge: {
    length: 40,
    sha256: "b4e1fae5a105cedc9523a62d1c9b5f9f6116bfdbf2b6aa2e55448fe5936358f1",
  },
  verifyProof: {
    length: 432,
    sha256: "3ac0e703f0a8f3bb5ad3f7a739ae8c70989226a05b687c0b760b0ab0fbe7ba07",
  },
  updateAnchor: {
    length: 72,
    sha256: "38b5c9dad88efb3eb872a72170b937c1cfe18f63d31e8723638355025c2e84c9",
  },
  setEncryptedBaseline: {
    length: 104,
    sha256: "ede7ccd7468742aff1d28fb84dae4f9213ef5dd07581ba1931ca8c44e873b981",
  },
  transaction: {
    length: 1_140,
    messageLength: 1_075,
    sha256: "3de3a7f5f1353e711edd58528c25971293dd95c4d273f08a662edee907ad969f",
    messageSha256: "28a5d3d8443c3876b5e8e9ad3155590a9da61a23f2bc1303d90b1da3abd48df4",
  },
} as const;

const COMPACT_FIXTURES = {
  verifyProof: {
    length: 364,
    sha256: "fe15ed962b5bfd18702a402c6706b892ae237834ba8c411c4c913a71779d716d",
  },
  updateAnchor: {
    length: 40,
    sha256: "54e6a58f56e30cca4bc93c1df59899bedd09cfa14c7c7e637977e8f8ffd06a02",
  },
  transaction: {
    length: 1_040,
    messageLength: 975,
    sha256: "b0684bad6754e0ab89e69c55a544e46f309feaa4ebcb73193a3745933f776c00",
    messageSha256: "7cbbd178946231b7f8a2e4d96652c3a1935974409f13f51b3439eb73e59a69f7",
  },
} as const;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicPublicKey(seedByte: number): PublicKey {
  return Keypair.fromSeed(Buffer.alloc(32, seedByte)).publicKey;
}

function loadIdl(name: "entros_anchor" | "entros_verifier"): Idl {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `target/idl/${name}.json`), "utf8"),
  ) as Idl;
}

const anchorIdl = loadIdl("entros_anchor");
const verifierIdl = loadIdl("entros_verifier");
const anchorCoder = new BorshInstructionCoder(anchorIdl);
const verifierCoder = new BorshInstructionCoder(verifierIdl);

function encodeInstruction(
  coder: BorshInstructionCoder,
  name: string,
  args: Record<string, unknown>,
): Buffer {
  return Buffer.from(coder.encode(name, args));
}

function loadProofFixture(): ProofFixture {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "tests/fixtures/test_proof.json"),
      "utf8",
    ),
  ) as ProofFixture;
}

interface VerificationInstructionData {
  createChallenge: Buffer;
  verifyProof: Buffer;
  updateAnchor: Buffer;
  setEncryptedBaseline: Buffer;
}

const INSTRUCTION_NAMES = [
  "createChallenge",
  "verifyProof",
  "updateAnchor",
  "setEncryptedBaseline",
] as const;

const COMPACT_INSTRUCTION_NAMES = ["verifyProof", "updateAnchor"] as const;

interface AccountMetaShape {
  name: string;
  signer: boolean;
  writable: boolean;
}

function accountShape(idl: Idl, name: string): AccountMetaShape[] {
  const instruction = idl.instructions.find((candidate) => candidate.name === name);
  if (!instruction) {
    throw new Error(`instruction ${name} is missing from the generated IDL`);
  }
  return instruction.accounts.map((account) => ({
    name: account.name,
    signer: "signer" in account && account.signer === true,
    writable: "writable" in account && account.writable === true,
  }));
}

const VERIFY_ACCOUNT_SHAPE: AccountMetaShape[] = [
  { name: "verifier", signer: true, writable: true },
  { name: "challenge", signer: false, writable: true },
  { name: "verification_result", signer: false, writable: true },
  { name: "system_program", signer: false, writable: false },
];

const UPDATE_ACCOUNT_SHAPE: AccountMetaShape[] = [
  { name: "authority", signer: true, writable: true },
  { name: "identity_state", signer: false, writable: true },
  { name: "verification_result", signer: false, writable: false },
  { name: "protocol_config", signer: false, writable: false },
  { name: "treasury", signer: false, writable: true },
  { name: "system_program", signer: false, writable: false },
];

function buildTransaction(
  instructionData: VerificationInstructionData,
): Transaction {
  const authority = deterministicPublicKey(1);
  const challenge = deterministicPublicKey(2);
  const verificationResult = deterministicPublicKey(3);
  const identityState = deterministicPublicKey(4);
  const protocolConfig = deterministicPublicKey(5);
  const treasury = deterministicPublicKey(6);
  const encryptedBaseline = deterministicPublicKey(7);
  const recentBlockhash = deterministicPublicKey(8).toBase58();

  return new Transaction({ feePayer: authority, recentBlockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    new TransactionInstruction({
      programId: ENTROS_VERIFIER_PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: challenge, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: instructionData.createChallenge,
    }),
    new TransactionInstruction({
      programId: ENTROS_VERIFIER_PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: challenge, isSigner: false, isWritable: true },
        { pubkey: verificationResult, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: instructionData.verifyProof,
    }),
    new TransactionInstruction({
      programId: ENTROS_ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: identityState, isSigner: false, isWritable: true },
        { pubkey: verificationResult, isSigner: false, isWritable: false },
        { pubkey: protocolConfig, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: instructionData.updateAnchor,
    }),
    new TransactionInstruction({
      programId: ENTROS_ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: identityState, isSigner: false, isWritable: false },
        { pubkey: encryptedBaseline, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: instructionData.setEncryptedBaseline,
    }),
  );
}

function buildLegacyWireFixture(): {
  instructionData: VerificationInstructionData;
  transaction: Transaction;
} {
  const fixture = loadProofFixture();
  const proofBytes = Buffer.from(fixture.proof_bytes);
  const publicInputs = fixture.public_inputs.map((input) => Buffer.from(input));
  const nonce = Buffer.alloc(32, 7);

  const instructionData = {
    createChallenge: encodeInstruction(verifierCoder, "create_challenge", {
      nonce,
    }),
    verifyProof: encodeInstruction(verifierCoder, "verify_proof", {
      proof_bytes: proofBytes,
      public_inputs: publicInputs,
      nonce,
    }),
    updateAnchor: encodeInstruction(anchorCoder, "update_anchor", {
      new_commitment: publicInputs[0],
      verification_nonce: nonce,
    }),
    setEncryptedBaseline: encodeInstruction(
      anchorCoder,
      "set_encrypted_baseline",
      { blob: Buffer.alloc(96, 9) },
    ),
  };

  return { instructionData, transaction: buildTransaction(instructionData) };
}

function buildCompactWireFixture(): {
  instructionData: VerificationInstructionData;
  transaction: Transaction;
} {
  const fixture = loadProofFixture();
  const proofBytes = Buffer.from(fixture.proof_bytes);
  const publicInputs = fixture.public_inputs.map((input) => Buffer.from(input));
  const nonce = Buffer.alloc(32, 7);
  const threshold = publicInputs[2].readUInt16BE(30);
  const minDistance = publicInputs[3].readUInt16BE(30);

  const instructionData = {
    createChallenge: encodeInstruction(verifierCoder, "create_challenge", {
      nonce,
    }),
    verifyProof: encodeInstruction(verifierCoder, "verify_proof_compact", {
      nonce,
      proof_bytes: proofBytes,
      commitment_new: publicInputs[0],
      commitment_prev: publicInputs[1],
      threshold,
      min_distance: minDistance,
    }),
    updateAnchor: encodeInstruction(anchorCoder, "update_anchor_compact", {
      verification_nonce: nonce,
    }),
    setEncryptedBaseline: encodeInstruction(
      anchorCoder,
      "set_encrypted_baseline",
      { blob: Buffer.alloc(96, 9) },
    ),
  };

  return { instructionData, transaction: buildTransaction(instructionData) };
}

describe("legacy verification transaction wire compatibility", () => {
  const fixture = buildLegacyWireFixture();

  for (const instructionName of INSTRUCTION_NAMES) {
    it(`preserves ${instructionName} bytes`, () => {
      const data = fixture.instructionData[instructionName];
      const expected = LEGACY_FIXTURES[instructionName];

      expect(data).to.have.length(expected.length);
      expect(sha256(data)).to.equal(expected.sha256);
    });
  }

  it("preserves the complete legacy transaction", () => {
    const serialized = fixture.transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const message = fixture.transaction.serializeMessage();

    expect(serialized).to.have.length(LEGACY_FIXTURES.transaction.length);
    expect(message).to.have.length(LEGACY_FIXTURES.transaction.messageLength);
    expect(sha256(serialized)).to.equal(LEGACY_FIXTURES.transaction.sha256);
    expect(sha256(message)).to.equal(
      LEGACY_FIXTURES.transaction.messageSha256,
    );
  });
});

describe("generated verification account metadata", () => {
  it("preserves both program addresses", () => {
    expect(verifierIdl.address).to.equal(ENTROS_VERIFIER_PROGRAM_ID.toBase58());
    expect(anchorIdl.address).to.equal(ENTROS_ANCHOR_PROGRAM_ID.toBase58());
  });

  it("keeps compact verifier accounts identical to the legacy instruction", () => {
    expect(accountShape(verifierIdl, "verify_proof")).to.deep.equal(
      VERIFY_ACCOUNT_SHAPE,
    );
    expect(accountShape(verifierIdl, "verify_proof_compact")).to.deep.equal(
      VERIFY_ACCOUNT_SHAPE,
    );
  });

  it("keeps compact update accounts identical to the legacy instruction", () => {
    expect(accountShape(anchorIdl, "update_anchor")).to.deep.equal(
      UPDATE_ACCOUNT_SHAPE,
    );
    expect(accountShape(anchorIdl, "update_anchor_compact")).to.deep.equal(
      UPDATE_ACCOUNT_SHAPE,
    );
  });
});

describe("compact verification transaction wire format", () => {
  const fixture = buildCompactWireFixture();

  for (const instructionName of COMPACT_INSTRUCTION_NAMES) {
    it(`pins ${instructionName} bytes`, () => {
      const data = fixture.instructionData[instructionName];
      const expected = COMPACT_FIXTURES[instructionName];

      expect(data).to.have.length(expected.length);
      expect(sha256(data)).to.equal(expected.sha256);
    });
  }

  it("keeps the complete transaction below the legacy limit", () => {
    const serialized = fixture.transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const message = fixture.transaction.serializeMessage();

    expect(serialized).to.have.length(COMPACT_FIXTURES.transaction.length);
    expect(message).to.have.length(COMPACT_FIXTURES.transaction.messageLength);
    expect(sha256(serialized)).to.equal(COMPACT_FIXTURES.transaction.sha256);
    expect(sha256(message)).to.equal(
      COMPACT_FIXTURES.transaction.messageSha256,
    );
    expect(serialized.length).to.be.lessThan(
      LEGACY_FIXTURES.transaction.length,
    );
  });
});
