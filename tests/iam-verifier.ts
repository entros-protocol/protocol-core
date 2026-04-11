import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import type { IamVerifier } from "../target/types/iam_verifier";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load pre-generated Groth16 proof fixture
const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "fixtures/test_proof.json"),
    "utf-8"
  )
);

describe("iam-verifier", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.iamVerifier as Program<IamVerifier>;

  function generateNonce(): number[] {
    return Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
  }

  function deriveChallengePda(
    challenger: anchor.web3.PublicKey,
    nonce: number[]
  ) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("challenge"),
        challenger.toBuffer(),
        Buffer.from(nonce),
      ],
      program.programId
    );
  }

  function deriveVerificationPda(
    verifier: anchor.web3.PublicKey,
    nonce: number[]
  ) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("verification"),
        verifier.toBuffer(),
        Buffer.from(nonce),
      ],
      program.programId
    );
  }

  it("creates a challenge", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(provider.wallet.publicKey, nonce);

    await program.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: provider.wallet.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const challenge = await program.account.challenge.fetch(challengePda);
    expect(challenge.challenger.toBase58()).to.equal(
      provider.wallet.publicKey.toBase58()
    );
    expect(challenge.used).to.be.false;
    expect(challenge.expiresAt.toNumber()).to.be.greaterThan(
      challenge.createdAt.toNumber()
    );
  });

  it("verifies a valid Groth16 proof", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(provider.wallet.publicKey, nonce);
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce
    );

    await program.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: provider.wallet.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const proofBytes = Buffer.from(fixture.proof_bytes);
    const publicInputs: number[][] = fixture.public_inputs;

    await program.methods
      .verifyProof(proofBytes, publicInputs, nonce)
      .accountsStrict({
        verifier: provider.wallet.publicKey,
        challenge: challengePda,
        verificationResult: verificationPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const result = await program.account.verificationResult.fetch(
      verificationPda
    );
    expect(result.isValid).to.be.true;
    expect(result.verifier.toBase58()).to.equal(
      provider.wallet.publicKey.toBase58()
    );

    const challenge = await program.account.challenge.fetch(challengePda);
    expect(challenge.used).to.be.true;
  });

  it("rejects tampered proof (transaction reverts)", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(provider.wallet.publicKey, nonce);
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce
    );

    await program.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: provider.wallet.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Tamper with proof bytes (flip some bytes)
    const tamperedProof = Buffer.from(fixture.proof_bytes);
    tamperedProof[10] ^= 0xff;
    tamperedProof[50] ^= 0xff;

    try {
      await program.methods
        .verifyProof(tamperedProof, fixture.public_inputs, nonce)
        .accountsStrict({
          verifier: provider.wallet.publicKey,
          challenge: challengePda,
          verificationResult: verificationPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown — invalid proof must revert");
    } catch (err: any) {
      expect(err).to.exist;
    }

    // Challenge nonce must NOT be consumed (transaction reverted atomically)
    const challenge = await program.account.challenge.fetch(challengePda);
    expect(challenge.used).to.be.false;
  });

  it("rejects already-used challenge", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(provider.wallet.publicKey, nonce);
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce
    );

    await program.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: provider.wallet.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const proofBytes = Buffer.from(fixture.proof_bytes);

    await program.methods
      .verifyProof(proofBytes, fixture.public_inputs, nonce)
      .accountsStrict({
        verifier: provider.wallet.publicKey,
        challenge: challengePda,
        verificationResult: verificationPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .verifyProof(proofBytes, fixture.public_inputs, nonce)
        .accountsStrict({
          verifier: provider.wallet.publicKey,
          challenge: challengePda,
          verificationResult: verificationPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});
