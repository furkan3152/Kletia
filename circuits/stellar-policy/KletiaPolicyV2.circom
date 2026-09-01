pragma circom 2.2.0;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";

template KletiaMerkleMembershipV2(depth) {
    signal input selectedLeaf;
    signal input root;
    signal input siblings[depth];
    signal input pathIndices[depth];

    signal hashes[depth + 1];
    hashes[0] <== selectedLeaf;

    component nodes[depth];
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        nodes[i] = Poseidon(2);
        nodes[i].inputs[0] <==
            hashes[i] + pathIndices[i] * (siblings[i] - hashes[i]);
        nodes[i].inputs[1] <==
            siblings[i] + pathIndices[i] * (hashes[i] - siblings[i]);
        hashes[i + 1] <== nodes[i].out;
    }
    hashes[depth] === root;
}

/**
 * Policy V2 separates a policy that is approved before route selection from
 * the exact route selected later.
 *
 * The three selected leaves are public. Kletia derives them again from the
 * exact route, asset and execution recipient before accepting the proof. The
 * private Merkle paths only prove those public leaves belong to the roots that
 * were already bound into the user-authorized policyRoot. This closes the V1
 * gap where a prover could use a different allowed leaf without exposing which
 * leaf was actually proven.
 */
template KletiaPolicyV2(depth) {
    // Public inputs. Order is part of the versioned verifier artifact.
    signal input workflowRoot;
    signal input policyRoot;
    signal input protocolRegistryRoot;
    signal input assetRegistryRoot;
    signal input recipientPolicyRoot;
    signal input selectedProtocolLeaf;
    signal input selectedAssetLeaf;
    signal input selectedRecipientLeaf;
    signal input environmentLane;
    signal input executionExpiresAtLedger;
    signal input nullifier;
    signal input executionContextCommitment;

    // Private policy and execution witnesses.
    signal input amount;
    signal input minimumAmount;
    signal input maximumAmount;
    signal input policySalt;
    signal input protocolSiblings[depth];
    signal input protocolPathIndices[depth];
    signal input assetSiblings[depth];
    signal input assetPathIndices[depth];
    signal input recipientSiblings[depth];
    signal input recipientPathIndices[depth];
    signal input ownerSecret;
    signal input workflowNonce;
    signal input executionContextSalt;

    component amountBits = Num2Bits(64);
    amountBits.in <== amount;
    component minimumAmountBits = Num2Bits(64);
    minimumAmountBits.in <== minimumAmount;
    component maximumAmountBits = Num2Bits(64);
    maximumAmountBits.in <== maximumAmount;

    component amountAboveFloor = LessEqThan(64);
    amountAboveFloor.in[0] <== minimumAmount;
    amountAboveFloor.in[1] <== amount;
    amountAboveFloor.out === 1;

    component amountWithinCap = LessEqThan(64);
    amountWithinCap.in[0] <== amount;
    amountWithinCap.in[1] <== maximumAmount;
    amountWithinCap.out === 1;

    environmentLane * (environmentLane - 1) === 0;

    component policyCommitment = Poseidon(8);
    policyCommitment.inputs[0] <== minimumAmount;
    policyCommitment.inputs[1] <== maximumAmount;
    policyCommitment.inputs[2] <== environmentLane;
    policyCommitment.inputs[3] <== executionExpiresAtLedger;
    policyCommitment.inputs[4] <== protocolRegistryRoot;
    policyCommitment.inputs[5] <== assetRegistryRoot;
    policyCommitment.inputs[6] <== recipientPolicyRoot;
    policyCommitment.inputs[7] <== policySalt;
    policyCommitment.out === policyRoot;

    component protocolMembership = KletiaMerkleMembershipV2(depth);
    protocolMembership.selectedLeaf <== selectedProtocolLeaf;
    protocolMembership.root <== protocolRegistryRoot;
    component assetMembership = KletiaMerkleMembershipV2(depth);
    assetMembership.selectedLeaf <== selectedAssetLeaf;
    assetMembership.root <== assetRegistryRoot;
    component recipientMembership = KletiaMerkleMembershipV2(depth);
    recipientMembership.selectedLeaf <== selectedRecipientLeaf;
    recipientMembership.root <== recipientPolicyRoot;
    for (var i = 0; i < depth; i++) {
        protocolMembership.siblings[i] <== protocolSiblings[i];
        protocolMembership.pathIndices[i] <== protocolPathIndices[i];
        assetMembership.siblings[i] <== assetSiblings[i];
        assetMembership.pathIndices[i] <== assetPathIndices[i];
        recipientMembership.siblings[i] <== recipientSiblings[i];
        recipientMembership.pathIndices[i] <== recipientPathIndices[i];
    }

    component nullifierCommitment = Poseidon(4);
    nullifierCommitment.inputs[0] <== ownerSecret;
    nullifierCommitment.inputs[1] <== workflowRoot;
    nullifierCommitment.inputs[2] <== workflowNonce;
    nullifierCommitment.inputs[3] <== policyRoot;
    nullifierCommitment.out === nullifier;

    component executionContext = Poseidon(8);
    executionContext.inputs[0] <== amount;
    executionContext.inputs[1] <== selectedProtocolLeaf;
    executionContext.inputs[2] <== selectedAssetLeaf;
    executionContext.inputs[3] <== selectedRecipientLeaf;
    executionContext.inputs[4] <== environmentLane;
    executionContext.inputs[5] <== executionExpiresAtLedger;
    executionContext.inputs[6] <== workflowRoot;
    executionContext.inputs[7] <== executionContextSalt;
    executionContext.out === executionContextCommitment;
}

component main {public [
    workflowRoot,
    policyRoot,
    protocolRegistryRoot,
    assetRegistryRoot,
    recipientPolicyRoot,
    selectedProtocolLeaf,
    selectedAssetLeaf,
    selectedRecipientLeaf,
    environmentLane,
    executionExpiresAtLedger,
    nullifier,
    executionContextCommitment
]} = KletiaPolicyV2(16);
