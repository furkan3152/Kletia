
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract KletiaArcAgentRegistry is ERC2771Context {

    address public owner;

    uint256 public nextAgentId;

    struct Agent {
        uint256 id;
        string name;
        string description;
        string[] skills;
        string endpointUrl;
        address agentOwner;
        bool active;
        uint256 reputation;
        uint256 registeredAt;
        uint256 updatedAt;
    }

    mapping(uint256 => Agent) private _agents;

    mapping(address => uint256[]) private _ownerAgents;

    mapping(string => uint256[]) private _skillToAgents;

    mapping(address => bool) public authorizedScorers;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed agentOwner,
        string name,
        string endpointUrl
    );
    event AgentUpdated(uint256 indexed agentId, string name, string endpointUrl);
    event AgentDeactivated(uint256 indexed agentId);
    event AgentReactivated(uint256 indexed agentId);
    event ReputationUpdated(uint256 indexed agentId, uint256 oldScore, uint256 newScore, address indexed scorer);
    event ScorerAuthorized(address indexed scorer);
    event ScorerRevoked(address indexed scorer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(_msgSender() == owner, "KletiaArcAgentRegistry: caller is not the owner");
        _;
    }

    modifier onlyAgentOwner(uint256 agentId) {
        require(agentId < nextAgentId, "KletiaArcAgentRegistry: agent does not exist");
        require(
            _agents[agentId].agentOwner == _msgSender(),
            "KletiaArcAgentRegistry: caller is not agent owner"
        );
        _;
    }

    modifier onlyAuthorizedScorer() {
        require(
            authorizedScorers[_msgSender()] || _msgSender() == owner,
            "KletiaArcAgentRegistry: not authorized to score"
        );
        _;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "KletiaArcAgentRegistry: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(address trustedForwarder) ERC2771Context(trustedForwarder) {
        owner = _msgSender();
        _status = _NOT_ENTERED;
        emit OwnershipTransferred(address(0), _msgSender());
    }

        function registerAgent(
        string calldata name,
        string calldata description,
        string[] calldata skills,
        string calldata endpointUrl
    ) external nonReentrant returns (uint256 agentId) {
        require(bytes(name).length > 0, "KletiaArcAgentRegistry: name is required");
        require(bytes(name).length <= 128, "KletiaArcAgentRegistry: name too long");
        require(bytes(description).length > 0, "KletiaArcAgentRegistry: description is required");
        require(bytes(description).length <= 1024, "KletiaArcAgentRegistry: description too long");
        require(skills.length > 0, "KletiaArcAgentRegistry: at least one skill required");
        require(skills.length <= 20, "KletiaArcAgentRegistry: too many skills");
        require(bytes(endpointUrl).length > 0, "KletiaArcAgentRegistry: endpoint URL is required");
        require(bytes(endpointUrl).length <= 256, "KletiaArcAgentRegistry: endpoint URL too long");

        agentId = nextAgentId++;

        string[] memory skillsCopy = new string[](skills.length);
        for (uint256 i = 0; i < skills.length; ) {
            require(bytes(skills[i]).length > 0, "KletiaArcAgentRegistry: empty skill tag");
            require(bytes(skills[i]).length <= 64, "KletiaArcAgentRegistry: skill tag too long");
            skillsCopy[i] = skills[i];
            _skillToAgents[skills[i]].push(agentId);
            unchecked { ++i; }
        }

        Agent storage a = _agents[agentId];
        a.id = agentId;
        a.name = name;
        a.description = description;
        a.endpointUrl = endpointUrl;
        a.agentOwner = _msgSender();
        a.active = true;
        a.reputation = 0;
        a.registeredAt = block.timestamp;
        a.updatedAt = block.timestamp;

        for (uint256 i = 0; i < skillsCopy.length; ) {
            a.skills.push(skillsCopy[i]);
            unchecked { ++i; }
        }

        _ownerAgents[_msgSender()].push(agentId);

        emit AgentRegistered(agentId, _msgSender(), name, endpointUrl);
    }

        function updateAgent(
        uint256 agentId,
        string calldata name,
        string calldata description,
        string calldata endpointUrl
    ) external onlyAgentOwner(agentId) {
        require(bytes(name).length > 0 && bytes(name).length <= 128, "KletiaArcAgentRegistry: invalid name");
        require(bytes(description).length > 0 && bytes(description).length <= 1024, "KletiaArcAgentRegistry: invalid description");
        require(bytes(endpointUrl).length > 0 && bytes(endpointUrl).length <= 256, "KletiaArcAgentRegistry: invalid endpoint");

        Agent storage a = _agents[agentId];
        a.name = name;
        a.description = description;
        a.endpointUrl = endpointUrl;
        a.updatedAt = block.timestamp;

        emit AgentUpdated(agentId, name, endpointUrl);
    }

        function deactivateAgent(uint256 agentId) external onlyAgentOwner(agentId) {
        require(_agents[agentId].active, "KletiaArcAgentRegistry: already inactive");
        _agents[agentId].active = false;
        _agents[agentId].updatedAt = block.timestamp;
        emit AgentDeactivated(agentId);
    }

        function reactivateAgent(uint256 agentId) external onlyAgentOwner(agentId) {
        require(!_agents[agentId].active, "KletiaArcAgentRegistry: already active");
        _agents[agentId].active = true;
        _agents[agentId].updatedAt = block.timestamp;
        emit AgentReactivated(agentId);
    }

        function updateReputation(uint256 agentId, uint256 newScore) external onlyAuthorizedScorer {
        require(agentId < nextAgentId, "KletiaArcAgentRegistry: agent does not exist");
        require(newScore <= 10_000, "KletiaArcAgentRegistry: score out of range (0-10000)");

        Agent storage a = _agents[agentId];
        uint256 oldScore = a.reputation;
        a.reputation = newScore;
        a.updatedAt = block.timestamp;

        emit ReputationUpdated(agentId, oldScore, newScore, _msgSender());
    }

        function getAgent(uint256 agentId) external view returns (Agent memory) {
        require(agentId < nextAgentId, "KletiaArcAgentRegistry: agent does not exist");
        return _agents[agentId];
    }

        function getAgentsByOwner(address agentOwner) external view returns (uint256[] memory) {
        return _ownerAgents[agentOwner];
    }

        function getAgentsBySkill(string calldata skill) external view returns (uint256[] memory) {
        return _skillToAgents[skill];
    }

        function getAgentSkills(uint256 agentId) external view returns (string[] memory) {
        require(agentId < nextAgentId, "KletiaArcAgentRegistry: agent does not exist");
        return _agents[agentId].skills;
    }

        function totalAgents() external view returns (uint256) {
        return nextAgentId;
    }

        function authorizeScorer(address scorer) external onlyOwner {
        require(scorer != address(0), "KletiaArcAgentRegistry: invalid scorer");
        authorizedScorers[scorer] = true;
        emit ScorerAuthorized(scorer);
    }

        function revokeScorer(address scorer) external onlyOwner {
        authorizedScorers[scorer] = false;
        emit ScorerRevoked(scorer);
    }

        function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcAgentRegistry: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
