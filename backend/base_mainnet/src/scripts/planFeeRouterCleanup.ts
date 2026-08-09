import {
    createPublicClient,
    encodeFunctionData,
    http,
    parseAbi,
} from 'viem';
import { base } from 'viem/chains';
import {
    BASE_FEE_ROUTER,
    BASE_FEE_ROUTER_EXPECTED_OWNER,
    BASE_FEE_ROUTER_STALE_TARGETS,
} from '../security/feeRouterPolicy.js';

const publicClient = createPublicClient({
    chain: base,
    transport: http(
        process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org',
    ),
});

const FEE_ROUTER_ADMIN_ABI = parseAbi([
    'function owner() view returns (address)',
    'function approvedTargets(address target) view returns (bool)',
    'function setApprovedTarget(address target, bool isApproved)',
]);

async function main() {
    const blockNumber = await publicClient.getBlockNumber();
    const [chainId, code, owner, staleStates] = await Promise.all([
        publicClient.getChainId(),
        publicClient.getCode({
            address: BASE_FEE_ROUTER,
            blockNumber,
        }),
        publicClient.readContract({
            address: BASE_FEE_ROUTER,
            abi: FEE_ROUTER_ADMIN_ABI,
            functionName: 'owner',
            blockNumber,
        }),
        Promise.all(
            BASE_FEE_ROUTER_STALE_TARGETS.map(
                async ({ id, target, reason }) => ({
                    id,
                    target,
                    reason,
                    approved: await publicClient.readContract({
                        address: BASE_FEE_ROUTER,
                        abi: FEE_ROUTER_ADMIN_ABI,
                        functionName: 'approvedTargets',
                        args: [target],
                        blockNumber,
                    }),
                }),
            ),
        ),
    ]);

    const blockers: string[] = [];
    if (chainId !== 8453) blockers.push(`WRONG_CHAIN:${chainId}`);
    if (!code || code === '0x') blockers.push('FEE_ROUTER_NO_RUNTIME_CODE');
    if (owner.toLowerCase() !== BASE_FEE_ROUTER_EXPECTED_OWNER.toLowerCase()) {
        blockers.push(`FEE_ROUTER_OWNER_MISMATCH:${owner}`);
    }

    const activeStaleTargets = staleStates.filter(({ approved }) => approved);
    const transactions = blockers.length === 0
        ? activeStaleTargets.map(({ id, target, reason }) => ({
            id: `revoke:${id}`,
            chainId: 8453,
            to: BASE_FEE_ROUTER,
            value: '0',
            data: encodeFunctionData({
                abi: FEE_ROUTER_ADMIN_ABI,
                functionName: 'setApprovedTarget',
                args: [target, false],
            }),
            decodedCall: {
                functionName: 'setApprovedTarget',
                args: [target, false],
            },
            reason,
            requiredSender: owner,
            postcondition: {
                functionName: 'approvedTargets',
                args: [target],
                expectedResult: false,
            },
        }))
        : [];

    console.log(JSON.stringify({
        status:
            blockers.length > 0
                ? 'blocked'
                : transactions.length > 0
                    ? 'owner_action_required'
                    : 'already_clean',
        noBroadcast: true,
        signerConfigured: false,
        broadcastCapability: false,
        observedAt: new Date().toISOString(),
        observedBlock: blockNumber.toString(),
        chainId,
        feeRouter: BASE_FEE_ROUTER,
        owner,
        expectedOwner: BASE_FEE_ROUTER_EXPECTED_OWNER,
        staleTargets: staleStates,
        blockers,
        transactions,
        instructions:
            transactions.length > 0
                ? 'Review each exact calldata item in the owner wallet, submit only on Base chain 8453, then rerun verify:base-registry. This script never signs or broadcasts.'
                : 'No stale-target transaction is required.',
    }, null, 2));

    if (blockers.length > 0) process.exitCode = 1;
}

main().catch((error) => {
    console.error(JSON.stringify({
        status: 'unavailable',
        noBroadcast: true,
        name: error instanceof Error ? error.name : 'UnknownError',
        code:
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string'
                ? error.code
                : undefined,
    }));
    process.exitCode = 1;
});
