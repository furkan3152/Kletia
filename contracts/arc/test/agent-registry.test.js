const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const { deploy, mined, reverts, signedRequest } = require("./helpers");

describe("KletiaArcAgentRegistry authorization and discovery", function () {
  let owner, alice, bob, scorer, relayer, forwarder, registry;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, alice, bob, scorer, relayer] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    registry = await deploy("KletiaArcAgentRegistry", forwarder.target);
  });

  function register(signer = alice, changes = {}) {
    return registry.connect(signer).registerAgent(changes.name ?? "Payments Agent", changes.description ?? "Pays approved invoices", changes.skills ?? ["payments", "invoices"], changes.endpoint ?? "https://agent.example/api");
  }

  it("registers discoverable agents and allows only their owner to update active status and metadata", async function () {
    await mined(register());
    assert.equal(await registry.totalAgents(), 1n);
    assert.equal((await registry.getAgent(0)).agentOwner, alice.address);
    assert.deepEqual(Array.from(await registry.getAgentsByOwner(alice.address)), [0n]);
    assert.deepEqual(Array.from(await registry.getAgentsBySkill("payments")), [0n]);
    assert.deepEqual(Array.from(await registry.getAgentSkills(0)), ["payments", "invoices"]);
    await reverts(() => registry.connect(bob).updateAgent(0, "Bad", "Bad", "https://bad.example"), /caller is not agent owner/);
    await mined(registry.connect(alice).updateAgent(0, "Updated", "Updated details", "https://agent.example/v2"));
    assert.equal((await registry.getAgent(0)).name, "Updated");
    await mined(registry.connect(alice).deactivateAgent(0));
    assert.equal((await registry.getAgent(0)).active, false);
    await reverts(() => registry.connect(alice).deactivateAgent(0), /already inactive/);
    await mined(registry.connect(alice).reactivateAgent(0));
    await reverts(() => registry.connect(alice).reactivateAgent(0), /already active/);
    await reverts(() => registry.getAgent(1), /agent does not exist/);
  });

  it("bounds registration inputs without advancing IDs or creating partial skill indexes", async function () {
    for (const [changes, reason] of [
      [{ name: "" }, /name is required/], [{ name: "a".repeat(129) }, /name too long/],
      [{ description: "" }, /description is required/], [{ skills: [] }, /at least one skill/],
      [{ skills: Array(21).fill("pay") }, /too many skills/],
      [{ skills: ["payments", ""] }, /empty skill tag/],
      [{ skills: ["a".repeat(65)] }, /skill tag too long/],
      [{ endpoint: "" }, /endpoint URL is required/],
    ]) {
      await reverts(() => register(alice, changes), reason);
      assert.equal(await registry.nextAgentId(), 0n);
      assert.deepEqual(Array.from(await registry.getAgentsBySkill("payments")), []);
    }
  });

  it("requires authorized scorers and a bounded score, and immediately honors revocation", async function () {
    await mined(register());
    await reverts(() => registry.connect(scorer).updateReputation(0, 100), /not authorized to score/);
    await reverts(() => registry.connect(alice).authorizeScorer(scorer.address), /caller is not the owner/);
    await mined(registry.authorizeScorer(scorer.address));
    await mined(registry.connect(scorer).updateReputation(0, 9900));
    assert.equal((await registry.getAgent(0)).reputation, 9900n);
    await reverts(() => registry.connect(scorer).updateReputation(0, 10001), /score out of range/);
    await mined(registry.revokeScorer(scorer.address));
    await reverts(() => registry.connect(scorer).updateReputation(0, 0), /not authorized to score/);
    await mined(registry.updateReputation(0, 5000));
    assert.equal((await registry.getAgent(0)).reputation, 5000n);
  });

  it("attributes relayed registration to its signer and enforces owner controls after transfer", async function () {
    const data = registry.interface.encodeFunctionData("registerAgent", ["Relayed", "Signed registration", ["payments"], "https://agent.example"]);
    const request = await signedRequest(forwarder, alice, registry, data);
    await mined(forwarder.connect(relayer).execute(request));
    assert.equal((await registry.getAgent(0)).agentOwner, alice.address);
    assert.deepEqual(Array.from(await registry.getAgentsByOwner(relayer.address)), []);
    await reverts(() => registry.connect(bob).transferOwnership(bob.address), /caller is not the owner/);
    await reverts(() => registry.transferOwnership(ethers.ZeroAddress), /invalid new owner/);
    await mined(registry.transferOwnership(bob.address));
    await reverts(() => registry.authorizeScorer(scorer.address), /caller is not the owner/);
    await mined(registry.connect(bob).authorizeScorer(scorer.address));
  });
});
