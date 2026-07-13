# Minimal multi-LLM review (xllm)

## Shell

```bash
node scripts/xllm.mjs doctor

node scripts/xllm-advisor.js ollama:qwen3.6:latest "Review scripts/xllm-advisor.js for security risks. Bullet list only."
node scripts/xllm-advisor.js codex "Review scripts/xllm-advisor.js for security risks and quoting bugs. Bullet list only."

node scripts/xllm.mjs multi ollama:qwen3.6:latest,codex "Security review of the advisor script; bullets only."
```

## In Grok session

```text
/xllm-setup
/xllm ollama:qwen3.6:latest,codex Review scripts/xllm-advisor.js for security and simplicity
```

## Escalation ladder

```bash
node scripts/xllm.mjs ask codex@high "Review this design"                        # 01 opinion
node scripts/xllm.mjs propose codex@high "Add input validation to login()"      # 02 static diff
node scripts/xllm.mjs exec codex@high "Implement X" --test-cmd "npm test"       # 03 verified branch
```
