# Contributing to Kletia

Welcome to Kletia! We are thrilled you want to contribute to our intent-driven multichain DeFi superapp. By contributing to Kletia, you help build a seamless future for natural language intent execution and zero-knowledge privacy across Base, Arbitrum, and Stellar.

## Code of Conduct
By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development Setup
Ensure you have Node.js version **22.23.1** and npm installed on your machine.

1. Clone the repository:
   ```bash
   git clone https://github.com/furkan3152/Kletia.git
   cd Kletia
   ```

2. Install dependencies (we use per-package installations):
   ```bash
   npm --prefix <pkg> ci --legacy-peer-deps
   ```

## Branching Strategy
- Create all feature and bugfix branches from `main`.
- Use descriptive branch names (e.g., `feature/add-stellar-support`, `bugfix/zk-circuit-routing`).

## Commit Conventions
We follow [Conventional Commits](https://www.conventionalcommits.org/). Commit messages should follow this format:
`type(scope): description`

Examples: 
- `feat(core): add Base Mainnet routing`
- `fix(ui): resolve intent parsing error`

## Code Style
- **TypeScript:** Strict mode must be enabled. We enforce ESLint for web applications.
- **Solidity:** Smart contracts must follow OpenZeppelin patterns and standards.

## Testing Requirements
Before submitting a Pull Request, ensure your changes pass all core tests.
Run the following command at a minimum:
```bash
npm run verify:core
```

## PR Process
1. Ensure your branch passes the verification checks: `npm run verify`
2. Push your changes and open a Pull Request against the `main` branch.
3. Fill out the pull request template completely, describing your changes and referencing any related issues.
4. Wait for maintainers to review your code.

## Documentation Requirements
If your PR introduces a breaking change, modifies public APIs, or changes structural logic, update the relevant `README.md` files or internal documentation accordingly.

## Issue Reporting
To report bugs or request features, use the provided GitHub Issue Templates. Be as descriptive as possible to help the team understand the context.
