# Contributing to grok-xllm

## Read this first

Product scope is intentional and narrow. See [`.grok/docs/SCOPE.md`](.grok/docs/SCOPE.md).

**In scope:** multi-CLI advisors, local LLMs, evidence loops (`ralph`/`verify`), thin team playbook, doctor.

**Out of scope:** hooks engines, HUD, ultrawork/autopilot runtimes, full skill dumps, model-tier routers.

## Dev loop

```bash
npm run check
npm test
npm run smoke
npm run smoke:live
```

## Adding a provider

1. `PROVIDER_BINARIES` + `resolveSpawnConfig` in `scripts/grok-ask-advisor.js`
2. Health check if local
3. Unit test in `scripts/test-advisor.mjs`
4. Doc line in `.grok/docs/local-llms.md` or README

## Changing skills

- Keep skills short and imperative.
- Always route external models through `grok-ask-advisor.js`.
- Mention artifact paths; never trust chat alone for completion.

## PR checklist

- [ ] Fits SCOPE.md  
- [ ] `npm run ci` green  
- [ ] No secrets in artifacts committed  
- [ ] CHANGELOG entry  
