# claude-plugin: notes for coding agents

This folder is a **self-contained project** inside golden-sach: the hy-guard Claude Code plugin, its mock platform, demo scripts and docs. It isn't part of the pnpm/Turborepo workspace (`apps/*`, `packages/*`), has no dependencies, and is excluded from the root Biome config. Its code style is its own (Node ESM `.mjs`, semicolons).

- **Run everything from this folder.** `npm test` (end-to-end, software key), `npm run test:se` (Secure Enclave; the Mac must be unlocked), `npm run validate` (`claude plugin validate ./plugin`).
- **Layout:**
  - `plugin/`: the Claude Code plugin itself (bridge, hooks, mod, Swift signer);
  - `mock-backend/`: the stand-in platform (also the reference for the real backend);
  - `scripts/`: launchers, demos, e2e;
  - `docs/`: the backend contract, guide and test vectors.
- **Don't change the backend in `apps/` or `packages/` from here.** The backend isn't integrated with the plugin yet; the plugin runs against `mock-backend/`. What the backend must implement is in `docs/BACKEND_GUIDE.md` and `docs/BACKEND_CONTRACT.md`.
- **Protocol changes start in the docs.** Update `docs/BACKEND_CONTRACT.md` and `contract/types.ts`, then the mock and the bridge, then run `npm run test-vectors` if hashing or signing changed.
- **Never touch the user's main Claude Code profile** (`~/.claude`, `~/.claude.json`). Test with `scripts/dev-claude.sh` (profile `~/.claude-hy-test`) or throwaway `CLAUDE_CONFIG_DIR`s in `/tmp`.
- The full documentation is `README.md`.
