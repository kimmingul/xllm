# Architecture — grok-xllm

> `<state>` = project state dir: `.xllm/` (default) or legacy `.grok/` when the project already uses it.

## Principles

1. **Grok-native first** — prefer `spawn_subagent`, `todo_write`, plan mode, skills.  
2. **One multi-LLM door** — all external models go through `scripts/grok-ask-advisor.js`.  
3. **Artifacts over chat memory** — durable paths under `<state>/artifacts/`.  
4. **Evidence over claims** — `/ralph` and `/verify` refuse vibes-based completion.  
5. **Thin over clever** — skills are playbooks; no second agent OS.

## Components

```text
┌─────────────────────────────────────────────────────┐
│  Grok Build session                                 │
│  skills: ask xllm ralph team verify xllm-setup       │
│  agents: critic executor verifier security-reviewer │
└───────────────┬─────────────────────┬───────────────┘
                │                     │
                ▼                     ▼
        spawn_subagent         run_terminal_command
        (native workers)       node scripts/grok-ask-advisor.js
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
                 cloud CLIs        ollama           lmstudio HTTP
                    │                 │                 │
                    └────────────┬────┴─────────────────┘
                                 ▼
                      <state>/artifacts/{ask,xllm,ralph,team,verify}
```

## Skill layering

| Layer | Skill | Depends on |
|-------|-------|------------|
| L0 | advisor script | Node + provider CLIs |
| L1 | `/ask` | L0 |
| L2 | `/xllm` | L1 × N + synthesis |
| L2 | `/verify` | shell tools (+ optional L1) |
| L3 | `/ralph` | L1 + L2 + todo_write |
| L3 | `/team` | subagents + L1 + todo_write |
