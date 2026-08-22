import type { Program } from "@anchor-lang/core";
import * as anchor from "@anchor-lang/core";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  transfer,
} from "@solana/spl-token";
import { expect } from "chai";
import type { EntrosAnchor } from "../target/types/entros_anchor";
import type { EntrosRegistry } from "../target/types/entros_registry";
import type { EntrosVerifier } from "../target/types/entros_verifier";
import {
  bootstrapVerifiedUser,
  buildMintReceiptIx,
  buildRebaselineReceiptIx,
  buildResetReceiptIx,
  deriveIdentityPda,
  deriveMintPda,
  fundAccount,
  loadProofFixture,
  TEST_VALIDATOR,
} from "./utils";

describe("entros-anchor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.entrosAnchor as Program<EntrosAnchor>;
  const registry = anchor.workspace.entrosRegistry as Program<EntrosRegistry>;
  const entrosAnchorProgId = program.programId;

  const entrosVerifier = anchor.workspace
    .entrosVerifier as Program<EntrosVerifier>;
  const entrosVerifierProgId = entrosVerifier.programId;
  let trustScore1vrf: number;
  let _trustScore2vrf: number;
  let migrationUser: anchor.web3.Keypair;
  let migrationIdentityPda: anchor.web3.PublicKey;
  let migrationMintPda: anchor.web3.PublicKey;

  const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    entrosAnchorProgId,
  );

  const [protocolConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    registry.programId,
  );

  const [treasuryPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_treasury")],
    registry.programId,
  );

  const commitment = Buffer.alloc(32);
  commitment.write("initial_commitment_test", "utf-8");

  before(async () => {
    // Initialize protocol config (needed for update_anchor trust score computation).
    // Runs before entros-registry tests alphabetically, so we initialize it here.
    try {
      await registry.methods
        .initializeProtocol(
          new anchor.BN(1_000_000_000),
          new anchor.BN(300),
          10000,
          100,
          new anchor.BN(0),
          TEST_VALIDATOR.publicKey,
        )
        .accountsStrict({
          admin: provider.wallet.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch {
      // Already initialized from a previous run
    }
  });

  it("mints an identity anchor", async () => {
    const user = provider.wallet;
    const [identityPda] = deriveIdentityPda(user.publicKey, entrosAnchorProgId);
    const [mintPda] = deriveMintPda(user.publicKey, entrosAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .mintAnchor(Array.from(commitment))
      .accountsStrict({
        user: user.publicKey,
        identityState: identityPda,
        mint: mintPda,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ata,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([buildMintReceiptIx(user.publicKey, commitment)])
      .rpc();

    // Verify IdentityState
    const identity = await program.account.identityState.fetch(identityPda);
    expect(identity.owner.toBase58()).to.equal(user.publicKey.toBase58());
    expect(identity.verificationCount).to.equal(0);
    expect(identity.trustScore).to.equal(0);
    expect(Buffer.from(identity.currentCommitment)).to.deep.equal(commitment);
    expect(identity.mint.toBase58()).to.equal(mintPda.toBase58());

    // Verify token balance
    const tokenAccount = await getAccount(
      provider.connection,
      ata,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(Number(tokenAccount.amount)).to.equal(1);
  });

  it("fails to mint duplicate identity", async () => {
    const user = provider.wallet;
    const [identityPda] = deriveIdentityPda(user.publicKey, entrosAnchorProgId);
    const [mintPda] = deriveMintPda(user.publicKey, entrosAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    try {
      await program.methods
        .mintAnchor(Array.from(commitment))
        .accountsStrict({
          user: user.publicKey,
          identityState: identityPda,
          mint: mintPda,
          mintAuthority: mintAuthorityPda,
          tokenAccount: ata,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([buildMintReceiptIx(user.publicKey, commitment)])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("allows different users to mint their own identity", async () => {
    const user2 = anchor.web3.Keypair.generate();
    await fundAccount(
      provider,
      user2.publicKey,
      5_000_000_000,
    );

    const [identityPda] = deriveIdentityPda(
      user2.publicKey,
      entrosAnchorProgId,
    );
    const [mintPda] = deriveMintPda(user2.publicKey, entrosAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .mintAnchor(Array.from(commitment))
      .accountsStrict({
        user: user2.publicKey,
        identityState: identityPda,
        mint: mintPda,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ata,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([buildMintReceiptIx(user2.publicKey, commitment)])
      .signers([user2])
      .rpc();

    const identity = await program.account.identityState.fetch(identityPda);
    expect(identity.owner.toBase58()).to.equal(user2.publicKey.toBase58());
  });

  it("rejects a mint with no validator receipt (fail closed)", async () => {
    // ProtocolConfig.validator_pubkey is configured, so receipt verification
    // enforces: a mint_anchor with no preceding Ed25519 receipt instruction
    // must be rejected (MissingValidatorReceipt), never silently allowed.
    const user3 = anchor.web3.Keypair.generate();
    await fundAccount(provider, user3.publicKey, 2_000_000_000);
    const [identityPda] = deriveIdentityPda(user3.publicKey, entrosAnchorProgId);
    const [mintPda] = deriveMintPda(user3.publicKey, entrosAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user3.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    try {
      await program.methods
        .mintAnchor(Array.from(commitment))
        .accountsStrict({
          user: user3.publicKey,
          identityState: identityPda,
          mint: mintPda,
          mintAuthority: mintAuthorityPda,
          tokenAccount: ata,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // Deliberately no preInstructions → no preceding receipt.
        .signers([user3])
        .rpc();
      expect.fail("mint without a validator receipt should be rejected");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("updates identity state with bound proof + auto-computed trust score", async () => {
    const fixture = loadProofFixture();
    const user = anchor.web3.Keypair.generate();
    await fundAccount(provider, user.publicKey, 3_000_000_000);

    const boot = await bootstrapVerifiedUser({
      user,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    const newCommitment = Buffer.from(fixture.public_inputs[0]);

    await program.methods
      .updateAnchor(Array.from(newCommitment), boot.nonce)
      .accountsStrict({
        authority: user.publicKey,
        identityState: boot.identityPda,
        verificationResult: boot.verificationPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const identity = await program.account.identityState.fetch(
      boot.identityPda,
    );
    expect(identity.verificationCount).to.equal(1);
    expect(identity.trustScore).to.be.greaterThanOrEqual(100);
    expect(Buffer.from(identity.currentCommitment)).to.deep.equal(
      newCommitment,
    );
    trustScore1vrf = identity.trustScore;
  });

  it("rejects update from unauthorized wallet (ownership check)", async () => {
    // Victim sets up a legit identity + VR
    const fixture = loadProofFixture();
    const victim = anchor.web3.Keypair.generate();
    await fundAccount(provider, victim.publicKey, 3_000_000_000);
    const boot = await bootstrapVerifiedUser({
      user: victim,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    // The attacker tries to update the victim's identity. The request must fail at the
    // VerificationResult seeds derivation (attacker.pubkey != VR.verifier) and
    // at the Unauthorized ownership check.
    const attacker = anchor.web3.Keypair.generate();
    await fundAccount(provider, attacker.publicKey, 2_000_000_000);
    const fakeCommitment = Buffer.from(fixture.public_inputs[0]);

    try {
      await program.methods
        .updateAnchor(Array.from(fakeCommitment), boot.nonce)
        .accountsStrict({
          authority: attacker.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown: unauthorized update");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("charges verification fee on update_anchor", async () => {
    // Set verification fee to 5_000_000 lamports (0.005 SOL)
    await registry.methods
      .updateProtocolConfig(new anchor.BN(5_000_000))
      .accountsStrict({
        admin: provider.wallet.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    try {
      const fixture = loadProofFixture();
      const user = anchor.web3.Keypair.generate();
      await fundAccount(provider, user.publicKey, 3_000_000_000);

      const boot = await bootstrapVerifiedUser({
        user,
        entrosAnchor: program,
        entrosVerifier,
        fixture,
        protocolConfigPda,
        treasuryPda,
        mintAuthorityPda,
      });

      const treasuryBefore = await provider.connection.getBalance(treasuryPda);

      await program.methods
        .updateAnchor(
          Array.from(Buffer.from(fixture.public_inputs[0])),
          boot.nonce,
        )
        .accountsStrict({
          authority: user.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const treasuryAfter = await provider.connection.getBalance(treasuryPda);
      expect(treasuryAfter).to.equal(treasuryBefore + 5_000_000);
    } finally {
      // Reset fee to 0 regardless of test outcome
      await registry.methods
        .updateProtocolConfig(new anchor.BN(0))
        .accountsStrict({
          admin: provider.wallet.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    }
  });

  // Verification-result binding security tests

  it("rejects reusing the same VerificationResult twice", async () => {
    const fixture = loadProofFixture();
    const user = anchor.web3.Keypair.generate();
    await fundAccount(provider, user.publicKey, 3_000_000_000);

    const boot = await bootstrapVerifiedUser({
      user,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    const newCommitment = Array.from(Buffer.from(fixture.public_inputs[0]));

    // First update consumes the VR successfully
    await program.methods
      .updateAnchor(newCommitment, boot.nonce)
      .accountsStrict({
        authority: user.publicKey,
        identityState: boot.identityPda,
        verificationResult: boot.verificationPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Second attempt with the SAME VR: commitment_prev still equals fixture[1]
    // but identity.current_commitment has rotated to fixture[0]. Reject.
    try {
      await program.methods
        .updateAnchor(newCommitment, boot.nonce)
        .accountsStrict({
          authority: user.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail(
        "Should have thrown: verification result already consumed",
      );
    } catch (err: any) {
      expect(err).to.exist;
      // The VerificationResult was already consumed, so its commitment_prev no
      // longer matches the identity's head.
      expect(String(err)).to.match(/PrevCommitmentMismatch|6011/);
    }
  });

  it("rejects update where submitted new_commitment doesn't match VR.commitment_new", async () => {
    const fixture = loadProofFixture();
    const user = anchor.web3.Keypair.generate();
    await fundAccount(provider, user.publicKey, 3_000_000_000);

    const boot = await bootstrapVerifiedUser({
      user,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    // Submit a DIFFERENT new_commitment than what the proof attested to
    const maliciousCommitment = Buffer.alloc(32, 0xaa);

    try {
      await program.methods
        .updateAnchor(Array.from(maliciousCommitment), boot.nonce)
        .accountsStrict({
          authority: user.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have thrown: CommitmentMismatch");
    } catch (err: any) {
      expect(err).to.exist;
      expect(String(err)).to.match(/CommitmentMismatch|6010/);
    }
  });

  it("rejects update when authority tries to use another user's VerificationResult", async () => {
    const fixture = loadProofFixture();
    // User A bootstraps their own VR
    const userA = anchor.web3.Keypair.generate();
    await fundAccount(provider, userA.publicKey, 3_000_000_000);
    const bootA = await bootstrapVerifiedUser({
      user: userA,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    // User B mints independently
    const userB = anchor.web3.Keypair.generate();
    await fundAccount(provider, userB.publicKey, 3_000_000_000);
    const [identityPdaB] = deriveIdentityPda(
      userB.publicKey,
      entrosAnchorProgId,
    );
    const [mintPdaB] = deriveMintPda(userB.publicKey, entrosAnchorProgId);
    const ataB = getAssociatedTokenAddressSync(
      mintPdaB,
      userB.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    await program.methods
      .mintAnchor(Array.from(Buffer.from(fixture.public_inputs[1])))
      .accountsStrict({
        user: userB.publicKey,
        identityState: identityPdaB,
        mint: mintPdaB,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ataB,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        buildMintReceiptIx(
          userB.publicKey,
          Buffer.from(fixture.public_inputs[1]),
        ),
      ])
      .signers([userB])
      .rpc();

    // B tries to update own identity using A's VerificationResult.
    // The VR PDA is seeded on A's pubkey + nonce; B passing A's VR won't match
    // B's seeds derivation, causing Anchor to reject with ConstraintSeeds.
    try {
      await program.methods
        .updateAnchor(
          Array.from(Buffer.from(fixture.public_inputs[0])),
          bootA.nonce,
        )
        .accountsStrict({
          authority: userB.publicKey,
          identityState: identityPdaB,
          verificationResult: bootA.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([userB])
        .rpc();
      expect.fail("Should have thrown: one wallet cannot use another wallet's verification result");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects transfer of non-transferable token", async () => {
    const user = provider.wallet;
    const [mintPda] = deriveMintPda(user.publicKey, entrosAnchorProgId);
    const sourceAta = getAssociatedTokenAddressSync(
      mintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const recipient = anchor.web3.Keypair.generate();
    await fundAccount(
      provider,
      recipient.publicKey,
      1_000_000_000,
    );

    const destAta = getAssociatedTokenAddressSync(
      mintPda,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    try {
      await transfer(
        provider.connection,
        (provider.wallet as any).payer,
        sourceAta,
        destAta,
        user.publicKey,
        1,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect.fail("Transfer should have been rejected");
    } catch (err: any) {
      // Token-2022 NonTransferable extension rejects transfers
      expect(err).to.exist;
    }
  });

  // Same-day dedup is covered by the recency_score computation in update_anchor.
  // Each update requires a fresh proof bound to the
  // specific commitment transition, so multi-update tests in-session need
  // multiple proof fixtures (see circuits/scripts/generate_test_fixture.ts).
  // The single-update trust_score value is asserted in the "updates identity
  // state with bound proof" test above. Multi-update dedup is exercised by
  // the full E2E flow in z-e2e.ts and by on-devnet integration testing.
  it("records trust_score for a single verification via bound proof", async () => {
    // Documents what a first verification produces; smoke check that the
    // trust_score isn't zero post-update. The previous multi-update variant
    // is removed pending multi-fixture support.
    expect(trustScore1vrf).to.be.greaterThan(0);
  });

  it("moves a legacy identity into the configured projection without changing reputation", async () => {
    const fixture = loadProofFixture();
    migrationUser = anchor.web3.Keypair.generate();
    await fundAccount(provider, migrationUser.publicKey, 5_000_000_000);
    const boot = await bootstrapVerifiedUser({
      user: migrationUser,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });
    migrationIdentityPda = boot.identityPda;
    migrationMintPda = boot.mintPda;

    await program.methods
      .updateAnchor(
        Array.from(Buffer.from(fixture.public_inputs[0])),
        boot.nonce,
      )
      .accountsStrict({
        authority: migrationUser.publicKey,
        identityState: boot.identityPda,
        verificationResult: boot.verificationPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([migrationUser])
      .rpc();

    const staleUser = anchor.web3.Keypair.generate();
    await fundAccount(provider, staleUser.publicKey, 4_000_000_000);
    const staleBoot = await bootstrapVerifiedUser({
      user: staleUser,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    await registry.methods
      .setProjectionVersions(1, 1)
      .accountsStrict({
        admin: provider.wallet.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .updateAnchor(
          Array.from(Buffer.from(fixture.public_inputs[0])),
          staleBoot.nonce,
        )
        .accountsStrict({
          authority: staleUser.publicKey,
          identityState: staleBoot.identityPda,
          verificationResult: staleBoot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([staleUser])
        .rpc();
      expect.fail("a version-zero identity must rebaseline before updating");
    } catch (err: unknown) {
      expect(String(err)).to.match(/ProjectionVersionTooOld/);
    }

    const identityBefore = await program.account.identityState.fetch(
      migrationIdentityPda,
    );
    const newCommitment = Buffer.alloc(32, 0xbb);

    try {
      await program.methods
        .rebaselineAnchor(Array.from(newCommitment), 0)
        .accountsStrict({
          authority: migrationUser.publicKey,
          identityState: migrationIdentityPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .preInstructions([
          buildRebaselineReceiptIx(migrationUser.publicKey, newCommitment, 1),
        ])
        .signers([migrationUser])
        .rpc();
      expect.fail("rebaseline accepted a stale requested projection version");
    } catch (err: unknown) {
      expect(String(err)).to.match(/ProjectionVersionMismatch/);
    }

    for (const invalidReceipt of [
      buildMintReceiptIx(migrationUser.publicKey, newCommitment, 1),
      buildRebaselineReceiptIx(migrationUser.publicKey, newCommitment, 2),
      buildMintReceiptIx(migrationUser.publicKey, newCommitment),
    ]) {
      try {
        await program.methods
          .rebaselineAnchor(Array.from(newCommitment), 1)
          .accountsStrict({
            authority: migrationUser.publicKey,
            identityState: migrationIdentityPda,
            protocolConfig: protocolConfigPda,
            treasury: treasuryPda,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .preInstructions([invalidReceipt])
          .signers([migrationUser])
          .rpc();
        expect.fail("rebaseline accepted a receipt with the wrong binding");
      } catch (err: unknown) {
        expect(String(err)).to.match(
          /ReceiptPurposeMismatch|ReceiptProjectionVersionMismatch|ReceiptVersionMismatch/,
        );
      }
    }

    await program.methods
      .rebaselineAnchor(Array.from(newCommitment), 1)
      .accountsStrict({
        authority: migrationUser.publicKey,
        identityState: migrationIdentityPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([
        buildRebaselineReceiptIx(migrationUser.publicKey, newCommitment, 1),
      ])
      .signers([migrationUser])
      .rpc();

    const identityAfter = await program.account.identityState.fetch(
      migrationIdentityPda,
    );
    expect(identityAfter.projectionVersion).to.equal(1);
    expect(Buffer.from(identityAfter.currentCommitment)).to.deep.equal(
      newCommitment,
    );
    expect(identityAfter.trustScore).to.equal(identityBefore.trustScore);
    expect(identityAfter.verificationCount).to.equal(
      identityBefore.verificationCount,
    );
    expect(identityAfter.recentTimestamps).to.deep.equal(
      identityBefore.recentTimestamps,
    );

    try {
      await program.methods
        .rebaselineAnchor(Array.from(Buffer.alloc(32, 0xcc)), 1)
        .accountsStrict({
          authority: migrationUser.publicKey,
          identityState: migrationIdentityPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .preInstructions([
          buildRebaselineReceiptIx(
            migrationUser.publicKey,
            Buffer.alloc(32, 0xcc),
            1,
          ),
        ])
        .signers([migrationUser])
        .rpc();
      expect.fail("rebaseline must advance the projection version");
    } catch (err: unknown) {
      expect(String(err)).to.match(/ProjectionVersionNotAdvanced/);
    }
  });

  it("derives the current projection when minting", async () => {
    const user = anchor.web3.Keypair.generate();
    await fundAccount(provider, user.publicKey, 3_000_000_000);
    const [identityPda] = deriveIdentityPda(user.publicKey, entrosAnchorProgId);
    const [mintPda] = deriveMintPda(user.publicKey, entrosAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const currentCommitment = Buffer.alloc(32, 0xdd);

    try {
      await program.methods
        .mintAnchor(Array.from(currentCommitment))
        .accountsStrict({
          user: user.publicKey,
          identityState: identityPda,
          mint: mintPda,
          mintAuthority: mintAuthorityPda,
          tokenAccount: ata,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([buildMintReceiptIx(user.publicKey, currentCommitment)])
        .signers([user])
        .rpc();
      expect.fail("projection-one mint accepted a legacy receipt");
    } catch (err: unknown) {
      expect(String(err)).to.match(/ReceiptVersionMismatch/);
    }

    await program.methods
      .mintAnchor(Array.from(currentCommitment))
      .accountsStrict({
        user: user.publicKey,
        identityState: identityPda,
        mint: mintPda,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ata,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        buildMintReceiptIx(user.publicKey, currentCommitment, 1),
      ])
      .signers([user])
      .rpc();

    const identity = await program.account.identityState.fetch(identityPda);
    expect(identity.projectionVersion).to.equal(1);
  });

  it("rejects a replayed VerificationResult whose commitment_prev is stale", async () => {
    const fixture = loadProofFixture();
    const user = anchor.web3.Keypair.generate();
    await fundAccount(provider, user.publicKey, 5_000_000_000);
    const boot = await bootstrapVerifiedUser({
      user,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
      projectionVersion: 1,
    });

    const newCommitment1 = Buffer.from(fixture.public_inputs[0]);

    // First update (successful)
    const nonce1 = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
    const [verificationPda1] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("verification"), user.publicKey.toBuffer(), Buffer.from(nonce1)],
      entrosVerifier.programId
    );
    const [challengePda1] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("challenge"), user.publicKey.toBuffer(), Buffer.from(nonce1)],
      entrosVerifier.programId
    );
    await entrosVerifier.methods.createChallenge(nonce1).accountsStrict({ challenger: user.publicKey, challenge: challengePda1, systemProgram: anchor.web3.SystemProgram.programId }).signers([user]).rpc();
    await entrosVerifier.methods.verifyProof(Buffer.from(fixture.proof_bytes), fixture.public_inputs, nonce1).accountsStrict({ verifier: user.publicKey, challenge: challengePda1, verificationResult: verificationPda1, systemProgram: anchor.web3.SystemProgram.programId }).signers([user]).rpc();

    await program.methods
      .updateAnchor(Array.from(newCommitment1), nonce1)
      .accountsStrict({
        authority: user.publicKey,
        identityState: boot.identityPda,
        verificationResult: verificationPda1,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Second update. Nothing rate limits verifications on chain, so this
    // reaches the commitment check and fails there: the fixture is replayed,
    // so its commitment_prev still points at the pre-first-update head.
    const nonce2 = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
    const [verificationPda2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("verification"), user.publicKey.toBuffer(), Buffer.from(nonce2)],
      entrosVerifier.programId
    );
    const [challengePda2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("challenge"), user.publicKey.toBuffer(), Buffer.from(nonce2)],
      entrosVerifier.programId
    );
    await entrosVerifier.methods.createChallenge(nonce2).accountsStrict({ challenger: user.publicKey, challenge: challengePda2, systemProgram: anchor.web3.SystemProgram.programId }).signers([user]).rpc();
    await entrosVerifier.methods.verifyProof(Buffer.from(fixture.proof_bytes), fixture.public_inputs, nonce2).accountsStrict({ verifier: user.publicKey, challenge: challengePda2, verificationResult: verificationPda2, systemProgram: anchor.web3.SystemProgram.programId }).signers([user]).rpc();

    try {
      await program.methods
        .updateAnchor(Array.from(newCommitment1), nonce2)
        .accountsStrict({
          authority: user.publicKey,
          identityState: boot.identityPda,
          verificationResult: verificationPda2,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have failed on a stale commitment_prev");
    } catch (err: any) {
      expect(err).to.exist;
      expect(String(err)).to.match(/PrevCommitmentMismatch|6011/);
    }
  });

  it("preserves projection state and reputation during wallet migration", async () => {
    const identityBefore = await program.account.identityState.fetch(
      migrationIdentityPda,
    );
    const newWallet = anchor.web3.Keypair.generate();
    await fundAccount(provider, newWallet.publicKey, 5_000_000_000);

    const oldTokenAccount = getAssociatedTokenAddressSync(
      migrationMintPda,
      migrationUser.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .authorizeNewWallet()
      .accountsStrict({
        signer: migrationUser.publicKey,
        identityState: migrationIdentityPda,
        signerNew: newWallet.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        mint: migrationMintPda,
        tokenAccount: oldTokenAccount,
      })
      .signers([migrationUser, newWallet])
      .rpc();

    const [newIdentityPda] = deriveIdentityPda(
      newWallet.publicKey,
      entrosAnchorProgId,
    );
    const [newMintPda] = deriveMintPda(
      newWallet.publicKey,
      entrosAnchorProgId,
    );
    const newTokenAccount = getAssociatedTokenAddressSync(
      newMintPda,
      newWallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .migrateIdentity()
      .accountsStrict({
        user: newWallet.publicKey,
        identityState: newIdentityPda,
        mint: newMintPda,
        mintAuthority: mintAuthorityPda,
        tokenAccount: newTokenAccount,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        walletOld: migrationUser.publicKey,
        identityStateOld: migrationIdentityPda,
        mintOld: migrationMintPda,
        tokenAccountOld: oldTokenAccount,
      })
      .signers([newWallet])
      .rpc();

    const identityAfter = await program.account.identityState.fetch(
      newIdentityPda,
    );
    expect(identityAfter.projectionVersion).to.equal(
      identityBefore.projectionVersion,
    );
    expect(identityAfter.lastRebaselineTimestamp.toString()).to.equal(
      identityBefore.lastRebaselineTimestamp.toString(),
    );
    expect(identityAfter.trustScore).to.equal(identityBefore.trustScore);
    expect(identityAfter.verificationCount).to.equal(
      identityBefore.verificationCount,
    );
    expect(identityAfter.creationTimestamp.toString()).to.equal(
      identityBefore.creationTimestamp.toString(),
    );

    migrationUser = newWallet;
    migrationIdentityPda = newIdentityPda;
    migrationMintPda = newMintPda;
  });

  it("derives the current projection during reset and keeps the rebaseline cooldown", async () => {
    await registry.methods
      .setProjectionVersions(2, 1)
      .accountsStrict({
        admin: provider.wallet.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const rebaselineCommitment = Buffer.alloc(32, 0xee);
    try {
      await program.methods
        .rebaselineAnchor(Array.from(rebaselineCommitment), 2)
        .accountsStrict({
          authority: migrationUser.publicKey,
          identityState: migrationIdentityPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .preInstructions([
          buildRebaselineReceiptIx(
            migrationUser.publicKey,
            rebaselineCommitment,
            2,
          ),
        ])
        .signers([migrationUser])
        .rpc();
      expect.fail("rebaseline ignored its cooldown after wallet migration");
    } catch (err: unknown) {
      expect(String(err)).to.match(/RebaselineCooldownActive/);
    }

    const resetCommitment = Buffer.alloc(32, 0xf0);
    try {
      await program.methods
        .resetIdentityState(Array.from(resetCommitment), 1)
        .accountsStrict({
          authority: migrationUser.publicKey,
          identityState: migrationIdentityPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            isSigner: false,
            isWritable: false,
          },
        ])
        .signers([migrationUser])
        .rpc();
      expect.fail("reset accepted a stale requested projection version");
    } catch (err: unknown) {
      expect(String(err)).to.match(/ProjectionVersionMismatch/);
    }

    try {
      await program.methods
        .resetIdentityState(Array.from(resetCommitment), 2)
        .accountsStrict({
          authority: migrationUser.publicKey,
          identityState: migrationIdentityPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            isSigner: false,
            isWritable: false,
          },
        ])
        .signers([migrationUser])
        .rpc();
      expect.fail("reset accepted no validator receipt");
    } catch (err: unknown) {
      expect(String(err)).to.match(/MissingValidatorReceipt/);
    }

    try {
      await program.methods
        .resetIdentityState(Array.from(resetCommitment), 2)
        .accountsStrict({
          authority: migrationUser.publicKey,
          identityState: migrationIdentityPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            isSigner: false,
            isWritable: false,
          },
        ])
        .preInstructions([
          buildRebaselineReceiptIx(
            migrationUser.publicKey,
            resetCommitment,
            2,
          ),
        ])
        .signers([migrationUser])
        .rpc();
      expect.fail("reset accepted a rebaseline receipt");
    } catch (err: unknown) {
      expect(String(err)).to.match(/ReceiptPurposeMismatch/);
    }

    for (const [invalidReceipt, expectedError] of [
      [
        buildResetReceiptIx(
          anchor.web3.Keypair.generate().publicKey,
          resetCommitment,
          2,
        ),
        /ReceiptWalletMismatch/,
      ],
      [
        buildResetReceiptIx(migrationUser.publicKey, resetCommitment, 3),
        /ReceiptProjectionVersionMismatch/,
      ],
    ] as const) {
      try {
        await program.methods
          .resetIdentityState(Array.from(resetCommitment), 2)
          .accountsStrict({
            authority: migrationUser.publicKey,
            identityState: migrationIdentityPda,
            protocolConfig: protocolConfigPda,
            treasury: treasuryPda,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
              isSigner: false,
              isWritable: false,
            },
          ])
          .preInstructions([invalidReceipt])
          .signers([migrationUser])
          .rpc();
        expect.fail("reset accepted a receipt with the wrong binding");
      } catch (err: unknown) {
        expect(String(err)).to.match(expectedError);
      }
    }

    try {
      await program.methods
        .resetIdentityState(Array.from(resetCommitment), 2)
        .accountsStrict({
          authority: migrationUser.publicKey,
          identityState: migrationIdentityPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            isSigner: false,
            isWritable: false,
          },
        ])
        .preInstructions([
          buildResetReceiptIx(
            migrationUser.publicKey,
            resetCommitment,
            2,
            1,
          ),
        ])
        .signers([migrationUser])
        .rpc();
      expect.fail("reset accepted an expired validator receipt");
    } catch (err: unknown) {
      expect(String(err)).to.match(/ReceiptExpired/);
    }

    await program.methods
      .resetIdentityState(Array.from(resetCommitment), 2)
      .accountsStrict({
        authority: migrationUser.publicKey,
        identityState: migrationIdentityPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
      ])
      .preInstructions([
        buildResetReceiptIx(migrationUser.publicKey, resetCommitment, 2),
      ])
      .signers([migrationUser])
      .rpc();

    const identityAfter = await program.account.identityState.fetch(
      migrationIdentityPda,
    );
    expect(identityAfter.projectionVersion).to.equal(2);
    expect(identityAfter.verificationCount).to.equal(0);
    expect(identityAfter.trustScore).to.equal(0);
    expect(Buffer.from(identityAfter.currentCommitment)).to.deep.equal(
      resetCommitment,
    );
  });
});
