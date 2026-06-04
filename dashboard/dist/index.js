/* —— Deep Research Agent Graph ——
   Canvas 2D force-directed mini-graph.
   Root = orchestrator, children = research steps & documents.
   No deps, 60fps, Hermes-themed.
*/

(function (global) {
  "use strict";

  var TAU = Math.PI * 2;
  var COLORS = {
    root:  "#22d3ee",
    agent: "#a78bfa",
    step:  "#60a5fa",
    doc:   "#34d399",
    error: "#f87171",
    edge:  "#475569",
    glow:  "rgba(34,211,238,0.25)",
    text:  "#e2e8f0",
  };

  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx*dx + dy*dy); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* —— Node —— */
  function Node(id, type, label, parent) {
    this.id = id;
    this.type = type;        /* root | agent | step | doc | error */
    this.label = label;
    this.parent = parent || null;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.radius = type === "root" ? 20 : type === "agent" ? 14 : type === "step" ? 10 : 7;
    this.targetR = this.radius;
    this.birth = performance.now();
    this.state = "spawn";    /* spawn | idle | active | done | error */
    this.progress = 0;       /* 0-1 fill arc for active steps */
    this.pulse = 0;
  }

  Node.prototype.color = function () {
    if (this.state === "error") return COLORS.error;
    if (this.type === "root") return COLORS.root;
    if (this.type === "agent") return COLORS.agent;
    if (this.type === "doc") return COLORS.doc;
    return COLORS.step;
  };

  /* —— Graph —— */
  function AgentGraph(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.nodes = [];
    this.edges = [];         /* {from, to, dashOffset} */
    this.root = null;
    this.running = false;
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    this._boundStep = this.step.bind(this);
    this._onResize = this.resize.bind(this);
    window.addEventListener("resize", this._onResize);
  }

  AgentGraph.prototype.resize = function () {
    var c = this.canvas, rect = c.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    c.width = this.w * this.dpr;
    c.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  AgentGraph.prototype.destroy = function () {
    this.running = false;
    window.removeEventListener("resize", this._onResize);
  };

  AgentGraph.prototype.setRoot = function (label) {
    this.nodes = [];
    this.edges = [];
    this.root = new Node("root", "root", label || "Orchestrator");
    this.root.x = this.w / 2;
    this.root.y = this.h / 2;
    this.root.state = "idle";
    this.nodes.push(this.root);
    this.start();
  };

  AgentGraph.prototype.addNode = function (id, type, label, parentId) {
    var parent = parentId ? this.nodes.find(function (n) { return n.id === parentId; }) : this.root;
    if (!parent) parent = this.root;
    var node = new Node(id, type, label, parent);
    /* Spawn near parent, then drift outward */
    var angle = Math.random() * TAU;
    var r = parent.radius + 40 + Math.random() * 60;
    node.x = parent.x + Math.cos(angle) * r;
    node.y = parent.y + Math.sin(angle) * r;
    this.nodes.push(node);
    this.edges.push({ from: parent, to: node, dashOffset: 0, born: performance.now() });
    return node;
  };

  AgentGraph.prototype.setState = function (id, state, progress) {
    var n = this.nodes.find(function (x) { return x.id === id; });
    if (!n) return;
    n.state = state;
    if (progress != null) n.progress = clamp(progress, 0, 1);
  };

  AgentGraph.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this._boundStep);
  };

  /* —— Physics + Render loop —— */
  AgentGraph.prototype.step = function (ts) {
    if (!this.running) return;
    this.physics(ts);
    this.draw(ts);
    requestAnimationFrame(this._boundStep);
  };

  AgentGraph.prototype.physics = function (ts) {
    var nodes = this.nodes, root = this.root, w = this.w, h = this.h;
    var i, j, a, b, dx, dy, d, f;

    /* Root stays centered but drifts slightly */
    root.vx += (w/2 - root.x) * 0.02;
    root.vy += (h/2 - root.y) * 0.02;
    root.vx *= 0.85; root.vy *= 0.85;
    root.x += root.vx; root.y += root.vy;

    /* Repulsion + spring to parent + orbital drift */
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      if (a === root) continue;

      /* Spring toward parent */
      var ideal = a.type === "agent" ? 180 : a.type === "step" ? 120 : 80;
      dx = a.x - a.parent.x; dy = a.y - a.parent.y;
      d = Math.sqrt(dx*dx + dy*dy) || 1;
      f = (d - ideal) * 0.015;
      a.vx -= (dx / d) * f;
      a.vy -= (dy / d) * f;

      /* Repulsion from all other nodes */
      for (j = 0; j < nodes.length; j++) {
        b = nodes[j];
        if (a === b) continue;
        dx = a.x - b.x; dy = a.y - b.y;
        d = Math.sqrt(dx*dx + dy*dy) || 1;
        var minDist = a.radius + b.radius + 20;
        if (d < minDist) {
          f = (minDist - d) * 0.08;
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
        }
      }

      /* Dampen & integrate */
      a.vx *= 0.92; a.vy *= 0.92;
      a.x += a.vx; a.y += a.vy;

      /* Bounds */
      a.x = clamp(a.x, a.radius + 4, w - a.radius - 4);
      a.y = clamp(a.y, a.radius + 4, h - a.radius - 4);
    }
  };

  AgentGraph.prototype.draw = function (ts) {
    var ctx = this.ctx, w = this.w, h = this.h;
    ctx.clearRect(0, 0, w, h);

    /* Grid background (subtle) */
    ctx.strokeStyle = "rgba(71,85,105,0.15)";
    ctx.lineWidth = 1;
    var gs = 40;
    for (var gx = 0; gx < w; gx += gs) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
    for (var gy = 0; gy < h; gy += gs) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

    /* Edges */
    for (var e = 0; e < this.edges.length; e++) {
      var edge = this.edges[e];
      var age = (ts - edge.born) / 600;
      var alpha = age < 1 ? age : 1;
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = COLORS.edge;
      ctx.lineWidth = edge.to.type === "error" ? 2.5 : 1.5;
      ctx.setLineDash(edge.to.state === "active" ? [6, 4] : []);
      if (edge.to.state === "active") {
        edge.dashOffset -= 0.6;
        ctx.lineDashOffset = edge.dashOffset;
      }
      ctx.beginPath();
      ctx.moveTo(edge.from.x, edge.from.y);
      ctx.lineTo(edge.to.x, edge.to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.globalAlpha = 1;
    }

    /* Nodes */
    for (var k = 0; k < this.nodes.length; k++) {
      var n = this.nodes[k];
      var life = (ts - n.birth) / 400;
      var scale = n.state === "spawn" ? Math.min(1, life) : 1;
      if (n.state === "spawn" && scale >= 1) n.state = "idle";

      /* Pulse for active/root */
      var pulse = 0;
      if (n.state === "active" || n.type === "root") {
        n.pulse = (n.pulse + 0.04) % TAU;
        pulse = Math.sin(n.pulse) * 4;
      }
      var r = (n.radius + pulse) * scale;
      var cx = n.x, cy = n.y;
      var color = n.color();

      /* Glow */
      if (n.state === "active" || n.type === "root") {
        var g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.5);
        g.addColorStop(0, color.replace(")", ",0.3)").replace("rgb", "rgba"));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 2.5, 0, TAU);
        ctx.fill();
      }

      /* Body */
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();

      /* Progress ring for active steps */
      if (n.state === "active" && n.progress > 0) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 4, -Math.PI / 2, -Math.PI / 2 + n.progress * TAU);
        ctx.stroke();
      }

      /* Border */
      ctx.strokeStyle = n.state === "error" ? "#ef4444" : "#1e293b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();

      /* Label */
      ctx.fillStyle = COLORS.text;
      ctx.font = (n.type === "root" || n.type === "agent" ? "bold 12px" : "11px") + " system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(n.label, cx, cy + r + 14);
    }
  };

  global.AgentGraph = AgentGraph;
})(window);

(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;

  var React = SDK.React;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useCallback = SDK.hooks.useCallback;
  var useRef = SDK.hooks.useRef;
  var useMemo = SDK.hooks.useMemo;

  var API_BASE = "/api/plugins/deep-research";

  function apiFetch(path, opts) {
    var token = window.__HERMES_SESSION_TOKEN__ || "";
    var headers = Object.assign({}, (opts && opts.headers) || {});
    if (token) headers["X-Hermes-Session-Token"] = token;
    return fetch(API_BASE + path, Object.assign({}, opts, { headers: headers }))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  var MODES = ["auto", "product", "compare", "how-to", "fact-check"];
  var STEP_ICONS = { init: "◉", decompose: "⑂", analyze: "⊕", search: "⊘", extract: "↓", synthesize: "✦", done: "✓", error: "✕" };
  var STEP_LABELS = { init: "Initializing", decompose: "Planning", analyze: "Analyzing gaps", search: "Searching", extract: "Extracting", synthesize: "Writing report", done: "Complete", error: "Error" };

  function md(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
      .replace(/\n\n/g, "<br/><br/>");
  }

  function fmtDuration(secs) {
    if (!secs) return "--:--";
    var m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* —— Agent Graph Canvas —— */
  function AgentGraphCanvas(props) {
    var job = props.job;
    var canvasRef = useRef(null);
    var graphRef = useRef(null);
    useEffect(function () {
      if (!canvasRef.current) return;
      var graph = new AgentGraph(canvasRef.current);
      graph.setRoot("Orchestrator");
      var maxRounds = job.max_rounds || 3;
      var stepNames = ["Decompose", "Search", "Analyze", "Synthesize"];
      for (var r = 1; r <= maxRounds; r++) {
        var agentId = "agent-" + job.id + "-r" + r;
        graph.addNode(agentId, "agent", "R" + r, "root");
        graph.setState(agentId, "idle", 0);
        stepNames.forEach(function (name, i) {
          var sid = "step-" + job.id + "-r" + r + "-" + i;
          graph.addNode(sid, "step", name, agentId);
          graph.setState(sid, "idle", 0);
        });
      }
      graphRef.current = graph;
      return function () { graph.destroy(); };
    }, [job.id]);
    useEffect(function () {
      if (!graphRef.current) return;
      var graph = graphRef.current;
      var maxRounds = job.max_rounds || 3;
      var stepNames = ["Decompose", "Search", "Analyze", "Synthesize"];
      for (var r = 1; r <= maxRounds; r++) {
        var agentId = "agent-" + job.id + "-r" + r;
        if (job.status === "error") {
          graph.setState(agentId, "error", 1);
        } else if (job.status === "done") {
          graph.setState(agentId, "done", 1);
        } else {
          graph.setState(agentId, "active", 0.5);
        }
      }
      var steps = job.steps || [];
      // Reset all steps to idle
      for (var r2 = 1; r2 <= maxRounds; r2++) {
        stepNames.forEach(function (_name, i) {
          var sid = "step-" + job.id + "-r" + r2 + "-" + i;
          graph.setState(sid, "idle", 0);
        });
      }
      steps.forEach(function (s) {
        var round = s.round || 1;
        if (round < 1) round = 1;
        if (round > maxRounds) round = maxRounds;
        var stepName = s.step.charAt(0).toUpperCase() + s.step.slice(1);
        var stepIdx = stepNames.indexOf(stepName);
        if (stepIdx < 0) {
          // fuzzy match
          stepNames.forEach(function (n, i) {
            if (n.toLowerCase() === s.step.toLowerCase()) stepIdx = i;
          });
        }
        if (stepIdx < 0) return;
        var sid = "step-" + job.id + "-r" + round + "-" + stepIdx;
        if (s.step === "done" || s.step === "synthesize") graph.setState(sid, "done", 1);
        else if (s.step === "error") graph.setState(sid, "error", 1);
        else if (s.step === job.current_step) graph.setState(sid, "active", 0.3);
        else graph.setState(sid, "idle", 0);
      });
      /* If no steps yet, light up current_step in round 1 */
      if (!steps.length && job.current_step) {
        stepNames.forEach(function (name, i) {
          if (name.toLowerCase() === job.current_step.toLowerCase()) {
            var sid = "step-" + job.id + "-r1-" + i;
            graph.setState(sid, "active", 0.3);
          }
        });
      }
    }, [job.status, job.steps, job.current_step]);
    return React.createElement("div", { className: "rounded-md border border-border overflow-hidden", style: { height: 200, background: "#0b1220" } },
      React.createElement("canvas", { ref: canvasRef, style: { width: "100%", height: "100%", display: "block" } })
    );
  }

  /* —— Progress —— */
  function ProgressTracker(props) {
    var steps = props.steps, current = props.current, error = props.error, kanbanData = props.kanbanData;
    var unique = [], seen = {};
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i], key = s.step + "-" + s.detail;
      if (!seen[key]) { seen[key] = true; unique.push(s); }
    }
    if (!unique.length && !error && !(kanbanData && kanbanData.children && kanbanData.children.length)) return null;
    var children = kanbanData && kanbanData.children || [];
    return React.createElement("div", { className: "space-y-1.5 mt-3 max-h-60 overflow-y-auto" },
      children.length > 0 && React.createElement("div", { className: "flex gap-2 mb-2" },
        children.map(function (c) {
          var statusStyle = c.status === "done" ? { background: "var(--color-primary)" } : c.status === "running" ? { background: "var(--color-ring)" } : { background: "var(--color-muted-foreground)" };
          return React.createElement("div", { key: c.id, className: "flex-1 rounded-md border border-border p-2 text-xs" },
            React.createElement("div", { className: "flex items-center gap-1.5 mb-1" },
              React.createElement("div", { className: "w-2 h-2 rounded-full", style: statusStyle }),
              React.createElement("span", { className: "font-semibold truncate" }, c.title)
            ),
            React.createElement("div", { className: "text-[10px] text-muted-foreground uppercase tracking-wider" }, c.status)
          );
        })
      ),
      unique.map(function (s, idx) {
        var active = s.step === current;
        return React.createElement("div", { key: idx, className: "flex gap-2.5 items-start py-1.5 px-2 rounded-md text-xs " + (active ? "text-foreground bg-accent/50" : "text-muted-foreground") },
          React.createElement("span", { className: "text-sm flex-shrink-0 w-5 text-center" }, STEP_ICONS[s.step] || "●"),
          React.createElement("div", null,
            React.createElement("div", { className: "font-semibold uppercase tracking-wider" }, STEP_LABELS[s.step] || s.step),
            s.detail && React.createElement("div", { className: "text-[11px] text-muted-foreground truncate max-w-[500px]" }, s.detail)
          )
        );
      }),
      error && React.createElement("div", { className: "flex gap-2.5 items-start py-1.5 px-2 rounded-md text-xs text-destructive" },
        React.createElement("span", { className: "text-sm flex-shrink-0 w-5 text-center" }, "✕"),
        React.createElement("div", { className: "font-semibold uppercase tracking-wider" }, "Error"),
        React.createElement("div", { className: "text-[11px] truncate max-w-[500px]" }, error)
      )
    );
  }

  /* ── Report ── */
  function ReportView(props) {
    var report = props.report, sources = props.sources;
    return React.createElement("div", { className: "mt-4 rounded-lg border border-border bg-card overflow-hidden" },
      React.createElement("div", { className: "px-4 py-3 border-b border-border" },
        React.createElement("div", { className: "text-sm font-semibold uppercase tracking-wider text-foreground" }, "Research Report")
      ),
      React.createElement("div", { className: "p-4 text-sm leading-relaxed text-muted-foreground dr-report-body", dangerouslySetInnerHTML: { __html: md(report) } }),
      sources && sources.length > 0 && React.createElement("div", { className: "mt-2 pt-3 border-t border-border" },
        React.createElement("div", { className: "flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground mb-2" },
          React.createElement("span", null, "Sources"),
          React.createElement("span", { className: "dr-tag" }, String(sources.length))
        ),
        React.createElement("div", { className: "flex flex-col gap-1 max-h-60 overflow-y-auto" },
          sources.map(function (s, i) {
            return React.createElement("a", { key: i, href: s.url, target: "_blank", rel: "noopener noreferrer", className: "dr-source" },
              React.createElement("span", { className: "dr-source-idx" }, String(i + 1)),
              React.createElement("div", null,
                React.createElement("div", { className: "dr-source-title" }, s.title || s.url),
                s.snippet && React.createElement("div", { className: "dr-source-snippet" }, s.snippet)
              )
            );
          })
        )
      )
    );
  }

  /* ── Past Item ── */
  function PastItem(props) {
    var job = props.job, onLoadReport = props.onLoadReport, onDiscuss = props.onDiscuss, onDelete = props.onDelete, onCopy = props.onCopy;
    var elapsed = job.completed_at && job.created_at ? fmtDuration(job.completed_at - job.created_at) : null;
    var running = job.status === "running";
    return React.createElement("div", { className: "dr-past-item" },
      React.createElement("div", { className: "flex items-center gap-2 px-3 py-2.5 flex-wrap" },
        React.createElement("div", { className: "text-sm font-medium text-foreground truncate flex-1 min-w-[150px]" }, job.query),
        React.createElement("span", { className: "dr-tag" }, job.mode || "auto"),
        React.createElement("div", { className: "flex items-center gap-2 text-xs text-muted-foreground" },
          running ? React.createElement("div", { className: "dr-spinner" }) : null,
          elapsed && React.createElement("span", null, elapsed),
          job.sources_count > 0 && React.createElement("span", null, job.sources_count + " sources")
        )
      ),
      React.createElement("div", { className: "flex items-center gap-2 px-3 py-2 border-t border-border/50" },
        React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-border text-muted-foreground text-xs hover:border-ring hover:text-foreground transition-colors", onClick: function () { onCopy(job); }, title: "Copy" }, "⧉"),
        React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-border text-muted-foreground text-xs hover:border-ring hover:text-foreground transition-colors", onClick: function () { onDiscuss(job); }, title: "Discuss" }, "💬 Discuss"),
        React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-ring text-foreground text-xs hover:bg-accent transition-colors", onClick: function () { onLoadReport(job.id); }, title: "View report" }, "📊 Report"),
        React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-destructive/30 text-destructive text-xs hover:border-destructive hover:bg-destructive/10 transition-colors", onClick: function () { onDelete(job.id); }, title: "Delete" }, "🗑 Delete")
      )
    );
  }

  /* ── Main ── */
  function DeepResearchPage() {
    var _q = useState(""); var query = _q[0], setQuery = _q[1];
    var _mode = useState("auto"); var mode = _mode[0], setMode = _mode[1];
    var _settingsOpen = useState(false); var settingsOpen = _settingsOpen[0], setSettingsOpen = _settingsOpen[1];
    var _rounds = useState("auto"); var rounds = _rounds[0], setRounds = _rounds[1];
    var _engine = useState("default"); var engine = _engine[0], setEngine = _engine[1];
    var _endpoint = useState("default"); var endpoint = _endpoint[0], setEndpoint = _endpoint[1];
    var _model = useState("default"); var model = _model[0], setModel = _model[1];
    var _availableModels = useState([]); var availableModels = _availableModels[0], setAvailableModels = _availableModels[1];
    var _activeJobs = useState([]); var activeJobs = _activeJobs[0], setActiveJobs = _activeJobs[1];
    var _pastJobs = useState([]); var pastJobs = _pastJobs[0], setPastJobs = _pastJobs[1];
    var _report = useState(null); var report = _report[0], setReport = _report[1];
    var _reportSources = useState([]); var reportSources = _reportSources[0], setReportSources = _reportSources[1];
    var _loading = useState(false); var loading = _loading[0], setLoading = _loading[1];
    var _historyLoading = useState(true); var historyLoading = _historyLoading[0], setHistoryLoading = _historyLoading[1];
    var _kanban = useState({}); var kanbanMap = _kanban[0], setKanban = _kanban[1];
    var _archiveOpen = useState(false); var archiveOpen = _archiveOpen[0], setArchiveOpen = _archiveOpen[1];
    var pollRefs = useRef({});

    function startPolling(jobId) {
      if (pollRefs.current[jobId]) return;
      pollRefs.current[jobId] = setInterval(function () {
        apiFetch("/status/" + jobId).then(function (s) {
          setActiveJobs(function (prev) { return prev.map(function (j) { return j.id === jobId ? Object.assign({}, j, s) : j; }); });
          if (s.status !== "running") {
            clearInterval(pollRefs.current[jobId]);
            delete pollRefs.current[jobId];
            fetchHistory();
            if (s.status === "error") {
              return apiFetch("/results/" + jobId).then(function (r) {
                setReport("## ❌ Research Failed\n\n**Error:** " + (r.error || "Unknown error") + "\n\n**Query:** " + r.query);
                setReportSources(r.sources || []);
                return null;
              });
            }
            if (s.has_report) {
              return apiFetch("/results/" + jobId).then(function (r) { setReport(r.report); setReportSources(r.sources || []); return null; });
            }
          }
          return null;
        }).catch(function () {});
        // Parallel Kanban poll
        apiFetch("/kanban/" + jobId).then(function (k) {
          setKanban(function (prev) { var n = Object.assign({}, prev); n[jobId] = k; return n; });
        }).catch(function () {});
      }, 2000);
    }

    function fetchHistory() {
      setHistoryLoading(true);
      apiFetch("/history").then(function (data) {
        var jobs = data.jobs || [], active = [], past = [];
        for (var i = 0; i < jobs.length; i++) {
          if (jobs[i].status === "running") active.push(jobs[i]); else past.push(jobs[i]);
        }
        setActiveJobs(active); setPastJobs(past); setHistoryLoading(false);
        active.forEach(function (j) { startPolling(j.id); });
      }).catch(function () { setHistoryLoading(false); });
    }

    useEffect(function () { fetchHistory(); apiFetch("/models").then(function (d) { setAvailableModels(d.models || []); }).catch(function () {}); }, []);
    useEffect(function () {
      var refs = pollRefs.current;
      return function () { Object.keys(refs).forEach(function (k) { clearInterval(refs[k]); }); };
    }, []);

    var handleSubmit = useCallback(function () {
      var q = query.trim();
      if (!q || loading) return;
      setLoading(true);
      apiFetch("/research", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, mode: mode, rounds: rounds === "auto" ? null : parseInt(rounds, 10), engine: engine === "default" ? null : engine, model: model === "default" ? null : model })
      }).then(function (data) {
        var newJob = { id: data.id, query: q, mode: mode, status: "running", current_step: "init", steps: [], sources_count: 0, has_report: false, created_at: Date.now() / 1000, kanban_parent_id: data.kanban_parent_id };
        setActiveJobs(function (prev) { return [newJob].concat(prev); });
        startPolling(data.id); setQuery(""); setLoading(false);
      }).catch(function () { setLoading(false); });
    }, [query, mode, loading, rounds, engine, model]);

    var handleQueue = useCallback(function () {
      var q = query.trim();
      if (!q) return;
      apiFetch("/queue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, mode: mode, rounds: rounds === "auto" ? null : parseInt(rounds, 10), engine: engine === "default" ? null : engine, model: model === "default" ? null : model })
      }).then(function () { setQuery(""); fetchHistory(); }).catch(function () {});
    }, [query, mode, rounds, engine, model]);

    var loadReport = useCallback(function (id) {
      apiFetch("/results/" + id).then(function (r) {
        if (r.status === "error") {
          setReport("## ❌ Research Failed\n\n**Error:** " + (r.error || "Unknown error") + "\n\n**Query:** " + r.query);
          setReportSources(r.sources || []);
        } else if (!r.report) {
          setReport("## ⏳ Report not ready\n\nThe research is still in progress. Check back soon.");
          setReportSources(r.sources || []);
        } else {
          setReport(r.report);
          setReportSources(r.sources || []);
        }
      }).catch(function () {});
    }, []);

    var deleteJob = useCallback(function (id) {
      apiFetch("/delete/" + id, { method: "DELETE" }).then(function () { fetchHistory(); }).catch(function () {});
    }, []);

    var clearAll = useCallback(function () {
      apiFetch("/clear", { method: "DELETE" }).then(function () { fetchHistory(); setReport(null); }).catch(function () {});
    }, []);

    var copyReport = useCallback(function (job) {
      apiFetch("/results/" + job.id).then(function (r) { if (navigator.clipboard && r.report) navigator.clipboard.writeText(r.report); }).catch(function () {});
    }, []);

    var discussJob = useCallback(function (job) {
      apiFetch("/results/" + job.id).then(function (r) {
        var summary = r.report ? r.report.substring(0, 2000) : job.query;
        if (window.__HERMES_SEND_MESSAGE__) window.__HERMES_SEND_MESSAGE__("Discuss this research:\n\n" + summary);
      }).catch(function () {});
    }, []);

    var hasRunning = activeJobs.length > 0;
    var totalResearch = activeJobs.length + pastJobs.length;

    return React.createElement("div", { className: "dr-page" },
      /* Header */
      React.createElement("div", { className: "flex items-center gap-3 mb-6" },
        React.createElement("span", { className: "text-2xl dr-header-icon" }, "🔍"),
        React.createElement("span", { className: "text-xl font-bold tracking-widest uppercase text-foreground" }, "Deep Research")
      ),
      /* Main Research Card */
      React.createElement("div", { className: "rounded-lg border border-border bg-card overflow-hidden" },
        /* Card header */
        React.createElement("div", { className: "flex items-center justify-between px-4 pt-3 pb-2" },
          React.createElement("div", { className: "flex items-center gap-2" },
            React.createElement("span", { className: "text-sm font-semibold uppercase tracking-wider text-foreground" }, "Research"),
            React.createElement("span", { className: "text-xs text-muted-foreground" }, totalResearch + " research")
          ),
          React.createElement("div", { className: "text-xs text-muted-foreground flex items-center gap-1" }, "✋ Multi-step web research with an LLM-in-the-loop agent")
        ),
        /* Card body */
        React.createElement("div", { className: "px-4 pb-4" },
          /* Textarea */
          React.createElement("textarea", {
            className: "dr-textarea",
            placeholder: "e.g. Trace Odysseus's ten-year journey home from Troy — every island, monster, and detour, and why each one cost him",
            value: query,
            onChange: function (e) { setQuery(e.target.value); },
            disabled: loading
          }),
          /* Mode chips */
          React.createElement("div", { className: "flex gap-2 mt-3 flex-wrap" },
            MODES.map(function (m) {
              return React.createElement("button", {
                key: m, className: "dr-chip" + (mode === m ? " dr-chip-active" : ""),
                onClick: function () { setMode(m); }
              }, m.charAt(0).toUpperCase() + m.slice(1));
            })
          ),
          /* Settings toggle */
          React.createElement("button", { className: "w-full flex items-center justify-between mt-3 py-2 px-3 rounded-md border border-border text-muted-foreground text-xs hover:border-ring hover:text-foreground transition-colors cursor-pointer", onClick: function () { setSettingsOpen(!settingsOpen); } },
            React.createElement("span", null, "⚙ Settings"),
            React.createElement("span", { className: "transition-transform text-[10px]" + (settingsOpen ? " rotate-180" : "") }, "▼")
          ),
          /* Settings panel */
          settingsOpen && React.createElement("div", { className: "mt-2 p-3 rounded-md border border-border bg-secondary" },
            React.createElement("div", { className: "dr-modes-grid grid grid-cols-3 gap-3 mb-3" },
              React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("label", { className: "text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" }, "Rounds"),
                React.createElement("select", { className: "dr-select", value: rounds, onChange: function (e) { setRounds(e.target.value); } },
                  React.createElement("option", { value: "auto" }, "Auto"),
                  React.createElement("option", { value: "1" }, "1"),
                  React.createElement("option", { value: "2" }, "2"),
                  React.createElement("option", { value: "3" }, "3"),
                  React.createElement("option", { value: "5" }, "5")
                )
              ),
              React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("label", { className: "text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" }, "Search Engine"),
                React.createElement("select", { className: "dr-select", value: engine, onChange: function (e) { setEngine(e.target.value); } },
                  React.createElement("option", { value: "default" }, "Default"),
                  React.createElement("option", { value: "brave" }, "Brave"),
                  React.createElement("option", { value: "duckduckgo" }, "DuckDuckGo")
                )
              ),
              React.createElement("div", { className: "flex flex-col gap-1" },
                React.createElement("label", { className: "text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" }, "Endpoint"),
                React.createElement("select", { className: "dr-select", value: endpoint, onChange: function (e) { setEndpoint(e.target.value); } },
                  React.createElement("option", { value: "default" }, "Default"),
                  React.createElement("option", { value: "local" }, "Local")
                )
              )
            ),
            React.createElement("div", { className: "flex flex-col gap-1" },
              React.createElement("label", { className: "text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" }, "Model"),
              React.createElement("select", { className: "dr-select", value: model, onChange: function (e) { setModel(e.target.value); } },
                React.createElement("option", { value: "default" }, "Default"),
                availableModels.map(function (m) {
                  return React.createElement("option", { key: m.value, value: m.value }, m.display);
                })
              )
            )
          ),
          /* Actions */
          React.createElement("div", { className: "flex justify-end gap-2 mt-4" },
            React.createElement("button", { className: "flex items-center gap-1.5 px-3 py-2 rounded-md border border-border text-muted-foreground text-sm font-medium hover:border-ring hover:text-foreground transition-colors", onClick: handleQueue, disabled: !query.trim() }, "+ Queue"),
            React.createElement("button", { className: "flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors", onClick: handleSubmit, disabled: !query.trim() || loading },
              React.createElement("span", { className: "text-xs" }, "▶"),
              "Start"
            )
          )
        ),
        /* Active jobs inline */
        activeJobs.map(function (j) {
          return React.createElement("div", { key: j.id, className: "mt-3" },
            React.createElement(AgentGraphCanvas, { job: j }),
            React.createElement(ProgressTracker, { steps: j.steps || [], current: j.current_step, error: j.error, kanbanData: kanbanMap[j.id] })
          );
        })
      ),
      /* Inline report */
      report && React.createElement(ReportView, { report: report, sources: reportSources }),
      /* Past Research */
      React.createElement("div", { className: "dr-section-gap" },
        React.createElement("div", { className: "flex items-center justify-between mb-3 flex-wrap gap-2" },
          React.createElement("div", { className: "flex items-center gap-2" },
            React.createElement("span", { className: "text-sm font-semibold uppercase tracking-wider text-foreground" }, "Past research"),
            React.createElement("span", { className: "text-xs text-muted-foreground" }, pastJobs.length + " research")
          ),
          React.createElement("div", { className: "flex items-center gap-2" },
            pastJobs.length > 0 && React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-border text-muted-foreground text-xs hover:border-ring hover:text-foreground transition-colors", onClick: function () { setArchiveOpen(true); } }, "📦 Archive"),
            hasRunning && React.createElement("div", { className: "w-2 h-2 rounded-full flex-shrink-0", style: { background: "var(--color-primary)" } }),
            React.createElement("div", { className: "text-xs text-muted-foreground" }, "Showing last 3")
          )
        ),
        pastJobs.length === 0 && !historyLoading
          ? React.createElement("div", { className: "p-8 text-center text-muted-foreground text-sm" }, "No past research yet. Start your first deep research above.")
          : React.createElement("div", { className: "flex flex-col gap-2" },
              pastJobs.slice(0, 3).map(function (j) {
                return React.createElement(PastItem, { key: j.id, job: j, onLoadReport: loadReport, onDiscuss: discussJob, onDelete: deleteJob, onCopy: copyReport });
              })
            )
      ),
      /* Archive Overlay */
      archiveOpen && React.createElement("div", { className: "dr-overlay", onClick: function () { setArchiveOpen(false); } },
        React.createElement("div", { className: "dr-overlay-box", onClick: function (e) { e.stopPropagation(); } },
          React.createElement("div", { className: "dr-overlay-header" },
            React.createElement("span", { className: "text-sm font-semibold uppercase tracking-wider text-foreground" }, "Archive (" + pastJobs.length + ")"),
            React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-border text-muted-foreground text-xs hover:border-ring hover:text-foreground transition-colors", onClick: function () { setArchiveOpen(false); } }, "✕ Close")
          ),
          React.createElement("div", { className: "dr-overlay-scroll" },
            pastJobs.length === 0
              ? React.createElement("div", { className: "p-8 text-center text-muted-foreground text-sm" }, "No archived research.")
              : pastJobs.map(function (j) {
                  var elapsed = j.completed_at && j.created_at ? fmtDuration(j.completed_at - j.created_at) : null;
                  return React.createElement("div", { key: j.id, className: "dr-archive-row" },
                    React.createElement("span", { className: "dr-tag" }, j.mode || "auto"),
                    React.createElement("span", { className: "query" }, j.query),
                    React.createElement("span", { className: "meta" }, elapsed || ""),
                    React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-ring text-foreground text-xs hover:bg-accent transition-colors flex-shrink-0", onClick: function () { loadReport(j.id); setArchiveOpen(false); } }, "📊 Report"),
                    React.createElement("button", { className: "flex items-center gap-1 px-2 py-1 rounded-md border border-destructive/30 text-destructive text-xs hover:border-destructive hover:bg-destructive/10 transition-colors flex-shrink-0", onClick: function () { deleteJob(j.id); } }, "🗑 Delete")
                  );
                })
          )
        )
      )
    );
  }

  window.__HERMES_PLUGINS__.register("deep-research", DeepResearchPage);
})();
