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
import { Keypair, PublicKey } from "@solana/web3.js";
import { entrosAnchorAddr, registryAddr, verifierAddr } from "./litesvm-utils.ts";

//-----------==
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

//-----------== entrosAnchor
export const deriveMintPda = (user: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), user.toBuffer()],
    entrosAnchorAddr,
  );
export const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority")],
  entrosAnchorAddr,
);
console.log("mintAuthorityPda:", mintAuthorityPda.toBase58());

//-----------== IdentityState
export const deriveIdentityPda = (user: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), user.toBuffer()],
    entrosAnchorAddr,
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
  }
  return decoded;
};
// This below is only used for @solana/web3.js as it is outputing PublicKey, not Address
export const decodeIdentityStateWeb3js = (
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
  }
  return decoded;
};
// This below is only used for @solana/web3.js as it is outputing PublicKey, not Address
export const decodeProtocolConfigWeb3js = (
  bytes: ReadonlyUint8Array | Uint8Array<ArrayBufferLike> | undefined,
) => {
  if (!bytes) throw new Error("bytes invalid");
  const decoded = decodeProtocolConfig(bytes, true);
  const decodedV1: ProtocolConfigAcctWeb3js = {
    admin: new PublicKey(decoded.admin.toString()),
    min_stake: decoded.min_stake,
    challenge_expiry: decoded.challenge_expiry,
    max_trust_score: decoded.max_trust_score,
    base_trust_increment: decoded.base_trust_increment,
    bump: decoded.bump,
    verification_fee: decoded.verification_fee,
  };
  return decodedV1;
};
export type ProtocolConfigAcctWeb3js = {
  admin: PublicKey;
  min_stake: bigint;
  challenge_expiry: bigint;
  max_trust_score: number;
  base_trust_increment: number;
  bump: number;
  verification_fee: bigint;
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
