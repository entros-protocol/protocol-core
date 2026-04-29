import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Address,
  FixedSizeDecoder,
  ReadonlyUint8Array,
} from "@solana/kit";
import {
  fixDecoderSize,
  getAddressDecoder,
  getArrayDecoder,
  getBytesDecoder,
  getI64Decoder,
  getLamportsEncoder,
  //getBooleanDecoder,
  //getEnumDecoder,
  getStructDecoder,
  getU8Decoder,
  getU8Encoder,
  getU16Decoder,
  getU16Encoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  lamports,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

//-----------== Basic settings
export const anchorAddr = new PublicKey(
  "GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2",
);
console.log("anchorAddr:", anchorAddr.toBase58());

export const registryAddr = new PublicKey(
  "6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW",
);
console.log("registryAddr:", registryAddr.toBase58());

export const verifierAddr = new PublicKey(
  "4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV",
);
console.log("verifierAddr:", verifierAddr.toBase58());
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
/// Solana Instructions sysvar — read-only account that exposes the
/// transaction's instruction list to on-chain programs. mint_anchor
/// (master-list #146 Phase 3) reads it to verify a preceding
/// Ed25519Program::verify mint receipt.
export const INSTRUCTIONS_SYSVAR = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111",
);
export const BPFLoaderUpgradeab1e = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
console.log("BPFLoaderUpgradeab1e:", BPFLoaderUpgradeab1e.toBase58());

export const MIN_STAKE = BigInt(1_000_000_000);
console.log("MIN_STAKE:", MIN_STAKE); // 1 SOL
export const CHALLENGE_EXPIRY = BigInt(300); //i64,
export const MAX_TRUST_SCORE = 10000; //u16,
export const BASE_TRUST_INCREMENT = 100; //u16,
export const VERIFICATION_FEE = BigInt(0);
export const MIGRATION_FEE = BigInt(0);

//-----------== entrosRegistry
export const [treasuryPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol_treasury")],
  registryAddr,
);
console.log("treasuryPda:", treasuryPda.toBase58());
//-----------== entrosVerifier
// Load pre-generated Groth16 proof fixture
export const loadProofFixture = () =>
  JSON.parse(
    fs.readFileSync(path.resolve("tests/fixtures/test_proof.json"), "utf-8"),
  );

export const generateNonce = (): number[] =>
  Array.from(Keypair.generate().publicKey.toBytes());
export const deriveChallengePda = (challenger: PublicKey, nonce: number[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("challenge"), challenger.toBuffer(), Buffer.from(nonce)],
    verifierAddr,
  );
export const deriveVerificationPda = (verifier: PublicKey, nonce: number[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("verification"), verifier.toBuffer(), Buffer.from(nonce)],
    verifierAddr,
  );
export const deriveValidatorState = (validator: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("validator"), validator.toBuffer()],
    registryAddr,
  );
export const [vaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault")],
  registryAddr,
);
//According to Registry::MigrateAdmin
export const [programdataAddr, programdataBump] =
  PublicKey.findProgramAddressSync(
    [registryAddr.toBuffer()],
    BPFLoaderUpgradeab1e,
  );

//-------------==
export type Pdas = {
  identityPda: PublicKey;
  mintPda: PublicKey;
  nonce: number[];
  challengePda: PublicKey;
  verificationPda: PublicKey;
  ata: PublicKey;
};
export const getPdas = (
  signer: PublicKey,
  tokenProgram = TOKEN_2022_PROGRAM_ID,
): Pdas => {
  const [identityPda] = deriveIdentityPda(signer);
  const [mintPda] = deriveMintPda(signer);
  const nonce = generateNonce();
  const [challengePda] = deriveChallengePda(signer, nonce);
  const [verificationPda] = deriveVerificationPda(signer, nonce);
  const ata = getAta(mintPda, signer, false, tokenProgram);
  return {
    identityPda,
    mintPda,
    nonce,
    challengePda,
    verificationPda,
    ata,
  };
};

//-----------==
export const getAta = (
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = true,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID,
) => {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    programId,
    associatedTokenProgramId,
  );
  return ata;
};
//-----------== entrosAnchor
export const deriveMintPda = (user: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), user.toBuffer()],
    anchorAddr,
  );
export const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority")],
  anchorAddr,
);
console.log("mintAuthorityPda:", mintAuthorityPda.toBase58());

//-----------== IdentityState
export const deriveIdentityPda = (user: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), user.toBuffer()],
    anchorAddr,
  );
export type IdentityStateAcct = {
  anchorDiscriminator: ReadonlyUint8Array;
  owner: Address;
  creation_timestamp: bigint;
  last_verification_timestamp: bigint;
  verification_count: number;
  trust_score: number;
  current_commitment: ReadonlyUint8Array; //len = 32
  mint: Address;
  bump: number;
  recent_timestamps: bigint[]; //len = 52; BigInt64Array
  last_reset_timestamp: bigint;
  new_wallet: Address;
};
export const identityStateAcctDecoder: FixedSizeDecoder<IdentityStateAcct> =
  getStructDecoder([
    ["anchorDiscriminator", fixDecoderSize(getBytesDecoder(), 8)], //only for accounts made by Anchor
    ["owner", getAddressDecoder()],
    ["creation_timestamp", getI64Decoder()],
    ["last_verification_timestamp", getI64Decoder()],
    ["verification_count", getU32Decoder()],
    ["trust_score", getU16Decoder()],
    ["current_commitment", fixDecoderSize(getBytesDecoder(), 32)],
    ["mint", getAddressDecoder()],
    ["bump", getU8Decoder()],
    ["recent_timestamps", getArrayDecoder(getI64Decoder(), { size: 52 })],
    ["last_reset_timestamp", getI64Decoder()],
    ["new_wallet", getAddressDecoder()],
  ]);
export const decodeIdentityState = (
  bytes: ReadonlyUint8Array | Uint8Array<ArrayBufferLike>,
  isVerbose = false,
) => {
  const decoded = identityStateAcctDecoder.decode(bytes);
  if (isVerbose) {
    console.log("owner:", decoded.owner);
    console.log("creation_timestamp:", decoded.creation_timestamp);
    console.log(
      "last_verification_timestamp:",
      decoded.last_verification_timestamp,
    );
    console.log("verification_count:", decoded.verification_count);
    console.log("trust_score:", decoded.trust_score);
    console.log("current_commitment:", decoded.current_commitment);
    console.log("mint:", decoded.mint);
    console.log("bump:", decoded.bump);
    console.log("recent_timestamps:", decoded.recent_timestamps);
    console.log("last_reset_timestamp:", decoded.last_reset_timestamp);
    console.log("new_wallet:", decoded.new_wallet);
  }
  return decoded;
};
// This below is only used for @solana/web3.js as it is outputing PublicKey, not Address
export const decodeIdentityPdaDev = (
  bytes: ReadonlyUint8Array | Uint8Array<ArrayBufferLike> | undefined,
) => {
  if (!bytes) throw new Error("bytes invalid");
  const decoded = decodeIdentityState(bytes, true);
  const decodedV1: IdentityStateAcctWeb3js = {
    owner: new PublicKey(decoded.owner.toString()),
    creation_timestamp: decoded.creation_timestamp,
    last_verification_timestamp: decoded.last_verification_timestamp,
    verification_count: decoded.verification_count,
    trust_score: decoded.trust_score,
    bump: decoded.bump,
    current_commitment: decoded.current_commitment,
    mint: new PublicKey(decoded.mint.toString()),
    recent_timestamps: decoded.recent_timestamps,
    last_reset_timestamp: decoded.last_reset_timestamp,
    new_wallet: new PublicKey(decoded.new_wallet.toString()),
  };
  return decodedV1;
};
export type IdentityStateAcctWeb3js = {
  owner: PublicKey;
  creation_timestamp: bigint;
  last_verification_timestamp: bigint;
  verification_count: number;
  trust_score: number;
  current_commitment: ReadonlyUint8Array;
  mint: PublicKey;
  bump: number;
  recent_timestamps: bigint[];
  last_reset_timestamp: bigint;
  new_wallet: PublicKey;
};
//-----------== ProtocolConfigPDA
export const [protocolConfigPda, protocolConfigBump] =
  PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    registryAddr,
  );
export type ProtocolConfigAcct = {
  anchorDiscriminator: ReadonlyUint8Array;
  admin: Address;
  min_stake: bigint;
  challenge_expiry: bigint;
  max_trust_score: number;
  base_trust_increment: number;
  bump: number;
  verification_fee: bigint;
  migration_fee: bigint;
  validator_pubkey: Address;
}; //padding: bigint[];
export const protocolconfigAcctDecoder: FixedSizeDecoder<ProtocolConfigAcct> =
  getStructDecoder([
    ["anchorDiscriminator", fixDecoderSize(getBytesDecoder(), 8)], //only for accounts made by Anchor
    ["admin", getAddressDecoder()],
    ["min_stake", getU64Decoder()],
    ["challenge_expiry", getI64Decoder()],
    ["max_trust_score", getU16Decoder()],
    ["base_trust_increment", getU16Decoder()],
    ["bump", getU8Decoder()],
    ["verification_fee", getU64Decoder()],
    ["migration_fee", getU64Decoder()],
    // master-list #146 Phase 3: validator_pubkey appended at offset 77
    // (Pubkey is 32 bytes, same encoding as Address). Pre-migration
    // accounts (77 bytes total) won't decode through this decoder —
    // post-migration accounts are 109 bytes.
    ["validator_pubkey", getAddressDecoder()],
    //["padding", getArrayDecoder(getU64Decoder(), { size: 3 })],
  ]);
export const decodeProtocolConfig = (
  bytes: ReadonlyUint8Array | Uint8Array<ArrayBufferLike>,
  isVerbose = false,
) => {
  const decoded = protocolconfigAcctDecoder.decode(bytes);
  if (isVerbose) {
    console.log("admin:", decoded.admin);
    console.log("min_stake:", decoded.min_stake);
    console.log("challenge_expiry:", decoded.challenge_expiry);
    console.log("max_trust_score:", decoded.max_trust_score);
    console.log("base_trust_increment:", decoded.base_trust_increment);
    console.log("bump:", decoded.bump);
    console.log("verification_fee:", decoded.verification_fee);
    console.log("migration_fee:", decoded.migration_fee);
    console.log("validator_pubkey:", decoded.validator_pubkey);
  }
  return decoded;
};
// This below is only used for @solana/web3.js as it is outputing PublicKey, not Address
export const decodeProtocolConfigDev = (
  bytes: ReadonlyUint8Array | Uint8Array<ArrayBufferLike> | undefined,
) => {
  if (!bytes) throw new Error("bytes invalid");
  const decoded = decodeProtocolConfig(bytes, true);
  const decodedV1: ProtocolConfigAcctDev = {
    admin: new PublicKey(decoded.admin.toString()),
    min_stake: decoded.min_stake,
    challenge_expiry: decoded.challenge_expiry,
    max_trust_score: decoded.max_trust_score,
    base_trust_increment: decoded.base_trust_increment,
    bump: decoded.bump,
    verification_fee: decoded.verification_fee,
    migration_fee: decoded.migration_fee,
    validator_pubkey: new PublicKey(decoded.validator_pubkey.toString()),
  };
  return decodedV1;
};
export type ProtocolConfigAcctDev = {
  admin: PublicKey;
  min_stake: bigint;
  challenge_expiry: bigint;
  max_trust_score: number;
  base_trust_increment: number;
  bump: number;
  verification_fee: bigint;
  migration_fee: bigint;
  validator_pubkey: PublicKey;
};

//-------------== Encode numbers
export const numToBytes = (input: bigint | number, bit = 64) => {
  let amtBigint = BigInt(0);
  if (typeof input === "number") {
    if (input < 0) throw new Error("input < 0");
    amtBigint = BigInt(input);
  } else {
    if (input < BigInt(0)) throw new Error("input < 0");
    amtBigint = input;
  }
  const amtLam = lamports(amtBigint);
  // biome-ignore lint/suspicious/noExplicitAny: <>
  let lamportsEncoder: any;
  if (bit === 64) {
    lamportsEncoder = getLamportsEncoder(getU64Encoder());
  } else if (bit === 32) {
    lamportsEncoder = getLamportsEncoder(getU32Encoder());
  } else if (bit === 16) {
    lamportsEncoder = getLamportsEncoder(getU16Encoder());
  } else if (bit === 8) {
    lamportsEncoder = getLamportsEncoder(getU8Encoder());
  } else {
    throw new Error("bit unknown");
    //lamportsEncoder = getDefaultLamportsEncoder()
  }
  const u8Bytes: Uint8Array = lamportsEncoder.encode(amtLam);
  console.log("u8Bytes", u8Bytes);
  return u8Bytes;
};
