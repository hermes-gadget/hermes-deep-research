# Deep Research — Hermes Dashboard Plugin

> Multi-step web research with automated source gathering and report synthesis.
> Inspired by [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) Deep Research,
> powered by Hermes's core and tools.

## What it does

Given a research question, the plugin runs an iterative pipeline:

1. **Query Decomposition** — LLM breaks the question into 3-5 specific sub-queries
2. **Web Search** — searches each sub-query (Brave API if key available, else DuckDuckGo)
3. **Content Extraction** — reads and extracts text from top results
4. **Gap Analysis** — evaluates what's missing and generates follow-up queries
5. **Synthesis** — LLM writes a comprehensive, cited markdown report

## How it works

- **Backend**: FastAPI plugin mounted at `/api/plugins/deep-research/`
  - Research runs in background threads
  - Uses the LLM provider already configured in Hermes (OpenAI-compatible)
  - Zero additional dependencies
- **Frontend**: Vanilla JS bundle registered via Hermes Plugin SDK
  - Query input, live progress tracker, report viewer, source list
  - Research history persisted to disk

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/research` | Start a new research job `{ "query": "..." }` |
| `GET` | `/status/{id}` | Poll job status + progress |
| `GET` | `/results/{id}` | Get full report + sources |
| `GET` | `/history` | List past research jobs |

## Configuration

Default engine: **none needed** — research runs through the local Hermes agent
(see "Research engine" below).

The built-in fallback engine (used only when no `hermes` binary is found) reads:

- **LLM**: first provider with an API key in `config.yaml` (`providers:` / `custom_providers:`), then `DR_LLM_API_KEY` / `DR_LLM_BASE_URL` / `DR_LLM_MODEL`, then `OPENAI_API_KEY` / `OPENAI_BASE_URL` — from the environment or `HERMES_HOME/.env`.
- **Search**: Brave API key → SearXNG (`SEARXNG_URL`) → DuckDuckGo. Video-template results (e.g. sepiasearch) are filtered out.

## Install

Bundled — just place in `plugins/deep-research/` and launch the dashboard.

```bash
hermes dashboard
```

The Deep Research tab appears after Analytics in the sidebar.

## Research engine: Hermes (fork change — default)

This fork runs research through the **local Hermes agent** instead of calling an
LLM provider directly — no separate API key or model configuration is needed.
Each job executes `hermes chat --oneshot --format stream-json` with a research
prompt, so the run uses Hermes' own configured model and tools
(`web_search` / `web_extract`); the plugin streams the run's tool events for
live progress and collects the pages it reads as sources.

- Toolset for the run: `web` (override with `DR_HERMES_TOOLSETS`, e.g. `web,browser`)
- Run budget: 1800 s (`DR_HERMES_BUDGET`); headless `--yolo` on by default (`DR_HERMES_YOLO=0` disables)
- Binary: `hermes` on PATH (`DR_HERMES_BIN` overrides)
- No Hermes CLI on the box? The original built-in pipeline (search + direct LLM
  calls) remains as a fallback; `DR_ENGINE=local` forces it.

## Security hardening (fork, 2026-10)

- **SSRF guard on every built-in fetch** — `web_extract()` validates scheme
  (http/https only, no embedded credentials), resolves DNS and rejects
  loopback / private / link-local / reserved / cloud-metadata addresses
  (IPv4 + IPv6, including IPv4-mapped IPv6 and CGNAT), re-validates every
  redirect hop (max 5), and bounds response size (2 MB), content type and
  timeout. Blocked fetches surface as `[Extraction blocked: …]`.
- **Prompt-injection fencing** — extracted page text is wrapped in explicit
  `<<<UNTRUSTED_WEB_CONTENT … >>>` fences with control/zero-width characters
  stripped; the synthesis prompt is told to treat fenced content as data only,
  never instructions.
- **Endpoint hardening** — job ids are validated before any filesystem access
  (no path traversal via `/delete`, `/results`), and `/models` no longer echoes
  provider `base_url`s (they can reveal internal LM Studio/Ollama addresses).
- **Bounded everything** — research rounds capped (1–8), LLM calls get a
  120 s timeout + single retry, model probing is scheme-pinned and size-capped.

## Standalone web UI

Run the same UI without the Hermes dashboard:

```bash
pip install -r standalone/requirements.txt   # fastapi, uvicorn, pyyaml, openai
python3 standalone/server.py                 # http://127.0.0.1:8787
```

- Serves the plugin's API + bundled frontend with a Hermes plugin-SDK shim
  (React vendored locally — no CDN needed).
- Binds `127.0.0.1` by default (`--host`/`--port`); optional shared token:
  `python3 standalone/server.py --token <secret>` — open `/?token=<secret>`
  once and the cookie carries it.
- Needs the `hermes` CLI for the default engine; everything else (history,
  sources, reports) is local to `~/.hermes/plugins/deep-research/`.

## License

MIT
