import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import type { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import {
  anchorAddr,
  BASE_TRUST_INCREMENT,
  CHALLENGE_EXPIRY,
  decodeIdentityPdaDev,
  decodeProtocolConfigDev,
  type IdentityStateAcctWeb3js,
  loadProofFixture,
  MAX_TRUST_SCORE,
  MIN_STAKE,
  mintAuthorityPda,
  type Pdas,
  protocolConfigBump,
  protocolConfigPda,
  registryAddr,
  treasuryPda,
  VERIFICATION_FEE,
} from "./encodeDecode.ts";
import {
  acctEqual,
  acctIsNull,
  adminKp,
  balcAtaCk,
  initializeProtocol,
  mintAnchor,
  pdasBySignerKp,
  readAcct,
  readAnchorMintAcct,
} from "./litesvm-utils.ts";

/*
Build the Solana programs first:
$ anchor build
Then Install NodeJs v25.9.0(or above v22.18.0) to run this TypeScript Natively: node ./file_path/this_file.ts
Or use Bun: bun test ./file_path/this_file.ts
*/

const fixture = loadProofFixture();

let signerKp: Keypair;
let pdas: Pdas;
const tokenProgram = TOKEN_2022_PROGRAM_ID;
let rawAccData: Uint8Array<ArrayBufferLike> | undefined;
let identity: IdentityStateAcctWeb3js;

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
  console.log("mintAuthority:", mintAuthorityPda.toBytes());
  readAnchorMintAcct(pdas.mintPda);
});
