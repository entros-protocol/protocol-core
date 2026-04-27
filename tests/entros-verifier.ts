import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import type { EntrosVerifier } from "../target/types/entros_verifier";
import {
  deriveChallengePda,
  deriveVerificationPda,
  generateNonce,
  loadProofFixture,
} from "./utils";

const fixture = loadProofFixture();

describe("entros-verifier", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.entrosVerifier as Program<EntrosVerifier>;
  const iamVerifierProgId = program.programId;

  it("creates a challenge", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );

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
      provider.wallet.publicKey.toBase58(),
    );
    expect(challenge.used).to.be.false;
    expect(challenge.expiresAt.toNumber()).to.be.greaterThan(
      challenge.createdAt.toNumber(),
    );
  });

  it("verifies a valid Groth16 proof", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
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

    const result =
      await program.account.verificationResult.fetch(verificationPda);
    expect(result.isValid).to.be.true;
    expect(result.verifier.toBase58()).to.equal(
      provider.wallet.publicKey.toBase58(),
    );

    const challenge = await program.account.challenge.fetch(challengePda);
    expect(challenge.used).to.be.true;
  });

  it("rejects tampered proof (transaction reverts)", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
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
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
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

  // ---- Binding-patch bound-check tests (added 2026-04-20) ----

  it("stores commitment_new / commitment_prev / threshold / min_distance on a valid proof", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
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

    const result = await program.account.verificationResult.fetch(verificationPda);
    // Fixture has threshold=30, min_distance=3 per its description.
    expect((result as any).threshold).to.equal(30);
    expect((result as any).minDistance).to.equal(3);
    expect(Buffer.from((result as any).commitmentNew)).to.deep.equal(
      Buffer.from(fixture.public_inputs[0]),
    );
    expect(Buffer.from((result as any).commitmentPrev)).to.deep.equal(
      Buffer.from(fixture.public_inputs[1]),
    );
  });

  it("rejects public_inputs with threshold field exceeding u16 (high bytes set)", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );

    await program.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: provider.wallet.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Craft bad public_inputs: threshold with a high byte set so the u16
    // decode would be ambiguous without the zero-check in the verifier.
    const badPublicInputs: number[][] = [
      [...fixture.public_inputs[0]],
      [...fixture.public_inputs[1]],
      [...fixture.public_inputs[2]],
      [...fixture.public_inputs[3]],
    ];
    badPublicInputs[2][0] = 0x01; // Set a high byte, forbidden by decode check

    try {
      await program.methods
        .verifyProof(Buffer.from(fixture.proof_bytes), badPublicInputs, nonce)
        .accountsStrict({
          verifier: provider.wallet.publicKey,
          challenge: challengePda,
          verificationResult: verificationPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have rejected — InvalidPublicInputs");
    } catch (err: any) {
      expect(err).to.exist;
      expect(String(err)).to.match(/InvalidPublicInputs|6004/);
    }
  });

  it("rejects public_inputs with zero commitment_new", async () => {
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );

    await program.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: provider.wallet.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const badPublicInputs: number[][] = [
      new Array(32).fill(0),
      [...fixture.public_inputs[1]],
      [...fixture.public_inputs[2]],
      [...fixture.public_inputs[3]],
    ];

    try {
      await program.methods
        .verifyProof(Buffer.from(fixture.proof_bytes), badPublicInputs, nonce)
        .accountsStrict({
          verifier: provider.wallet.publicKey,
          challenge: challengePda,
          verificationResult: verificationPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have rejected — InvalidPublicInputs (zero commitment_new)");
    } catch (err: any) {
      expect(err).to.exist;
      expect(String(err)).to.match(/InvalidPublicInputs|6004/);
    }
  });

  it("create_challenge with zero nonce should fail with error code 6006", async () => {
    const nonce = new Array(32).fill(0);
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [_verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );

    try {
      await program.methods
        .createChallenge(nonce)
        .accountsStrict({
          challenger: provider.wallet.publicKey,
          challenge: challengePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).to.exist;
      expect(err.error.errorCode.number).to.equal(6006);
      expect(err.error.errorCode.code).to.equal("InvalidNonce");
    }
  });
});
