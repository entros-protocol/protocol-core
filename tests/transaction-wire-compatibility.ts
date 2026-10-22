import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import { BN, BorshInstructionCoder, type Idl } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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

const LEGACY_PACKET_LIMIT = 1_232;

const LEGACY_FIXTURES = {
  verifyProof: {
    length: 432,
    sha256: "3ac0e703f0a8f3bb5ad3f7a739ae8c70989226a05b687c0b760b0ab0fbe7ba07",
  },
  updateAnchor: {
    length: 50,
    sha256: "8ee3d93db2f0c17d51ed7f6c7970ef2cab6ce3a580ec756dfd2527988b05f260",
  },
  setEncryptedBaseline: {
    length: 104,
    sha256: "ede7ccd7468742aff1d28fb84dae4f9213ef5dd07581ba1931ca8c44e873b981",
  },
  transaction: {
    messageLength: 1_188,
    uncompressedWireLength: 1_253,
    messageSha256: "bbcc23adcac075d406614a77fe9eb81109b7b21e76859de997171aa34e5068d4",
  },
} as const;

const COMPACT_FIXTURES = {
  verifyProof: {
    length: 364,
    sha256: "fe15ed962b5bfd18702a402c6706b892ae237834ba8c411c4c913a71779d716d",
  },
  updateAnchor: {
    length: 18,
    sha256: "a4a78b925692aab1d75fdcb033c2056b26ca8bc6f4055c8e5975f49f1b539ed7",
  },
  updateAnchorWithSession: {
    length: 50,
    sha256: "0bc87be0925d46a1b2d71624847db8ac776c2b7f98479f120d886155e7cc345a",
  },
  transaction: {
    length: 1_153,
    messageLength: 1_088,
    sha256: "279d805d7cb70e5fbbab64d96210f025b85a371baf4b8227dedb9258688c29d4",
    messageSha256: "a42483da85de89541f5041dbfa2da30c4b2a9d53533e1147b0e653bea837f9c2",
  },
  transactionWithSession: {
    length: 1_185,
    messageLength: 1_120,
    sha256: "40ce147e78dc7740061c944f9f0039d1408e9be22bf41f87d405d1808720bad8",
    messageSha256: "28833f6e4f7ff01b2c589a0e6ceadb4028ee4be60230cbdf6cfe07008c4b16ab",
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
  verifyProof: Buffer;
  updateAnchor: Buffer;
  setEncryptedBaseline: Buffer;
}

const INSTRUCTION_NAMES = [
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
  { name: "verification_result", signer: false, writable: true },
  { name: "system_program", signer: false, writable: false },
];

const UPDATE_ACCOUNT_SHAPE: AccountMetaShape[] = [
  { name: "authority", signer: true, writable: true },
  { name: "identity_state", signer: false, writable: true },
  { name: "verification_result", signer: false, writable: true },
  { name: "protocol_config", signer: false, writable: false },
  { name: "treasury", signer: false, writable: true },
  { name: "system_program", signer: false, writable: false },
  { name: "instructions_sysvar", signer: false, writable: false },
  { name: "verifier_program", signer: false, writable: false },
];

function buildUpdateReceiptIx(
  authority: PublicKey,
  commitmentNew: Buffer,
  assuranceTier: number,
  sessionFinalDigest: Buffer | null,
): TransactionInstruction {
  const validator = Keypair.fromSeed(Buffer.alloc(32, 9));
  const preimage = Buffer.alloc(136);
  Buffer.from("entros-validator-receipt-v4\0", "utf8").copy(preimage, 0);
  preimage[28] = 4;
  preimage.writeUInt16LE(1, 29);
  authority.toBuffer().copy(preimage, 31);
  commitmentNew.copy(preimage, 63);
  preimage.writeBigInt64LE(BigInt(1_700_000_000), 95);
  if (sessionFinalDigest) {
    sessionFinalDigest.copy(preimage, 103);
  }
  preimage[135] = assuranceTier;
  const digest = createHash("sha256").update(preimage).digest();
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: validator.secretKey,
    message: digest,
  });
}

function buildTransaction(
  instructionData: VerificationInstructionData,
  commitmentNew: Buffer,
  assuranceTier = 0,
  sessionFinalDigest: Buffer | null = null,
): Transaction {
  const authority = deterministicPublicKey(1);
  const verificationResult = deterministicPublicKey(3);
  const identityState = deterministicPublicKey(4);
  const protocolConfig = deterministicPublicKey(5);
  const treasury = deterministicPublicKey(6);
  const encryptedBaseline = deterministicPublicKey(7);
  const recentBlockhash = deterministicPublicKey(8).toBase58();
  const receiptIx = buildUpdateReceiptIx(
    authority,
    commitmentNew,
    assuranceTier,
    sessionFinalDigest,
  );

  return new Transaction({ feePayer: authority, recentBlockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    new TransactionInstruction({
      programId: ENTROS_VERIFIER_PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: verificationResult, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: instructionData.verifyProof,
    }),
    receiptIx,
    new TransactionInstruction({
      programId: ENTROS_ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: identityState, isSigner: false, isWritable: true },
        { pubkey: verificationResult, isSigner: false, isWritable: true },
        { pubkey: protocolConfig, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: ENTROS_VERIFIER_PROGRAM_ID,
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
    verifyProof: encodeInstruction(verifierCoder, "verify_proof", {
      proof_bytes: proofBytes,
      public_inputs: publicInputs,
      nonce,
    }),
    updateAnchor: encodeInstruction(anchorCoder, "update_anchor", {
      new_commitment: publicInputs[0],
      receipt: {
        validated_at: new BN(1_700_000_000),
        assurance_tier: 0,
        session_final_digest: null,
      },
    }),
    setEncryptedBaseline: encodeInstruction(
      anchorCoder,
      "set_encrypted_baseline",
      { blob: Buffer.alloc(96, 9) },
    ),
  };

  return {
    instructionData,
    transaction: buildTransaction(instructionData, publicInputs[0]),
  };
}

function buildCompactWireFixture(): {
  instructionData: VerificationInstructionData;
  updateAnchorWithSession: Buffer;
  transaction: Transaction;
  transactionWithSession: Transaction;
} {
  const fixture = loadProofFixture();
  const proofBytes = Buffer.from(fixture.proof_bytes);
  const publicInputs = fixture.public_inputs.map((input) => Buffer.from(input));
  const nonce = Buffer.alloc(32, 7);
  const threshold = publicInputs[2].readUInt16BE(30);
  const minDistance = publicInputs[3].readUInt16BE(30);
  const sessionFinalDigest = Buffer.alloc(32, 10);

  const instructionData = {
    verifyProof: encodeInstruction(verifierCoder, "verify_proof_compact", {
      nonce,
      proof_bytes: proofBytes,
      commitment_new: publicInputs[0],
      commitment_prev: publicInputs[1],
      threshold,
      min_distance: minDistance,
    }),
    updateAnchor: encodeInstruction(anchorCoder, "update_anchor_compact", {
      receipt: {
        validated_at: new BN(1_700_000_000),
        assurance_tier: 0,
        session_final_digest: null,
      },
    }),
    setEncryptedBaseline: encodeInstruction(
      anchorCoder,
      "set_encrypted_baseline",
      { blob: Buffer.alloc(96, 9) },
    ),
  };

  const updateAnchorWithSession = encodeInstruction(
    anchorCoder,
    "update_anchor_compact",
    {
      receipt: {
        validated_at: new BN(1_700_000_000),
        assurance_tier: 1,
        session_final_digest: Array.from(sessionFinalDigest),
      },
    },
  );

  return {
    instructionData,
    updateAnchorWithSession,
    transaction: buildTransaction(instructionData, publicInputs[0]),
    transactionWithSession: buildTransaction(
      { ...instructionData, updateAnchor: updateAnchorWithSession },
      publicInputs[0],
      1,
      sessionFinalDigest,
    ),
  };
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

  it("pins the uncompressed legacy message and proves compact encoding is required", () => {
    const message = fixture.transaction.serializeMessage();
    const uncompressedWireLength = 1 + 64 + message.length;

    expect(message).to.have.length(LEGACY_FIXTURES.transaction.messageLength);
    expect(uncompressedWireLength).to.equal(
      LEGACY_FIXTURES.transaction.uncompressedWireLength,
    );
    expect(uncompressedWireLength).to.be.greaterThan(LEGACY_PACKET_LIMIT);
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

  it("pins updateAnchorCompact bytes with session_final_digest", () => {
    expect(fixture.updateAnchorWithSession).to.have.length(
      COMPACT_FIXTURES.updateAnchorWithSession.length,
    );
    expect(sha256(fixture.updateAnchorWithSession)).to.equal(
      COMPACT_FIXTURES.updateAnchorWithSession.sha256,
    );
  });

  it("keeps the complete transaction below the legacy limit with and without session digest", () => {
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
    expect(serialized.length).to.be.lessThan(LEGACY_PACKET_LIMIT);

    const serializedWithSession = fixture.transactionWithSession.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const messageWithSession = fixture.transactionWithSession.serializeMessage();

    expect(serializedWithSession).to.have.length(
      COMPACT_FIXTURES.transactionWithSession.length,
    );
    expect(messageWithSession).to.have.length(
      COMPACT_FIXTURES.transactionWithSession.messageLength,
    );
    expect(sha256(serializedWithSession)).to.equal(
      COMPACT_FIXTURES.transactionWithSession.sha256,
    );
    expect(sha256(messageWithSession)).to.equal(
      COMPACT_FIXTURES.transactionWithSession.messageSha256,
    );
    expect(serializedWithSession.length).to.be.lessThan(LEGACY_PACKET_LIMIT);
  });
});
