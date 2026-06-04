"""Deep Research dashboard plugin backend.

Multi-step research pipeline backed by Kanban board tracking.
Each research job creates a parent task + child step tasks on the
'deep-research' board, making research durable and observable.

Mounted at /api/plugins/deep-research/ by the Hermes dashboard.
"""
from __future__ import annotations

import html as _html
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

try:
    from hermes_constants import get_hermes_home
except ImportError:
    def get_hermes_home() -> Path:  # type: ignore[misc]
        val = (os.environ.get("HERMES_HOME") or "").strip()
        return Path(val) if val else Path.home() / ".hermes"

try:
    from fastapi import APIRouter
except Exception:
    class APIRouter:  # type: ignore
        def get(self, *_a, **_k):
            return lambda fn: fn
        def post(self, *_a, **_k):
            return lambda fn: fn
        def delete(self, *_a, **_k):
            return lambda fn: fn

router = APIRouter()

# ---------------------------------------------------------------------------
# Kanban helpers
# ---------------------------------------------------------------------------
_KANBAN_BOARD = "deep-research"


def _get_kanban_conn() -> sqlite3.Connection:
    """Open the deep-research Kanban board SQLite connection."""
    from hermes_cli.kanban_db import _sqlite_connect, kanban_db_path
    p = kanban_db_path(_KANBAN_BOARD)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = _sqlite_connect(p)
    conn.row_factory = sqlite3.Row
    return conn


def _kanban_create_task(title: str, body: str = "", parent_id: Optional[str] = None) -> str:
    """Create a task on the deep-research board."""
    from hermes_cli.kanban_db import create_task, link_tasks
    conn = _get_kanban_conn()
    with conn:
        tid = create_task(
            conn,
            title=title,
            body=body,
            board=_KANBAN_BOARD,
            initial_status="blocked",
            created_by="deep-research-plugin",
        )
        if parent_id:
            link_tasks(conn, parent_id, tid)
    return tid


def _kanban_update_status(task_id: str, status: str) -> None:
    """Update task status (raw SQL for intermediate states)."""
    from hermes_cli.kanban_db import VALID_STATUSES
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid status {status!r}")
    conn = _get_kanban_conn()
    with conn:
        conn.execute(
            "UPDATE tasks SET status = ? WHERE id = ?",
            (status, task_id),
        )


def _kanban_add_report(task_id: str, report: str) -> None:
    """Persist the final report as a comment on the parent task."""
    from hermes_cli.kanban_db import add_comment
    conn = _get_kanban_conn()
    with conn:
        add_comment(conn, task_id, "deep-research", report)


def _kanban_complete(task_id: str) -> None:
    """Mark a task as done via the Kanban API."""
    from hermes_cli.kanban_db import complete_task
    conn = _get_kanban_conn()
    with conn:
        complete_task(conn, task_id)


def _kanban_get_task(task_id: str) -> Optional[Any]:
    """Fetch a single task from the Kanban board."""
    from hermes_cli.kanban_db import get_task
    conn = _get_kanban_conn()
    return get_task(conn, task_id)


def _kanban_get_children(parent_id: str) -> List[Dict[str, Any]]:
    """Fetch child tasks linked to a parent."""
    conn = _get_kanban_conn()
    rows = conn.execute(
        "SELECT child_id FROM task_links WHERE parent_id = ?", (parent_id,)
    ).fetchall()
    if not rows:
        return []
    cids = [r["child_id"] for r in rows]
    placeholders = ",".join("?" * len(cids))
    task_rows = conn.execute(
        f"SELECT * FROM tasks WHERE id IN ({placeholders}) ORDER BY created_at ASC", cids
    ).fetchall()
    return [dict(r) for r in task_rows]


# ---------------------------------------------------------------------------
# Legacy state (minimal — for in-memory running threads)
# ---------------------------------------------------------------------------
_jobs: Dict[str, Dict[str, Any]] = {}
_queue: List[Dict[str, Any]] = []
_lock = threading.Lock()


def _data_dir() -> Path:
    d = get_hermes_home() / "plugins" / "deep-research"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------
_ENV_RE = re.compile(r"\$\{(\w+)\}")

def _expand_env(value):
    """Recursively expand ${VAR} references in strings and dicts."""
    if isinstance(value, str):
        def _sub(m):
            return os.environ.get(m.group(1), m.group(0))
        return _ENV_RE.sub(_sub, value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value

def _read_hermes_config() -> dict:
    """Read config.yaml from HERMES_HOME with ${VAR} expansion."""
    cfg_path = get_hermes_home() / "config.yaml"
    if cfg_path.exists():
        try:
            import yaml  # type: ignore
            with open(cfg_path) as f:
                return _expand_env(yaml.safe_load(f) or {})
        except Exception:
            pass
    return {}


def _all_providers(cfg: dict) -> Dict[str, dict]:
    """Return unified providers dict from both standard and custom providers."""
    unified = dict(cfg.get("providers") or {})
    for i, cp in enumerate(cfg.get("custom_providers") or []):
        name = cp.get("name") or f"custom_{i}"
        unified[name] = cp
    return unified


def _get_llm_settings() -> Dict[str, str]:
    """Resolve LLM provider settings from Hermes config or env."""
    cfg = _read_hermes_config()
    providers = _all_providers(cfg)
    # Try each provider in order
    for _name, prov in providers.items():
        api_key = prov.get("api_key", "")
        base_url = prov.get("base_url", "")
        model = prov.get("model", "")
        if api_key:
            return {"api_key": api_key, "base_url": base_url or None, "model": model}
    # Fallback to env vars
    return {
        "api_key": os.environ.get("OPENAI_API_KEY", ""),
        "base_url": os.environ.get("OPENAI_BASE_URL") or None,
        "model": os.environ.get("HERMES_MODEL", ""),
    }


def _get_search_api_key() -> Optional[str]:
    """Look for a Brave Search API key."""
    cfg = _read_hermes_config()
    tools_cfg = cfg.get("tools", {})
    web_cfg = tools_cfg.get("web", {})
    return (
        web_cfg.get("brave_api_key")
        or os.environ.get("BRAVE_API_KEY")
        or web_cfg.get("serper_api_key")
        or os.environ.get("SERPER_API_KEY")
    )


# ---------------------------------------------------------------------------
# Web search
# ---------------------------------------------------------------------------
def _search_brave(query: str, api_key: str, count: int = 8) -> List[Dict[str, str]]:
    """Brave Search API."""
    try:
        url = (
            f"https://api.search.brave.com/res/v1/web/search"
            f"?q={quote_plus(query)}&count={count}"
        )
        req = Request(url, headers={
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": api_key,
        })
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        results = []
        for web in data.get("web", {}).get("results", []):
            results.append({
                "url": web.get("url", ""),
                "title": web.get("title", ""),
                "snippet": web.get("description", ""),
            })
        return results
    except Exception as e:
        return [{"url": "", "title": "", "snippet": f"[Brave error: {e}]"}]


def _search_duckduckgo(query: str, count: int = 8) -> List[Dict[str, str]]:
    """DuckDuckGo lite HTML scraping — no API key needed."""
    results = []
    try:
        url = f"https://lite.duckduckgo.com/lite/?q={quote_plus(query)}"
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")

        # Parse result links and snippets from DDG lite HTML
        links = re.findall(
            r'<a[^>]+class="result-link"[^>]+href="([^"]+)"', raw
        )
        titles_raw = re.findall(
            r'<a[^>]+class="result-link"[^>]*>(.*?)</a>', raw, re.S
        )
        snippets_raw = re.findall(
            r'<td[^>]+class="result-snippet"[^>]*>(.*?)</td>', raw, re.S
        )

        clean = lambda s: _html.unescape(re.sub(r"<[^>]+>", "", s)).strip()

        for i in range(min(len(links), count)):
            results.append({
                "url": links[i],
                "title": clean(titles_raw[i]) if i < len(titles_raw) else "",
                "snippet": clean(snippets_raw[i]) if i < len(snippets_raw) else "",
            })
    except Exception as e:
        results.append({"url": "", "title": "", "snippet": f"[DDG error: {e}]"})
    return results


def web_search(query: str, count: int = 8) -> List[Dict[str, str]]:
    """Search web — Brave API if key available, else DuckDuckGo."""
    api_key = _get_search_api_key()
    if api_key:
        return _search_brave(query, api_key, count)
    return _search_duckduckgo(query, count)


# ---------------------------------------------------------------------------
# Web extract
# ---------------------------------------------------------------------------
def web_extract(url: str, max_chars: int = 15000) -> str:
    """Extract readable text from a URL."""
    try:
        req = Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; Hermes DeepResearch/1.0)"
        })
        with urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")

        # Strip scripts and styles
        text = re.sub(r"<script[^>]*>.*?</script>", "", raw, flags=re.S)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.S)
        # Strip HTML tags
        text = re.sub(r"<[^>]+>", " ", text)
        text = _html.unescape(text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:max_chars] + ("..." if len(text) > max_chars else "")
    except Exception as e:
        return f"[Extraction error: {e}]"


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------
def _resolve_model_override(model_value: Optional[str]) -> Dict[str, str]:
    """Resolve a 'provider:model' or 'profile:provider:model' value into LLM settings."""
    if not model_value or model_value == "default":
        return _get_llm_settings()
    parts = model_value.split(":")
    cfg = _read_hermes_config()
    if len(parts) == 3:
        # profile:provider:model
        profile_name, prov_name, model_id = parts
        prof_cfg_path = get_hermes_home() / "profiles" / profile_name / "config.yaml"
        if prof_cfg_path.exists():
            try:
                import yaml as _yaml
                with open(prof_cfg_path) as f:
                    pcfg = _yaml.safe_load(f) or {}
                p = (pcfg.get("providers") or {}).get(prov_name, {})
                return {"api_key": p.get("api_key", ""), "base_url": p.get("base_url"), "model": model_id}
            except Exception:
                pass
    elif len(parts) == 2:
        # provider:model
        prov_name, model_id = parts
        p = _all_providers(cfg).get(prov_name, {})
        return {"api_key": p.get("api_key", ""), "base_url": p.get("base_url"), "model": model_id}
    return _get_llm_settings()


def llm_call(prompt: str, system: str = "You are a research assistant.", model_override: Optional[str] = None) -> str:
    """Call the configured LLM via OpenAI SDK."""
    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        return "[LLM unavailable: openai SDK not installed]"

    settings = _resolve_model_override(model_override)
    if not settings["api_key"]:
        return "[LLM unavailable: no API key found in config or env]"

    client = OpenAI(api_key=settings["api_key"], base_url=settings.get("base_url"))
    model = settings.get("model") or "gpt-4o-mini"

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_tokens=4096,
        )
        return resp.choices[0].message.content or ""
    except Exception as e:
        return f"[LLM error: {e}]"


# ---------------------------------------------------------------------------
# Research pipeline
# ---------------------------------------------------------------------------
def _run_research(job_id: str, query: str, max_rounds: int = 3, mode: str = "auto", model_override: Optional[str] = None) -> None:
    """Background research pipeline — updates Kanban tasks as it progresses."""
    job = _jobs.get(job_id, {})
    parent_id = job.get("kanban_parent_id")
    child_map = job.get("kanban_children", {})

    def _step(name: str, detail: str = "", round: int = 0) -> None:
        job["current_step"] = name
        job["updated_at"] = time.time()
        if detail:
            job["steps"].append({"step": name, "detail": detail, "round": round, "ts": time.time()})
        # Update Kanban child task status
        cid = child_map.get(name)
        if cid:
            try:
                _kanban_update_status(cid, "running")
            except Exception:
                pass

    def _step_done(name: str) -> None:
        cid = child_map.get(name)
        if cid:
            try:
                _kanban_update_status(cid, "done")
            except Exception:
                pass

    def add_source(url: str, title: str, snippet: str, content: str = "") -> None:
        job["sources"].append({
            "url": url,
            "title": title,
            "snippet": snippet,
            "content": content[:3000] if content else "",
        })

    try:
        if parent_id:
            _kanban_update_status(parent_id, "running")

        # —— Step 1: Decompose query into sub-queries ——
        _step("decompose", "Planning research strategy...")
        decomp_prompt = (
            f'Research question: "{query}"\n\n'
            "Break this into 3-5 specific sub-queries that together cover the "
            "topic comprehensively. Consider different angles, subtopics, and "
            "aspects that need investigation.\n\n"
            "Return ONLY a JSON array of strings. No explanation."
        )
        raw = llm_call(decomp_prompt, system="Output ONLY valid JSON arrays.", model_override=model_override)
        try:
            m = re.search(r"\[.*\]", raw, re.S)
            sub_queries: List[str] = json.loads(m.group()) if m else [query]
        except (json.JSONDecodeError, AttributeError):
            sub_queries = [query]

        _step_done("decompose")
        _step("decompose", f"Generated {len(sub_queries)} sub-queries")

        # —— Step 2: Iterative search + extract ——
        gathered: List[str] = []
        seen: set = set()

        for rnd in range(max_rounds):
            if rnd == 0:
                queries = sub_queries
            else:
                # Generate follow-up queries to fill gaps
                _step("analyze", "Analyzing information gaps...")
                gap_prompt = (
                    f'Research question: "{query}"\n\n'
                    f"Gathered so far:\n"
                    + "\n".join(gathered[-10:])[:3000]
                    + "\n\nWhat critical aspects are still missing? "
                    "Generate 2-3 follow-up search queries.\n"
                    "Return ONLY a JSON array of strings."
                )
                gap_raw = llm_call(gap_prompt, system="Output ONLY valid JSON.", model_override=model_override)
                try:
                    m2 = re.search(r"\[.*\]", gap_raw, re.S)
                    queries = json.loads(m2.group()) if m2 else []
                except (json.JSONDecodeError, AttributeError):
                    queries = []
                if not queries:
                    break

            _step("search", f"Round {rnd + 1}/{max_rounds}: searching...", round=rnd + 1)
            for q in queries:
                _step("search", f"Searching: {q[:80]}", round=rnd + 1)
                results = web_search(q)

                for r in results[:5]:
                    url = r.get("url", "")
                    if not url or url in seen:
                        continue
                    seen.add(url)
                    _step("extract", f"Reading: {url[:70]}...", round=rnd + 1)
                    content = web_extract(url)
                    gathered.append(f"[{url}]\n{content}")
                    add_source(url, r.get("title", q), r.get("snippet", ""), content)

        _step_done("search")
        _step_done("extract")

        # —— Step 3: Synthesize final report ——
        _step("synthesize", "Writing comprehensive report...")
        synth_prompt = (
            f"## Research Question\n{query}\n\n"
            f"## Gathered Information\n"
            + "\n---\n".join(gathered[:12])[:8000]
            + "\n\n"
            "Write a comprehensive, well-structured research report.\n"
            "Use inline citations [1], [2] etc referring to sources.\n"
            "Include:\n"
            "1. **Executive Summary** (2-3 sentences)\n"
            "2. **Key Findings** (organized by theme)\n"
            "3. **Detailed Analysis**\n"
            "4. **Sources** (numbered list of URLs)\n\n"
            "Format in clean markdown."
        )
        report = llm_call(synth_prompt,
                          system="You are a deep research analyst. Write "
                                 "detailed, accurate, well-cited reports in markdown.",
                          model_override=model_override)

        _step_done("synthesize")
        job["report"] = report
        job["status"] = "completed"
        _step("done", f"Complete — {len(job['sources'])} sources analyzed")

        # Persist report to Kanban parent task comment
        if parent_id:
            try:
                _kanban_add_report(parent_id, report)
                _kanban_complete(parent_id)
            except Exception:
                pass

        # Also persist to JSON for backward compat
        out = _data_dir() / f"{job_id}.json"
        with open(out, "w") as f:
            json.dump({
                "id": job_id,
                "query": query,
                "status": job["status"],
                "current_step": job["current_step"],
                "error": job.get("error"),
                "mode": job.get("mode", "auto"),
                "max_rounds": job.get("max_rounds", 3),
                "folder": job.get("folder", "default"),
                "report": report,
                "sources": job["sources"],
                "steps": job["steps"],
                "created_at": job["created_at"],
                "completed_at": time.time(),
                "kanban_parent_id": parent_id,
            }, f, indent=2, ensure_ascii=False)

    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc)
        _step("error", str(exc))
        if parent_id:
            try:
                _kanban_update_status(parent_id, "blocked")
            except Exception:
                pass

    # Cleanup: remove from in-memory dict after 5 min to avoid leaks
    def _cleanup():
        time.sleep(300)
        with _lock:
            _jobs.pop(job_id, None)
    threading.Thread(target=_cleanup, daemon=True).start()


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@router.post("/research")
def start_research(body: dict) -> dict:
    query = (body.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    if len(query) > 2000:
        return {"error": "query too long (max 2000 chars)"}

    job_id = uuid.uuid4().hex[:8]
    max_rounds = body.get("rounds") or 3
    model_override = body.get("model") or None

    # Create Kanban parent + child tasks
    parent_id = _kanban_create_task(
        title=f"DR: {query[:80]}{'...' if len(query) > 80 else ''}",
        body=f"Mode: {(body.get('mode') or 'auto').strip().lower()}\nRounds: {max_rounds}\n\nQuery:\n{query}",
    )
    child_map = {
        "decompose": _kanban_create_task("1. Decompose query", parent_id=parent_id),
        "search": _kanban_create_task("2. Web search", parent_id=parent_id),
        "extract": _kanban_create_task("3. Extract content", parent_id=parent_id),
        "synthesize": _kanban_create_task("4. Synthesize report", parent_id=parent_id),
    }

    job: Dict[str, Any] = {
        "id": job_id,
        "query": query,
        "mode": (body.get("mode") or "auto").strip().lower(),
        "max_rounds": max_rounds,
        "folder": (body.get("folder") or "default").strip(),
        "status": "running",
        "current_step": "init",
        "steps": [],
        "sources": [],
        "report": None,
        "error": None,
        "created_at": time.time(),
        "updated_at": time.time(),
        "kanban_parent_id": parent_id,
        "kanban_children": child_map,
    }
    with _lock:
        _jobs[job_id] = job

    t = threading.Thread(target=_run_research, args=(job_id, query, max_rounds, job["mode"], model_override), daemon=True)
    t.start()

    return {"id": job_id, "status": "running", "kanban_parent_id": parent_id}


@router.get("/status/{job_id}")
def get_status(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        # Fallback: try Kanban parent task
        ptask = _kanban_get_task(job_id)
        if ptask:
            children = _kanban_get_children(job_id)
            return {
                "id": job_id,
                "query": ptask.title or "",
                "status": "completed" if ptask.status == "done" else ptask.status,
                "current_step": children[-1]["title"] if children and children[-1].get("status") != "done" else "done",
                "steps": [],
                "sources_count": 0,
                "has_report": ptask.status == "done",
                "error": None,
                "updated_at": ptask.updated_at,
                "kanban_parent_id": job_id,
                "kanban_children": children,
            }
        return {"error": "not found"}
    return {
        "id": job["id"],
        "query": job["query"],
        "status": job["status"],
        "current_step": job["current_step"],
        "steps": job["steps"],
        "sources_count": len(job["sources"]),
        "has_report": job["report"] is not None,
        "error": job["error"],
        "updated_at": job["updated_at"],
        "max_rounds": job.get("max_rounds", 3),
        "folder": job.get("folder", "default"),
        "kanban_parent_id": job.get("kanban_parent_id"),
        "kanban_children": _kanban_get_children(job.get("kanban_parent_id") or "") if job.get("kanban_parent_id") else [],
    }


@router.get("/kanban/{job_id}")
def get_kanban(job_id: str) -> dict:
    """Return Kanban task details for a research job."""
    job = _jobs.get(job_id)
    parent_id = job.get("kanban_parent_id") if job else job_id
    ptask = _kanban_get_task(parent_id) if parent_id else None
    if not ptask:
        return {"error": "not found"}
    children = _kanban_get_children(parent_id)
    return {
        "parent": {
            "id": ptask.id,
            "title": ptask.title,
            "status": ptask.status,
            "body": ptask.body,
            "created_at": ptask.created_at,
            "updated_at": ptask.updated_at,
        },
        "children": children,
    }


@router.get("/results/{job_id}")
def get_results(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job:
        return {
            "id": job["id"],
            "query": job["query"],
            "status": job["status"],
            "current_step": job["current_step"],
            "report": job["report"],
            "sources": job["sources"],
            "steps": job["steps"],
            "error": job.get("error"),
            "folder": job.get("folder", "default"),
        }
    # Fallback: load from persisted JSON after memory cleanup
    fp = _data_dir() / f"{job_id}.json"
    if fp.exists():
        with open(fp) as f:
            entry = json.load(f)
        return {
            "id": entry.get("id", job_id),
            "query": entry.get("query", ""),
            "status": entry.get("status", "completed"),
            "current_step": entry.get("current_step", ""),
            "report": entry.get("report"),
            "sources": entry.get("sources", []),
            "steps": entry.get("steps", []),
            "error": entry.get("error"),
            "folder": entry.get("folder", "default"),
        }
    return {"error": "not found"}


@router.get("/history")
def list_history() -> dict:
    jobs = []
    data_dir = _data_dir()
    for fp in sorted(data_dir.glob("*.json"), reverse=True):
        try:
            with open(fp) as f:
                entry = json.load(f)
            jobs.append({
                "id": entry.get("id", fp.stem),
                "query": entry.get("query", ""),
                "mode": entry.get("mode", "auto"),
                "max_rounds": entry.get("max_rounds", 3),
                "folder": entry.get("folder", "default"),
                "sources_count": len(entry.get("sources", [])),
                "created_at": entry.get("created_at"),
                "completed_at": entry.get("completed_at"),
            })
        except Exception:
            pass
    # Also include in-memory running jobs
    with _lock:
        for jid, j in _jobs.items():
            if j["status"] == "running" and not any(x["id"] == jid for x in jobs):
                jobs.insert(0, {
                    "id": jid,
                    "query": j["query"],
                    "mode": j.get("mode", "auto"),
                    "max_rounds": j.get("max_rounds", 3),
                    "folder": j.get("folder", "default"),
                    "status": j["status"],
                    "sources_count": len(j["sources"]),
                    "created_at": j["created_at"],
                })
    return {"jobs": jobs[:50]}


@router.get("/models")
def list_models() -> dict:
    """Return available models from Hermes config + live endpoint discovery."""
    cfg = _read_hermes_config()
    models = []
    seen = set()
    providers = _all_providers(cfg)
    for name, p in providers.items():
        pname = p.get("name", name)
        model = p.get("model", "")
        base_url = p.get("base_url", "")
        if model:
            key = f"{name}:{model}"
            if key not in seen:
                seen.add(key)
                models.append({
                    "provider": pname,
                    "provider_id": name,
                    "model": model,
                    "display": f"({pname}) {model}",
                    "value": f"{name}:{model}",
                    "base_url": base_url,
                })
        # Also probe /v1/models for endpoints (local servers like LM Studio, Ollama)
        if base_url:
            try:
                from urllib.request import Request, urlopen
                models_url = base_url.rstrip("/") + "/v1/models"
                req = Request(models_url, headers={"User-Agent": "Hermes/1.0"})
                with urlopen(req, timeout=5) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="replace"))
                for m in data.get("data", []):
                    mid = m.get("id", "")
                    if mid and mid not in seen:
                        seen.add(mid)
                        models.append({
                            "provider": pname,
                            "provider_id": name,
                            "model": mid,
                            "display": f"({pname}) {mid}",
                            "value": f"{name}:{mid}",
                            "base_url": base_url,
                        })
            except Exception:
                pass
    # Also check profiles
    profiles_dir = get_hermes_home() / "profiles"
    if profiles_dir.is_dir():
        for prof_entry in profiles_dir.iterdir():
            if not prof_entry.is_dir():
                continue
            cfg_path = prof_entry / "config.yaml"
            if cfg_path.exists():
                try:
                    import yaml as _yaml  # type: ignore
                    with open(cfg_path) as f:
                        pcfg = _yaml.safe_load(f) or {}
                    for pname, p in (pcfg.get("providers") or {}).items():
                        pm = p.get("model", "")
                        if pm:
                            key = f"prof:{prof_entry.name}:{pname}:{pm}"
                            if key not in seen:
                                seen.add(key)
                                models.append({
                                    "provider": p.get("name", pname),
                                    "provider_id": pname,
                                    "model": pm,
                                    "display": f"[{prof_entry.name}] ({p.get('name', pname)}) {pm}",
                                    "value": f"{prof_entry.name}:{pname}:{pm}",
                                    "base_url": p.get("base_url", ""),
                                    "profile": prof_entry.name,
                                })
                except Exception:
                    pass
    return {"models": models}


@router.post("/queue")
def queue_research(body: dict) -> dict:
    query = (body.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    entry = {
        "id": uuid.uuid4().hex[:8],
        "query": query,
        "mode": (body.get("mode") or "auto").strip().lower(),
        "rounds": body.get("rounds") or None,
        "engine": body.get("engine") or None,
        "model": body.get("model") or None,
        "queued_at": time.time(),
    }
    with _lock:
        _queue.append(entry)
    return {"id": entry["id"], "status": "queued"}


@router.delete("/delete/{job_id}")
def delete_job(job_id: str) -> dict:
    # Remove from memory
    with _lock:
        _jobs.pop(job_id, None)
    # Remove persisted file
    fp = _data_dir() / f"{job_id}.json"
    if fp.exists():
        fp.unlink()
    return {"deleted": job_id}


@router.delete("/clear")
def clear_all() -> dict:
    with _lock:
        _jobs.clear()
        _queue.clear()
    data_dir = _data_dir()
    for fp in data_dir.glob("*.json"):
        try:
            fp.unlink()
        except Exception:
            pass
    return {"cleared": True}
