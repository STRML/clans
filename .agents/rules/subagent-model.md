# Subagent model: use zai glm-5.3-flash in this repo

All `task` subagents in this repo (every wave, including scouts and reviews that
do not name a specialist) must run on `neuralwatt/glm-5.3-flash`.

Why: this is a low-priority repo and the zai tokens are close to free. Do not
spend the expensive subscriptions (anthropic/openai) on subagents here.

Implementation notes:
- Spawn with `"agent": "glm-worker"` on every subagent. If a slice genuinely
  needs a heavier model, ask Sam first.
- `scout` stays available for read-only recon only when glm-worker cannot do
  the job; it also burns paid quota, so prefer glm-worker.
- This rule deliberately overrides the AGENTS.md ds-worker/glm-worker 50-50
  alternation: in THIS repo use glm-worker exclusively.
