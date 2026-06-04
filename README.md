# Deep Research — Hermes Dashboard Plugin

> Multi-step web research with automated source gathering and report synthesis.
> Inspired by [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) Deep Research,
> powered by Hermes's own LLM and web tools.

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

No extra config needed. The plugin reads:

- **LLM**: Uses the first provider with an API key from `config.yaml` providers, or falls back to `OPENAI_API_KEY` / `OPENAI_BASE_URL` env vars.
- **Search**: Uses `BRAVE_API_KEY` or `SERPER_API_KEY` from Hermes config or env. Falls back to DuckDuckGo (no key needed).

## Install

Bundled — just place in `plugins/deep-research/` and launch the dashboard.

```bash
hermes dashboard
```

The Deep Research tab appears after Analytics in the sidebar.

## License

MIT
