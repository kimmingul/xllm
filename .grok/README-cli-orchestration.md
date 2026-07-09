# CLI orchestration (ask + ccg) — grok-xllm

Canonical docs:

- [docs/getting-started.md](./docs/getting-started.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/local-llms.md](./docs/local-llms.md)
- [docs/SCOPE.md](./docs/SCOPE.md)
- [docs/install.md](./docs/install.md)

```bash
node scripts/grok-ask-advisor.js codex "Review this change"
node scripts/xllm.mjs multi codex,gemini "Security + UX review"
node scripts/xllm.mjs doctor
```

In session: `/ask`, `/ccg`, `/ralph`, `/team`, `/verify`, `/xllm-setup`.
