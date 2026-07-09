# Minimal multi-LLM review (grok-xllm)

## Shell

```bash
node scripts/xllm.mjs doctor

node scripts/grok-ask-advisor.js ollama:qwen3.6:latest "Review scripts/grok-ask-advisor.js for security risks. Bullet list only."
node scripts/grok-ask-advisor.js codex "Review scripts/grok-ask-advisor.js for security risks and quoting bugs. Bullet list only."

node scripts/xllm.mjs multi ollama:qwen3.6:latest,codex "Security review of the advisor script; bullets only."
```

## In Grok session

```text
/xllm-setup
/ccg ollama:qwen3.6:latest,codex Review scripts/grok-ask-advisor.js for security and simplicity
```

## Ralph micro-task

```text
/ralph --critic=ollama:qwen3.6:latest,codex --max-iterations=4 Add one unit test for cleanOllamaOutput thinking-strip
```
