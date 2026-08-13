# BridgeIntent V2 signing specification

`IKletiaIntentTypesV2.BridgeIntent` is reserved for a future bridge settlement
module. Its EIP-712 primary type is:

```text
BridgeIntent(address owner,address tokenIn,uint256 amountIn,uint256 destinationChainId,bytes32 destinationToken,bytes32 recipient,uint256 minAmountOut,address adapter,bytes32 adapterConfigHash,bytes32 adapterDataHash,uint256 nonce,uint48 issuedAt,uint48 validAfter,uint48 deadline,address executor,uint16 maxFeeBps)
```

The `bytes32` destination token and recipient fields avoid assuming that every
destination is EVM-addressed. The type hash differs from `SwapIntent`, while the
EIP-712 domain binds chain ID and verifying contract, preventing a bridge
signature from authorizing a swap or a different router deployment.

This specification is non-executable. A future implementation must, at minimum,
bind and validate depositor, destination chain, input/output tokens, exact input,
minimum destination output, destination recipient, quote time, fill deadline,
exclusivity parameters, message hash, adapter data, and protocol version. Origin
deposit success must never be represented as destination settlement.
