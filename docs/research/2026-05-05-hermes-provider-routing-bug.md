# Hermes OpenRouter Provider-Routing Bug: per-task `model`/`provider` ignored

Date: 2026-05-05
Workspace: /home/codeseys/.hermes/hermes-agent

## Root cause

**Per-task `model` and `provider` fields passed to `delegate_task(tasks=[...])`
are silently dropped. The tool schema does not declare them, and the dispatch
loop never reads them.**

Evidence:

1. `tools/delegate_tool.py:2465-2495` — the JSON schema for `tasks[]` items
   declares only `goal`, `context`, `toolsets`, `acp_command`, `acp_args`,
   `role`. There is no `model`, `provider`, `base_url`, `api_key`, or
   `providers_order` property. Extra properties the LLM supplies are allowed
   through the handler dict but are never referenced.
2. `tools/delegate_tool.py:1964-1991` — the per-task child-build loop passes
   `model=creds["model"]` (line 1974) and `override_provider=creds["provider"]`
   (line 1978). `creds` is the single `_resolve_delegation_credentials(...)`
   result computed once before the loop from the global
   `delegation.*` config block. **`t.get("model")`, `t.get("provider")`, and
   `t.get("base_url")` are never consulted.** All tasks in a batch get the
   same model.
3. `tools/delegate_tool.py:1044, 1078` — `providers_order` inheritance is
   gated at `tools/delegate_tool.py:1046` on `if override_provider:`, which
   is truthy only when the delegation config sets a different provider than
   the parent. When the parent already runs on `openrouter` and delegation
   also resolves to `openrouter`, the child inherits the parent's
   `providers_order=[amazon-bedrock, anthropic, google-vertex]` from
   `cli.py:2203` untouched.

Consequence for the reported run: three tasks requesting
`google/gemini-3.1-pro-preview`, `openai/gpt-5`, `deepseek/...` all collapsed
to the single `delegation.model` = `anthropic/claude-opus-4.7`. Because the
parent's `provider.order` was forwarded verbatim, OpenRouter served that Claude
model via Bedrock — which is what the session metadata shows.

## OpenRouter semantics (for reference)

Per https://openrouter.ai/docs/features/provider-routing :

- `provider.order` is a *prioritized* list of provider slugs.
- `provider.allow_fallbacks` defaults to `true`. Providers in `order` that do
  not serve the requested model are skipped, and routing falls through to
  other providers that do.
- Only with `allow_fallbacks: false` does `order` become a hard allowlist
  capable of failing the call.

Hermes never sets `allow_fallbacks` (`run_agent.py:8428-8440`), so
cross-family slugs *should* have worked — but they never reached OpenRouter
because the per-task model field was dropped before the request was built.
The user's top-level `provider_routing.order` is therefore a contributing
smell, not the direct cause.

## Recommended fix (minimal)

Expose per-task credential overrides in the tool schema, read them in the
dispatch loop, and clear `providers_order` when a task overrides the model
or provider. Three targeted diffs:

**1. `tools/delegate_tool.py:2495` — extend the per-task schema:**

```python
"role": { ... },
"model": {
    "type": "string",
    "description": "Per-task model slug (e.g. 'google/gemini-3.1-pro-preview'). Overrides delegation.model for this task only.",
},
"provider": {
    "type": "string",
    "description": "Per-task provider name (e.g. 'openrouter', 'nous'). Overrides delegation.provider for this task only.",
},
```

**2. `tools/delegate_tool.py:1964-1991` — honor per-task overrides in the loop:**

```python
for i, t in enumerate(task_list):
    task_acp_args = t.get("acp_args") if "acp_args" in t else None
    effective_role = _normalize_role(t.get("role") or top_role)

    # Per-task credential overrides win over delegation.* defaults.
    task_model    = t.get("model") or creds["model"]
    task_provider = t.get("provider") or creds["provider"]
    if t.get("provider") and t["provider"] != creds.get("provider"):
        # Re-resolve creds for the per-task provider so base_url/api_key/api_mode match.
        task_creds = _resolve_delegation_credentials(
            {"provider": t["provider"], "model": task_model}, parent_agent
        )
    else:
        task_creds = creds

    child = _build_child_agent(
        ...
        model=task_model,
        override_provider=task_provider,
        override_base_url=task_creds["base_url"],
        override_api_key=task_creds["api_key"],
        override_api_mode=task_creds["api_mode"],
        ...
    )
```

**3. `tools/delegate_tool.py:1046` — broaden the clear condition:**

```python
# Clear parent provider-preference filters whenever the child is routed to
# a different model OR provider than the parent. OpenRouter `order` is a
# per-request preference that must not leak across model families.
parent_model = getattr(parent_agent, "model", None)
if override_provider or (effective_model and effective_model != parent_model):
    child_providers_allowed = None
    child_providers_ignored = None
    child_providers_order = None
    child_provider_sort = None
```

Rationale: the existing `override_provider`-only gate misses the case where
parent and delegation share a provider (`openrouter`) but the subagent targets
a different model family. That case needs the same cleanup.

## Alternatives considered

- **(a) Always clear `providers_order` in subagents.** Simpler but breaks
  users who deliberately pin a routing order for their main model and expect
  same-model subagents to inherit it. Regression risk in same-model workflows.
- **(b) Apply `provider_routing.order` only to the main agent; never pass to
  subagents.** Clean separation, but silently changes semantics for users
  who today rely on inheritance. Requires a release note.
- **(c) Accept a per-task `providers_order` parameter.** Adds surface area
  without solving the underlying "model field silently dropped" bug. Not
  sufficient alone.
- **(d) Append `allow_fallbacks=false` only when users explicitly ask for a
  hard allowlist.** Orthogonal — fixes a different latent issue but does not
  address the dropped-model bug.

Recommended fix chooses the minimum that (i) makes `tasks[].model`
functional and (ii) prevents the parent's `order` from hijacking a
cross-family child call.

## Test plan

1. **Unit** — extend `tests/tools/test_delegate.py` with a test that passes
   `tasks=[{"goal": "x", "model": "google/gemini-3.1-pro-preview"}]` with a
   parent on `anthropic/claude-opus-4.7` and asserts
   `MockAgent.call_args.kwargs["model"] == "google/gemini-3.1-pro-preview"`
   and `kwargs["providers_order"] is None`.
2. **Unit** — add a case where two tasks in one batch request different
   models and assert each child got the requested one (proves the
   per-iteration resolution, not just first-task caching).
3. **Live smoke from parent agent** — once fix lands, run:
   ```
   delegate_task(tasks=[
     {"goal": "Echo your model name.", "model": "google/gemini-3.1-pro-preview", "provider": "openrouter"},
     {"goal": "Echo your model name.", "model": "openai/gpt-5",                 "provider": "openrouter"},
     {"goal": "Echo your model name.", "model": "deepseek/deepseek-chat",       "provider": "openrouter"},
   ])
   ```
   Confirm each result's metadata carries the requested slug and that the
   summaries read in the respective families' voice. Cross-check against the
   session log under `~/.hermes/sessions/` — look for the `extra_body.provider`
   block in the outbound request and the `model` field in the response.
4. **Regression** — existing
   `test_provider_override_clears_parent_openrouter_filters` must still pass
   (provider-override path).

## Files to change

- `tools/delegate_tool.py` lines 1046 (condition), 1964-1991 (loop),
  2495 (schema). No other files.

## Citations

- `tools/delegate_tool.py:1042-1050` — inheritance + conditional clear
- `tools/delegate_tool.py:1074-1079` — providers_order passed to child
- `tools/delegate_tool.py:1969-1991` — per-task dispatch loop (no model read)
- `tools/delegate_tool.py:2465-2495` — incomplete tasks[] schema
- `tools/delegate_tool.py:2253-2350` — `_resolve_delegation_credentials`
- `cli.py:2203` — `self._providers_order = pr.get("order")`
- `cli.py:3659, 6828` — passes `providers_order` into AIAgent
- `run_agent.py:8427-8440` — builds `extra_body.provider` (no `allow_fallbacks`)
- `tests/tools/test_delegate.py:985-1023` — existing provider-override test
