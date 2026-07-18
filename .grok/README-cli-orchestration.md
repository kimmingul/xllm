# CLI orchestration (ask + xllm) — xllm

Canonical docs:

- [docs/getting-started.md](../docs/getting-started.md)
- [docs/architecture.md](../docs/architecture.md)
- [docs/local-llms.md](../docs/local-llms.md)
- [docs/SCOPE.md](../docs/SCOPE.md)
- [docs/install.md](../docs/install.md)

```bash
node scripts/xllm-advisor.js codex "Review this change"
node scripts/xllm.mjs review roles codex,gemini "Security + UX review"
node scripts/xllm.mjs doctor
```

In session: `/ask`, `/xllm`, `/xllm-setup`.
