import { web3 } from "@coral-xyz/anchor";
import * as fs from "node:fs";
import * as path from "node:path";

type PublicKey = web3.PublicKey;

//--------- iamAnchor
export const deriveIdentityPda = (
  user: PublicKey,
  iamAnchorProgId: PublicKey,
) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), user.toBuffer()],
    iamAnchorProgId,
  );

export const deriveMintPda = (user: PublicKey, iamAnchorProgId: PublicKey) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), user.toBuffer()],
    iamAnchorProgId,
  );

//--------- iamVerifier
// Load pre-generated Groth16 proof fixture
export const loadProofFixture = () =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "fixtures/test_proof.json"),
      "utf-8",
    ),
  );

export const generateNonce = (): number[] =>
  Array.from(web3.Keypair.generate().publicKey.toBytes());

export const deriveChallengePda = (
  challenger: PublicKey,
  nonce: number[],
  verifierProgId: PublicKey,
) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("challenge"), challenger.toBuffer(), Buffer.from(nonce)],
    verifierProgId,
  );

export const deriveVerificationPda = (
  verifier: PublicKey,
  nonce: number[],
  verifierProgId: PublicKey,
) =>
  web3.PublicKey.findProgramAddressSync(
    [Buffer.from("verification"), verifier.toBuffer(), Buffer.from(nonce)],
    verifierProgId,
  );
