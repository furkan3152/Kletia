pragma circom 2.2.0;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";

template MerkleMembership(depth) {
    signal input leaf;
    signal input root;
    signal input siblings[depth];
    signal input pathIndices[depth];

    signal hashes[depth + 1];
    hashes[0] <== leaf;

    component leftHashes[depth];
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        leftHashes[i] = Poseidon(2);
        leftHashes[i].inputs[0] <==
            hashes[i] + pathIndices[i] * (siblings[i] - hashes[i]);
        leftHashes[i].inputs[1] <==
            siblings[i] + pathIndices[i] * (hashes[i] - siblings[i]);
        hashes[i + 1] <== leftHashes[i].out;
    }
    hashes[depth] === root;
}

template KletiaPolicyV1(depth) {
    // Public inputs. Their exact order is part of the versioned artifact lock.
    signal input workflowRoot;
    signal input policyRoot;
    signal input protocolRegistryRoot;
    signal input assetRegistryRoot;
    signal input recipientPolicyRoot;
    signal input environmentLane;
    signal input executionExpiresAtLedger;
    signal input nullifier;
    signal input executionContextCommitment;

    // Private policy and route witnesses.
    signal input amount;
    signal input minimumAmount;
    signal input maximumAmount;
    signal input policySalt;
    signal input protocolLeaf;
    signal input protocolSiblings[depth];
    signal input protocolPathIndices[depth];
    signal input assetLeaf;
    signal input assetSiblings[depth];
    signal input assetPathIndices[depth];
    signal input recipientLeaf;
    signal input recipientSiblings[depth];
    signal input recipientPathIndices[depth];
    signal input ownerSecret;
    signal input workflowNonce;
    signal input executionContextSalt;

    // LessEqThan constrains a comparison, but the three values must also be
    // independently canonical 64-bit integers. Without these range checks a
    // prover could use field-sized values with a small modular difference.
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

    // Actual expiry is enforced by the Soroban verifier registry against the
    // current ledger. The circuit only binds the committed expiry value.
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

    component protocolMembership = MerkleMembership(depth);
    protocolMembership.leaf <== protocolLeaf;
    protocolMembership.root <== protocolRegistryRoot;
    component assetMembership = MerkleMembership(depth);
    assetMembership.leaf <== assetLeaf;
    assetMembership.root <== assetRegistryRoot;
    component recipientMembership = MerkleMembership(depth);
    recipientMembership.leaf <== recipientLeaf;
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

    // This does not claim that a foreign-chain transaction executed. It binds
    // the hidden planned amount to the exact policy-relevant route leaves and
    // workflow so a later ExecutionReceipt can compare its independently
    // verified result against one immutable context commitment.
    component executionContext = Poseidon(8);
    executionContext.inputs[0] <== amount;
    executionContext.inputs[1] <== protocolLeaf;
    executionContext.inputs[2] <== assetLeaf;
    executionContext.inputs[3] <== recipientLeaf;
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
    environmentLane,
    executionExpiresAtLedger,
    nullifier,
    executionContextCommitment
]} = KletiaPolicyV1(16);
