# Getting started — grok-xllm

## 1. Install the plugin

```bash
cd /path/to/grok-xllm
grok plugin install . --trust
```

## 2. Run setup

```text
/xllm-setup
```

Or:

```bash
node scripts/xllm.mjs doctor
node scripts/xllm.mjs remember
```

From another project:

```bash
node /path/to/grok-xllm/scripts/xllm.mjs remember
```

You want at least **one** READY advisor. See [install.md](./install.md).

## 3. Core loop

```text
/ask grok "Summarize scripts/grok-ask-advisor.js in 5 bullets"
/xllm ollama:qwen3.6:latest,codex "Review the advisor script for security"
```

## 4. Evidence-gated work

```text
/ralph --critic=codex "Add a unit test for slugify"
/verify "npm test passes"
```

## 5. Parallel work

```text
/team "Document SCOPE and wire verifier — explorer + executor + critic"
```

## Mental model

- **Grok** = conductor (tools, edits, synthesis)  
- **Advisor CLIs** = guest critics (artifacts)  
- **Ralph/verify** = no evidence, no “done”  

More: [SCOPE.md](./SCOPE.md), [local-llms.md](./local-llms.md), [architecture.md](./architecture.md), [install.md](./install.md).
