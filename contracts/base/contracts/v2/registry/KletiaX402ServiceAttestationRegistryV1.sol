// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

contract KletiaX402ServiceAttestationRegistryV1 is Ownable2Step {
    uint48 public constant MAX_ATTESTATION_HORIZON = 180 days;
    bytes32 public constant ATTESTATION_SCHEMA =
        keccak256(
            "KletiaX402ServiceAttestationV1(bytes32 serviceId,bytes32 manifestDigest,address publisher,address payTo,bytes32 publisherDataHash)"
        );

    enum AttestationKind {
        None,
        Publisher,
        Curator
    }

    enum AttestationStatus {
        None,
        Active,
        Expired,
        Revoked,
        AttesterDisabled,
        StaleAuthorization
    }

    struct ServiceClaim {
        bytes32 serviceId;
        bytes32 manifestDigest;
        address publisher;
        address payTo;
        bytes32 publisherDataHash;
    }

    struct Attestation {
        uint48 issuedAt;
        uint48 expiresAt;
        uint48 revokedAt;
        uint64 authorizationEpoch;
        AttestationKind kind;
    }

    address public guardian;
    mapping(address curator => bool allowed) public isCurator;
    mapping(address curator => uint64 epoch) public curatorAuthorizationEpoch;
    mapping(bytes32 attestationKey => mapping(address attester => Attestation record))
        private _attestations;

    error InvalidClaim();
    error InvalidAddress();
    error InvalidExpiry(uint48 supplied, uint48 earliestExclusive, uint48 latestInclusive);
    error UnauthorizedCurator(address caller);
    error UnauthorizedGuardian(address caller);
    error CuratorCannotAttestOwnClaim();
    error AttestationNotFound(bytes32 attestationKey, address attester);
    error AttestationAlreadyRevoked(bytes32 attestationKey, address attester);
    error OwnershipRenunciationDisabled();

    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event CuratorAuthorizationUpdated(
        address indexed curator,
        bool allowed,
        uint64 authorizationEpoch,
        address indexed account
    );
    event ServiceAttestationRecorded(
        bytes32 indexed attestationKey,
        bytes32 indexed serviceId,
        address indexed attester,
        AttestationKind kind,
        bytes32 manifestDigest,
        address publisher,
        address payTo,
        bytes32 publisherDataHash,
        uint48 issuedAt,
        uint48 expiresAt,
        uint64 authorizationEpoch
    );
    event ServiceAttestationRevoked(
        bytes32 indexed attestationKey,
        address indexed attester,
        uint48 revokedAt
    );

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) {
            revert UnauthorizedGuardian(msg.sender);
        }
        _;
    }

    constructor(
        address initialOwner,
        address initialGuardian
    ) Ownable(initialOwner) {
        if (initialGuardian == address(0)) revert InvalidAddress();
        guardian = initialGuardian;
        emit GuardianUpdated(address(0), initialGuardian);
    }

    function attestationKey(ServiceClaim calldata claim) public view returns (bytes32) {
        _validateClaim(claim);
        return
            keccak256(
                abi.encode(
                    ATTESTATION_SCHEMA,
                    claim.serviceId,
                    claim.manifestDigest,
                    claim.publisher,
                    claim.payTo,
                    claim.publisherDataHash
                )
            );
    }

    function attestAsPublisher(
        bytes32 serviceId,
        bytes32 manifestDigest,
        address payTo,
        bytes32 publisherDataHash,
        uint48 expiresAt
    ) external returns (bytes32 key) {
        ServiceClaim memory claim = ServiceClaim({
            serviceId: serviceId,
            manifestDigest: manifestDigest,
            publisher: msg.sender,
            payTo: payTo,
            publisherDataHash: publisherDataHash
        });
        key = _record(claim, AttestationKind.Publisher, expiresAt);
    }

    function attestAsCurator(
        ServiceClaim calldata claim,
        uint48 expiresAt
    ) external returns (bytes32 key) {
        if (!isCurator[msg.sender]) revert UnauthorizedCurator(msg.sender);
        if (claim.publisher == msg.sender) revert CuratorCannotAttestOwnClaim();
        key = _record(claim, AttestationKind.Curator, expiresAt);
    }

    function revoke(bytes32 key) external {
        Attestation storage record = _attestations[key][msg.sender];
        if (record.kind == AttestationKind.None) {
            revert AttestationNotFound(key, msg.sender);
        }
        if (record.revokedAt != 0) {
            revert AttestationAlreadyRevoked(key, msg.sender);
        }
        uint48 revokedAt = uint48(block.timestamp);
        record.revokedAt = revokedAt;
        emit ServiceAttestationRevoked(key, msg.sender, revokedAt);
    }

    function getAttestation(
        bytes32 key,
        address attester
    ) external view returns (Attestation memory record, AttestationStatus status) {
        record = _attestations[key][attester];
        status = _status(record, attester);
    }

    function attestationStatus(
        bytes32 key,
        address attester
    ) external view returns (AttestationStatus) {
        return _status(_attestations[key][attester], attester);
    }

    function setCurator(address curator, bool allowed) external onlyOwner {
        _setCurator(curator, allowed);
    }

    function disableCurator(
        address curator
    ) external onlyGuardianOrOwner {
        _setCurator(curator, false);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidAddress();
        address previousGuardian = guardian;
        guardian = newGuardian;
        emit GuardianUpdated(previousGuardian, newGuardian);
    }

    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    function _record(
        ServiceClaim memory claim,
        AttestationKind kind,
        uint48 expiresAt
    ) private returns (bytes32 key) {
        _validateClaim(claim);
        _validateExpiry(expiresAt);
        key = keccak256(
            abi.encode(
                ATTESTATION_SCHEMA,
                claim.serviceId,
                claim.manifestDigest,
                claim.publisher,
                claim.payTo,
                claim.publisherDataHash
            )
        );

        Attestation storage record = _attestations[key][msg.sender];
        uint48 issuedAt = uint48(block.timestamp);
        uint64 authorizationEpoch =
            kind == AttestationKind.Curator
                ? curatorAuthorizationEpoch[msg.sender]
                : 0;
        record.issuedAt = issuedAt;
        record.expiresAt = expiresAt;
        record.revokedAt = 0;
        record.authorizationEpoch = authorizationEpoch;
        record.kind = kind;

        emit ServiceAttestationRecorded(
            key,
            claim.serviceId,
            msg.sender,
            kind,
            claim.manifestDigest,
            claim.publisher,
            claim.payTo,
            claim.publisherDataHash,
            issuedAt,
            expiresAt,
            authorizationEpoch
        );
    }

    function _status(
        Attestation memory record,
        address attester
    ) private view returns (AttestationStatus) {
        if (record.kind == AttestationKind.None) return AttestationStatus.None;
        if (record.revokedAt != 0) return AttestationStatus.Revoked;
        if (record.kind == AttestationKind.Curator && !isCurator[attester]) {
            return AttestationStatus.AttesterDisabled;
        }
        if (
            record.kind == AttestationKind.Curator &&
            record.authorizationEpoch !=
            curatorAuthorizationEpoch[attester]
        ) {
            return AttestationStatus.StaleAuthorization;
        }
        if (block.timestamp >= record.expiresAt) return AttestationStatus.Expired;
        return AttestationStatus.Active;
    }

    function _validateClaim(ServiceClaim memory claim) private view {
        if (
            claim.serviceId == bytes32(0) ||
            claim.manifestDigest == bytes32(0) ||
            claim.publisher == address(0) ||
            claim.payTo == address(0) ||
            claim.publisher == address(this) ||
            claim.payTo == address(this) ||
            claim.publisherDataHash == bytes32(0)
        ) revert InvalidClaim();
    }

    function _setCurator(address curator, bool allowed) private {
        if (curator == address(0)) revert InvalidAddress();
        if (isCurator[curator] == allowed) return;

        uint64 nextEpoch = curatorAuthorizationEpoch[curator] + 1;
        curatorAuthorizationEpoch[curator] = nextEpoch;
        isCurator[curator] = allowed;
        emit CuratorAuthorizationUpdated(
            curator,
            allowed,
            nextEpoch,
            msg.sender
        );
    }

    function _validateExpiry(uint48 expiresAt) private view {
        uint48 nowTimestamp = uint48(block.timestamp);
        uint48 latest = nowTimestamp + MAX_ATTESTATION_HORIZON;
        if (expiresAt <= nowTimestamp || expiresAt > latest) {
            revert InvalidExpiry(expiresAt, nowTimestamp, latest);
        }
    }
}
