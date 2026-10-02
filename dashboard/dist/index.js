/* —— Deep Research Agent Graph ——
   Canvas 2D force-directed mini-graph.
   Root = orchestrator, children = research steps & documents.
   No deps, 60fps, Hermes-themed.
*/

(function (global) {
  "use strict";

  var TAU = Math.PI * 2;
  var COLORS = {
    root:  "#d9a441",
    agent: "#c9b99a",
    step:  "#9caf74",
    doc:   "#b1a488",
    error: "#cd6b4f",
    edge:  "rgba(237,227,207,0.18)",
    glow:  "rgba(217,164,65,0.20)",
    text:  "#b1a488",
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
    ctx.strokeStyle = "rgba(237,227,207,0.05)";
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
        ctx.strokeStyle = "#ece2cd";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 4, -Math.PI / 2, -Math.PI / 2 + n.progress * TAU);
        ctx.stroke();
      }

      /* Border */
      ctx.strokeStyle = n.state === "error" ? "#cd6b4f" : "#332b20";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();

      /* Label */
      ctx.fillStyle = COLORS.text;
      ctx.font = (n.type === "root" || n.type === "agent" ? "bold 12px" : "11px") + " ui-monospace, SFMono-Regular, Menlo, monospace";
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

  var API_BASE = "/api/plugins/deep-research";
  var MODES = ["auto", "product", "compare", "how-to", "fact-check"];
  var STEP_LABELS = { init: "Initializing", decompose: "Planning", analyze: "Analyzing gaps", search: "Searching", extract: "Reading sources", synthesize: "Writing report", done: "Complete", error: "Error" };
  var STEP_ORDER = ["decompose", "search", "extract", "synthesize", "done"];
  var BRIEF_PLACEHOLDER = "e.g. Trace Odysseus's ten-year journey home from Troy \u2014 every island, monster, and detour, and why each one cost him";

  /* ── helpers ─────────────────────────────────────────────────── */
  function apiFetch(path, opts) {
    var token = window.__HERMES_SESSION_TOKEN__ || "";
    var headers = Object.assign({}, (opts && opts.headers) || {});
    if (token) headers["X-Hermes-Session-Token"] = token;
    return fetch(API_BASE + path, Object.assign({}, opts, { headers: headers }))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inlineMd(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\[(\d{1,3})\](?!\()/g, '<sup class="dr-cite"><a href="#drsrc-$1">$1</a></sup>');
  }

  /* Mini-markdown → dossier HTML. dropSources removes the report's own
     trailing "Sources" section when the structured source list is shown. */
  function md(text, dropSources) {
    if (!text) return "";
    var src = String(text).replace(/\r/g, "");
    if (dropSources) {
      var re = /^#{1,3}\s*Sources\s*$/gm, mm, last = null;
      while ((mm = re.exec(src)) !== null) last = mm;
      if (last) src = src.slice(0, last.index);
    }
    var lines = src.split("\n");
    var out = [], para = [], list = [], listType = "", inCode = false, code = [];
    function flushPara() { if (para.length) { out.push("<p>" + para.join(" ") + "</p>"); para = []; } }
    function flushList() { if (list.length) { out.push("<" + listType + ">" + list.join("") + "</" + listType + ">"); list = []; listType = ""; } }
    function flushCode() { if (code.length) { out.push("<pre><code>" + code.join("\n") + "</code></pre>"); code = []; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (inCode) {
        if (/^\s*```/.test(ln)) { inCode = false; flushCode(); } else { code.push(esc(ln)); }
        continue;
      }
      if (/^\s*```/.test(ln)) { flushPara(); flushList(); inCode = true; continue; }
      if (!ln.trim()) { flushPara(); flushList(); continue; }
      var h = ln.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); flushList(); var lvl = Math.min(4, h[1].length); out.push("<h" + lvl + ">" + inlineMd(h[2]) + "</h" + lvl + ">"); continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(ln)) { flushPara(); flushList(); out.push("<hr/>"); continue; }
      var bq = ln.match(/^>\s?(.*)$/);
      if (bq) { flushPara(); flushList(); out.push("<blockquote>" + inlineMd(bq[1]) + "</blockquote>"); continue; }
      var ul = ln.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) { flushPara(); if (listType !== "ul") { flushList(); listType = "ul"; } list.push("<li>" + inlineMd(ul[1]) + "</li>"); continue; }
      var ol = ln.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) { flushPara(); if (listType !== "ol") { flushList(); listType = "ol"; } list.push("<li>" + inlineMd(ol[1]) + "</li>"); continue; }
      para.push(inlineMd(ln));
    }
    flushPara(); flushList(); flushCode();
    return out.join("");
  }

  function stepLabel(s) { return STEP_LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : ""); }

  function fmtDuration(secs) {
    if (!secs) return "--:--";
    var m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function fmtWhen(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    try {
      return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
    } catch (e) { return d.toLocaleString(); }
  }

  /* ── icons ───────────────────────────────────────────────────── */
  var ICON_DEFS = {
    search: [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "m20 20-3.6-3.6" }]],
    play: [["path", { d: "M8 5.5v13l10.5-6.5z", fill: "currentColor", stroke: "none" }]],
    layers: [["path", { d: "m12 4 8 4.5-8 4.5-8-4.5z" }], ["path", { d: "m4 13 8 4.5 8-4.5" }]],
    copy: [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 15V6a2 2 0 0 1 2-2h9" }]],
    chat: [["path", { d: "M20 15a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" }]],
    doc: [["path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }], ["path", { d: "M14 3v5h5" }], ["path", { d: "M9 13h6M9 17h6" }]],
    trash: [["path", { d: "M4 7h16" }], ["path", { d: "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }], ["path", { d: "m6 7 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" }]],
    archive: [["rect", { x: 3, y: 4, width: 18, height: 5, rx: 1.5 }], ["path", { d: "M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" }], ["path", { d: "M10 13h4" }]],
    sliders: [["path", { d: "M4 8h9" }], ["circle", { cx: 16, cy: 8, r: 2 }], ["path", { d: "M18 8h2" }], ["path", { d: "M4 16h3" }], ["circle", { cx: 10, cy: 16, r: 2 }], ["path", { d: "M12 16h8" }]],
    chevron: [["path", { d: "m6 9 6 6 6-6" }]],
    check: [["path", { d: "m5 12.5 4.5 4.5L19 7" }]],
    x: [["path", { d: "M6 6l12 12" }], ["path", { d: "M18 6 6 18" }]],
    external: [["path", { d: "M14 5h5v5" }], ["path", { d: "m19 5-8 8" }], ["path", { d: "M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" }]]
  };

  function Icon(props) {
    var def = ICON_DEFS[props.name] || [];
    var kids = def.map(function (d, i) { return React.createElement(d[0], Object.assign({ key: i }, d[1])); });
    return React.createElement("svg", {
      width: props.size || 15, height: props.size || 15, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": "true"
    }, kids);
  }

  function Btn(props) {
    var cls = "dr-btn" + (props.variant === "primary" ? " dr-btn-primary" : "");
    return React.createElement("button", {
      type: "button", className: cls, onClick: props.onClick, disabled: props.disabled, title: props.title
    },
      props.icon && React.createElement(Icon, { name: props.icon }),
      props.children != null && React.createElement("span", null, props.children));
  }

  function IconBtn(props) {
    return React.createElement("button", {
      type: "button", className: "dr-ico-btn" + (props.className ? " " + props.className : ""),
      onClick: props.onClick, title: props.title, "aria-label": props.title
    }, React.createElement(Icon, { name: props.name, size: props.size || 15 }));
  }

  function Spinner() { return React.createElement("span", { className: "dr-spinner" }); }

  /* ── masthead ────────────────────────────────────────────────── */
  function Masthead(props) {
    var working = props.working, step = props.step, count = props.count;
    return React.createElement("header", { className: "dr-mast" },
      React.createElement("div", { className: "dr-word" },
        React.createElement("span", { className: "dr-mark" }, React.createElement(Icon, { name: "search", size: 17 })),
        React.createElement("div", null,
          React.createElement("h1", null, "Deep Research"),
          React.createElement("div", { className: "dr-sub" }, "Multi-step web investigation by the Hermes agent \u2014 every claim cited to a numbered source.")
        )
      ),
      React.createElement("div", { className: "dr-mast-meta" },
        React.createElement("div", { className: "dr-state" + (working ? " working" : "") },
          working ? React.createElement("span", { className: "dr-pulse" }) : React.createElement("span", { className: "dr-dot" }),
          working ? ("working" + (step ? " \u2014 " + stepLabel(step).toLowerCase() : "\u2026")) : "idle"
        ),
        React.createElement("div", { className: "dr-filecount" },
          React.createElement("b", null, String(count)), " ", count === 1 ? "investigation" : "investigations", " on file")
      )
    );
  }

  /* ── field log ───────────────────────────────────────────────── */
  function FieldLog(props) {
    var job = props.job, kanban = props.kanban;
    var steps = job.steps || [], current = job.current_step, error = job.error;
    var seen = {}, seq = [];
    steps.forEach(function (s) {
      if (!s || !s.step) return;
      if (!seen[s.step]) { seen[s.step] = { step: s.step, detail: s.detail || "" }; seq.push(s.step); }
      else if (s.detail) { seen[s.step].detail = s.detail; }
    });
    seq.sort(function (a, b) {
      var ia = STEP_ORDER.indexOf(a), ib = STEP_ORDER.indexOf(b);
      if (ia < 0) ia = 90; if (ib < 0) ib = 90;
      return ia - ib;
    });
    var finished = job.status === "completed" || current === "done";

    function stateOf(name) {
      if (finished) return "done";
      if (name === current) return "active";
      var ci = STEP_ORDER.indexOf(current), ni = STEP_ORDER.indexOf(name);
      if (ci >= 0 && ni >= 0 && ni < ci) return "done";
      if (!current && name === "decompose") return "active";
      return "pending";
    }

    var rows = seq.filter(function (n) { return n !== "error"; }).map(function (name) {
      var st = seen[name], state = stateOf(name);
      return React.createElement("div", { className: "dr-log-row " + state, key: name },
        React.createElement("span", { className: "dr-log-ico" },
          state === "active" ? React.createElement("span", { className: "dr-pulse" })
            : state === "done" ? React.createElement(Icon, { name: "check", size: 13 })
              : React.createElement("span", { style: { width: 5, height: 5, borderRadius: "50%", background: "var(--dr-ink-3)", display: "block" } })),
        React.createElement("span", { className: "dr-log-label" }, stepLabel(name)),
        st.detail ? React.createElement("span", { className: "dr-log-detail" }, st.detail) : null
      );
    });

    if (error) {
      rows.push(React.createElement("div", { className: "dr-log-row error", key: "error" },
        React.createElement("span", { className: "dr-log-ico" }, React.createElement(Icon, { name: "x", size: 13 })),
        React.createElement("span", { className: "dr-log-label" }, "Error"),
        React.createElement("span", { className: "dr-log-detail" }, error)
      ));
    }

    var kids = kanban && Array.isArray(kanban.children) ? kanban.children : [];

    return React.createElement("div", { className: "dr-log" },
      React.createElement("div", { className: "dr-log-rows" },
        rows.length ? rows : React.createElement("div", { className: "dr-log-row active" },
          React.createElement("span", { className: "dr-log-ico" }, React.createElement("span", { className: "dr-pulse" })),
          React.createElement("span", { className: "dr-log-label" }, "Starting"),
          React.createElement("span", { className: "dr-log-detail" }, "handing the brief to the agent\u2026")
        )
      ),
      kids.length > 0 ? React.createElement("div", { className: "dr-log-foot" },
        React.createElement("span", null, "tasks"),
        React.createElement("span", { className: "dr-kids" },
          kids.map(function (c, i) {
            return React.createElement("span", { className: "dr-kid " + ((c && c.status) || ""), key: (c && c.id) || i }, (c && c.title) || "task");
          })
        )
      ) : null
    );
  }

  /* ── agent graph ─────────────────────────────────────────────── */
  function GraphFrame(props) {
    var job = props.job;
    var canvasRef = useRef(null);
    var graphRef = useRef(null);
    var docsRef = useRef(0);

    useEffect(function () {
      if (!canvasRef.current) return;
      var g = new window.AgentGraph(canvasRef.current);
      g.setRoot((job.query || "research").slice(0, 36));
      graphRef.current = g;
      docsRef.current = 0;
      return function () { g.destroy(); graphRef.current = null; };
    }, [job.id]);

    useEffect(function () {
      var g = graphRef.current;
      if (!g) return;
      var steps = job.steps || [];
      var names = [], seen = {};
      steps.forEach(function (s) {
        if (s && s.step && s.step !== "error" && s.step !== "done" && !seen[s.step]) { seen[s.step] = 1; names.push(s.step); }
      });
      names.sort(function (a, b) { return STEP_ORDER.indexOf(a) - STEP_ORDER.indexOf(b); });
      names.forEach(function (name, i) {
        var id = "step-" + name;
        if (!g.nodes.some(function (n) { return n.id === id; })) {
          g.addNode(id, "step", stepLabel(name), i === 0 ? "root" : "step-" + names[i - 1]);
        }
      });
      var finished = job.status === "completed" || job.current_step === "done";
      var ci = STEP_ORDER.indexOf(job.current_step);
      names.forEach(function (name) {
        var ni = STEP_ORDER.indexOf(name);
        var state = finished ? "done" : (name === job.current_step ? "active" : (ci >= 0 && ni >= 0 && ni < ci ? "done" : "idle"));
        g.setState("step-" + name, state, state === "active" ? 0.5 : 1);
      });
      if (job.status === "error") g.setState("root", "error", 1);
      var want = job.sources_count || 0;
      while (docsRef.current < want && docsRef.current < 40) {
        var did = "doc-" + docsRef.current;
        if (!g.nodes.some(function (n) { return n.id === did; })) {
          g.addNode(did, "doc", "src " + (docsRef.current + 1), "step-extract");
        }
        docsRef.current++;
      }
    }, [job.steps, job.current_step, job.sources_count, job.status]);

    return React.createElement("div", { className: "dr-graph-frame" },
      React.createElement("canvas", { ref: canvasRef }),
      React.createElement("div", { className: "dr-graph-cap" },
        React.createElement("span", null, "agent activity"),
        React.createElement("span", null, (job.sources_count || 0) + " sources seen")
      )
    );
  }

  /* ── report ──────────────────────────────────────────────────── */
  function SourceRow(props) {
    var s = props.s, i = props.i;
    var domain = "";
    try { domain = new URL(s.url).hostname.replace(/^www\./, ""); } catch (e) { domain = s.url || ""; }
    return React.createElement("a", { className: "dr-src", id: "drsrc-" + (i + 1), href: s.url, target: "_blank", rel: "noopener noreferrer" },
      React.createElement("span", { className: "idx" }, String(i + 1).padStart(2, "0")),
      React.createElement("span", { className: "body" },
        React.createElement("span", { className: "domain" }, domain),
        React.createElement("span", { className: "title" }, s.title || s.url),
        s.snippet ? React.createElement("span", { className: "snippet" }, s.snippet) : null
      )
    );
  }

  function ReportPanel(props) {
    var report = props.report, sources = props.sources || [], meta = props.meta || {};
    return React.createElement("section", { className: "dr-report", ref: props.innerRef },
      React.createElement("div", { className: "dr-report-head" },
        React.createElement("span", { className: "dr-file" },
          meta.fileNo || "REPORT",
          meta.when ? React.createElement("em", null, " \u00b7 " + meta.when) : null),
        React.createElement("span", { className: "dr-spacer" }),
        React.createElement(IconBtn, { name: props.copied ? "check" : "copy", className: props.copied ? "ok" : "", title: props.copied ? "Copied" : "Copy report", onClick: props.onCopy }),
        React.createElement(IconBtn, { name: "x", title: "Close report", onClick: props.onClose })
      ),
      React.createElement("div", { className: "dr-report-body", dangerouslySetInnerHTML: { __html: md(report, sources.length > 0) } }),
      sources.length > 0 ? React.createElement("div", { className: "dr-sources" },
        React.createElement("div", { className: "dr-sources-inner" },
          React.createElement("div", { className: "dr-eyebrow" }, "Sources ", React.createElement("span", { className: "dr-count" }, String(sources.length))),
          sources.map(function (s, i) { return React.createElement(SourceRow, { key: i, s: s, i: i }); })
        )
      ) : null
    );
  }

  /* ── ledger row ──────────────────────────────────────────────── */
  function LedgerRow(props) {
    var job = props.job;
    var elapsed = job.completed_at && job.created_at ? fmtDuration(job.completed_at - job.created_at) : null;
    var running = job.status === "running";
    return React.createElement("div", { className: "dr-ledger-row" },
      React.createElement("span", { className: "no" }, props.no),
      React.createElement("div", { style: { minWidth: 0 } },
        React.createElement("div", { className: "q", onClick: function () { props.onOpen(job.id); }, title: "Open report" }, job.query),
        React.createElement("div", { className: "meta" },
          React.createElement("span", null, job.mode || "auto"),
          elapsed ? React.createElement("span", { className: "sep" }, "\u00b7") : null,
          elapsed ? React.createElement("span", null, elapsed) : null,
          job.sources_count > 0 ? React.createElement("span", { className: "sep" }, "\u00b7") : null,
          job.sources_count > 0 ? React.createElement("span", null, job.sources_count + " sources") : null,
          running ? React.createElement(Spinner) : null
        )
      ),
      React.createElement("div", { className: "acts" },
        React.createElement(IconBtn, { name: props.copiedCopy ? "check" : "copy", className: props.copiedCopy ? "ok" : "", title: "Copy report", onClick: function () { props.onCopy(job); } }),
        React.createElement(IconBtn, { name: props.copiedChat ? "check" : "chat", className: props.copiedChat ? "ok" : "", title: "Discuss with Hermes", onClick: function () { props.onDiscuss(job); } }),
        React.createElement(IconBtn, { name: "doc", title: "Open report", onClick: function () { props.onOpen(job.id); } }),
        React.createElement(IconBtn, { name: "trash", className: "danger", title: "Delete", onClick: function () { props.onDelete(job.id); } })
      )
    );
  }

  /* ── archive ─────────────────────────────────────────────────── */
  function ArchiveOverlay(props) {
    return React.createElement("div", { className: "dr-overlay", onClick: props.onClose },
      React.createElement("div", { className: "dr-overlay-box", onClick: function (e) { e.stopPropagation(); } },
        React.createElement("div", { className: "dr-overlay-head" },
          React.createElement("div", { className: "dr-eyebrow" }, "The archive \u00b7 ", React.createElement("span", { className: "dr-count" }, String(props.jobs.length))),
          React.createElement(IconBtn, { name: "x", title: "Close", onClick: props.onClose })
        ),
        React.createElement("div", { className: "dr-overlay-scroll" },
          props.jobs.length === 0
            ? React.createElement("div", { className: "dr-empty", style: { border: "none" } }, "Nothing archived yet.")
            : React.createElement("div", { className: "dr-ledger" },
              props.jobs.map(function (j) {
                return React.createElement(LedgerRow, {
                  key: j.id, job: j, no: props.fileNo(j.id),
                  onOpen: function (id) { props.onClose(); props.onOpen(id); },
                  onDiscuss: props.onDiscuss, onDelete: props.onDelete, onCopy: props.onCopy,
                  copiedCopy: props.copiedId === j.id + ":copy",
                  copiedChat: props.copiedId === j.id + ":chat"
                });
              })
            )
        )
      )
    );
  }

  /* ── page ────────────────────────────────────────────────────── */
  function DeepResearchPage() {
    var _q = useState(""); var query = _q[0], setQuery = _q[1];
    var _mode = useState("auto"); var mode = _mode[0], setMode = _mode[1];
    var _settingsOpen = useState(false); var settingsOpen = _settingsOpen[0], setSettingsOpen = _settingsOpen[1];
    var _rounds = useState("auto"); var rounds = _rounds[0], setRounds = _rounds[1];
    var _model = useState("default"); var model = _model[0], setModel = _model[1];
    var _availableModels = useState([]); var availableModels = _availableModels[0], setAvailableModels = _availableModels[1];
    var _activeJobs = useState([]); var activeJobs = _activeJobs[0], setActiveJobs = _activeJobs[1];
    var _pastJobs = useState([]); var pastJobs = _pastJobs[0], setPastJobs = _pastJobs[1];
    var _allJobs = useState([]); var allJobs = _allJobs[0], setAllJobs = _allJobs[1];
    var _report = useState(null); var report = _report[0], setReport = _report[1];
    var _reportSources = useState([]); var reportSources = _reportSources[0], setReportSources = _reportSources[1];
    var _reportMeta = useState(null); var reportMeta = _reportMeta[0], setReportMeta = _reportMeta[1];
    var _loading = useState(false); var loading = _loading[0], setLoading = _loading[1];
    var _historyLoading = useState(true); var historyLoading = _historyLoading[0], setHistoryLoading = _historyLoading[1];
    var _kanban = useState({}); var kanbanMap = _kanban[0], setKanban = _kanban[1];
    var _archiveOpen = useState(false); var archiveOpen = _archiveOpen[0], setArchiveOpen = _archiveOpen[1];
    var _copiedId = useState(null); var copiedId = _copiedId[0], setCopiedId = _copiedId[1];
    var pollRefs = useRef({});
    var reportRef = useRef(null);
    var copyTimer = useRef(null);

    function flashCopied(id) {
      setCopiedId(id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(function () { setCopiedId(null); }, 1400);
    }

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
                setReport("## Research failed\n\n**Error:** " + (r.error || "Unknown error") + "\n\n**Query:** " + r.query);
                setReportSources(r.sources || []);
                setReportMeta({ id: jobId });
              });
            }
            if (s.has_report) {
              return apiFetch("/results/" + jobId).then(function (r) {
                setReport(r.report); setReportSources(r.sources || []); setReportMeta({ id: jobId });
              });
            }
          }
        }).catch(function () {});
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
        setActiveJobs(active); setPastJobs(past); setAllJobs(jobs); setHistoryLoading(false);
        active.forEach(function (j) { startPolling(j.id); });
      }).catch(function () { setHistoryLoading(false); });
    }

    useEffect(function () {
      fetchHistory();
      apiFetch("/models").then(function (d) { setAvailableModels(d.models || []); }).catch(function () {});
    }, []);
    useEffect(function () {
      var refs = pollRefs.current;
      return function () { Object.keys(refs).forEach(function (k) { clearInterval(refs[k]); }); };
    }, []);
    useEffect(function () {
      if (!report || !reportRef.current) return;
      var reduce = false;
      try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
      try { reportRef.current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); } catch (e) {}
    }, [reportMeta && reportMeta.id]);

    var handleSubmit = useCallback(function () {
      var q = query.trim();
      if (!q || loading) return;
      setLoading(true);
      apiFetch("/research", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, mode: mode, folder: "default", rounds: rounds === "auto" ? null : parseInt(rounds, 10), model: model === "default" ? null : model })
      }).then(function (data) {
        var newJob = { id: data.id, engine: data.engine, query: q, mode: mode, folder: "default", status: "running", current_step: "init", steps: [], sources_count: 0, has_report: false, created_at: Date.now() / 1000 };
        setActiveJobs(function (prev) { return [newJob].concat(prev); });
        startPolling(data.id); setQuery(""); setLoading(false);
      }).catch(function () { setLoading(false); });
    }, [query, mode, loading, rounds, model]);

    var handleQueue = useCallback(function () {
      var q = query.trim();
      if (!q) return;
      apiFetch("/queue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, mode: mode, rounds: rounds === "auto" ? null : parseInt(rounds, 10), model: model === "default" ? null : model })
      }).then(function () { setQuery(""); fetchHistory(); }).catch(function () {});
    }, [query, mode, rounds, model]);

    var loadReport = useCallback(function (id) {
      apiFetch("/results/" + id).then(function (r) {
        if (r.error === "not found") {
          setReport("## Research not found\n\nThis research no longer exists \u2014 it may have been deleted.");
          setReportSources([]);
        } else if (r.status === "error") {
          setReport("## Research failed\n\n**Error:** " + (r.error || "Unknown error") + "\n\n**Query:** " + r.query);
          setReportSources(r.sources || []);
        } else if (!r.report) {
          setReport("## Report not ready\n\nThe research is still in progress \u2014 check back shortly.");
          setReportSources(r.sources || []);
        } else {
          setReport(r.report);
          setReportSources(r.sources || []);
        }
        setReportMeta({ id: id });
      }).catch(function () {});
    }, []);

    var deleteJob = useCallback(function (id) {
      apiFetch("/delete/" + id, { method: "DELETE" }).then(function () {
        fetchHistory();
        if (reportMeta && reportMeta.id === id) { setReport(null); setReportMeta(null); }
      }).catch(function () {});
    }, [reportMeta]);

    var copyReport = useCallback(function (job) {
      apiFetch("/results/" + job.id).then(function (r) {
        if (navigator.clipboard && r.report) {
          navigator.clipboard.writeText(r.report).then(function () { flashCopied(job.id + ":copy"); }).catch(function () {});
        }
      }).catch(function () {});
    }, []);

    var discussJob = useCallback(function (job) {
      apiFetch("/results/" + job.id).then(function (r) {
        var text = "Discuss this research:\n\n" + (r.report ? r.report.substring(0, 2000) : job.query);
        if (window.__HERMES_SEND_MESSAGE__) {
          window.__HERMES_SEND_MESSAGE__(text);
          flashCopied(job.id + ":chat");
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () { flashCopied(job.id + ":chat"); }).catch(function () {});
        }
      }).catch(function () {});
    }, []);

    function fileNoOf(id) {
      var idx = -1;
      for (var i = 0; i < allJobs.length; i++) { if (allJobs[i].id === id) { idx = i; break; } }
      if (idx < 0) return "\u2116 \u2014";
      return "\u2116 " + String(allJobs.length - idx).padStart(3, "0");
    }

    var hasRunning = activeJobs.length > 0;
    var totalResearch = activeJobs.length + pastJobs.length;
    var reportJob = null;
    if (reportMeta) {
      for (var ri = 0; ri < allJobs.length; ri++) { if (allJobs[ri].id === reportMeta.id) { reportJob = allJobs[ri]; break; } }
    }
    var reportWhen = reportJob ? fmtWhen(reportJob.completed_at || reportJob.created_at) : (reportMeta ? fmtWhen(Date.now() / 1000) : "");

    return React.createElement("div", { className: "dr-app" },
      React.createElement(Masthead, { working: hasRunning, step: (activeJobs[0] || {}).current_step, count: totalResearch }),

      /* launcher */
      React.createElement("section", { className: "dr-launcher" },
        React.createElement("div", { className: "dr-eyebrow" }, "New investigation"),
        React.createElement("div", { className: "dr-card" },
          React.createElement("textarea", {
            className: "dr-brief", placeholder: BRIEF_PLACEHOLDER, value: query, disabled: loading,
            onChange: function (e) { setQuery(e.target.value); },
            onKeyDown: function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleSubmit(); }
          }),
          React.createElement("div", { className: "dr-modes" },
            MODES.map(function (m) {
              return React.createElement("button", {
                key: m, type: "button", className: "dr-chip" + (mode === m ? " active" : ""),
                onClick: function () { setMode(m); }
              }, m);
            })
          ),
          React.createElement("button", {
            type: "button", className: "dr-disclose" + (settingsOpen ? " open" : ""),
            onClick: function () { setSettingsOpen(!settingsOpen); }
          },
            React.createElement("span", { className: "dr-disclose-l" }, React.createElement(Icon, { name: "sliders", size: 14 }), "Parameters"),
            React.createElement("span", { className: "dr-chev" }, React.createElement(Icon, { name: "chevron", size: 13 }))
          ),
          settingsOpen ? React.createElement("div", { className: "dr-params" },
            React.createElement("div", { className: "dr-field" },
              React.createElement("label", null, "Rounds"),
              React.createElement("div", { className: "dr-select-wrap" },
                React.createElement("select", { className: "dr-select", value: rounds, onChange: function (e) { setRounds(e.target.value); } },
                  React.createElement("option", { value: "auto" }, "Auto"),
                  React.createElement("option", { value: "1" }, "1"),
                  React.createElement("option", { value: "2" }, "2"),
                  React.createElement("option", { value: "3" }, "3"),
                  React.createElement("option", { value: "5" }, "5")
                ),
                React.createElement("span", { className: "dr-chev" }, React.createElement(Icon, { name: "chevron", size: 12 }))
              )
            ),
            React.createElement("div", { className: "dr-field" },
              React.createElement("label", null, "Model"),
              React.createElement("div", { className: "dr-select-wrap" },
                React.createElement("select", { className: "dr-select", value: model, onChange: function (e) { setModel(e.target.value); } },
                  React.createElement("option", { value: "default" }, "Default"),
                  availableModels.map(function (m) {
                    return React.createElement("option", { key: m.value, value: m.value }, m.display);
                  })
                ),
                React.createElement("span", { className: "dr-chev" }, React.createElement(Icon, { name: "chevron", size: 12 }))
              )
            ),
            React.createElement("div", { className: "dr-params-note" }, "Runs through the Hermes agent \u2014 the model and web tools come from Hermes' own configuration.")
          ) : null,
          React.createElement("div", { className: "dr-actions" },
            React.createElement(Btn, { icon: "layers", onClick: handleQueue, disabled: !query.trim(), title: "Add to the queue without starting" }, "Queue"),
            React.createElement(Btn, { variant: "primary", icon: loading ? null : "play", onClick: handleSubmit, disabled: !query.trim() || loading },
              loading ? React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } }, React.createElement(Spinner), "Starting\u2026") : "Begin research")
          )
        )
      ),

      /* active runs */
      activeJobs.map(function (j) {
        return React.createElement("section", { className: "dr-run", key: j.id },
          React.createElement("div", { className: "dr-run-head" },
            React.createElement("div", { className: "dr-run-q", title: j.query }, j.query),
            React.createElement("div", { className: "dr-run-meta" },
              React.createElement("span", { className: "dr-tag" }, j.mode || "auto"),
              j.engine ? React.createElement("span", { className: "dr-tag" }, j.engine) : null,
              React.createElement(Spinner)
            )
          ),
          React.createElement(FieldLog, { job: j, kanban: kanbanMap[j.id] }),
          React.createElement(GraphFrame, { job: j })
        );
      }),

      /* report */
      report ? React.createElement(ReportPanel, {
        report: report, sources: reportSources,
        meta: { fileNo: reportMeta ? fileNoOf(reportMeta.id) : "", when: reportWhen },
        copied: copiedId === (reportMeta && reportMeta.id) + ":report",
        onCopy: function () {
          if (navigator.clipboard && report) {
            navigator.clipboard.writeText(report).then(function () { flashCopied((reportMeta && reportMeta.id) + ":report"); }).catch(function () {});
          }
        },
        onClose: function () { setReport(null); setReportMeta(null); },
        innerRef: reportRef
      }) : null,

      /* past research */
      React.createElement("section", null,
        React.createElement("div", { className: "dr-past-head" },
          React.createElement("div", { className: "dr-eyebrow" }, "Past research ", React.createElement("span", { className: "dr-count" }, String(pastJobs.length)))
        ),
        pastJobs.length === 0 && !historyLoading
          ? React.createElement("div", { className: "dr-empty" }, "No research on file yet. Write a brief above and begin the first investigation.")
          : React.createElement("div", { className: "dr-ledger" },
            pastJobs.slice(0, 5).map(function (j) {
              return React.createElement(LedgerRow, {
                key: j.id, job: j, no: fileNoOf(j.id),
                onOpen: loadReport, onDiscuss: discussJob, onDelete: deleteJob, onCopy: copyReport,
                copiedCopy: copiedId === j.id + ":copy",
                copiedChat: copiedId === j.id + ":chat"
              });
            }),
            pastJobs.length > 5 ? React.createElement("button", { type: "button", className: "dr-ledger-more", onClick: function () { setArchiveOpen(true); } }, "\u2026 and " + (pastJobs.length - 5) + " more \u2014 open the archive") : null
          )
      ),

      archiveOpen ? React.createElement(ArchiveOverlay, {
        jobs: pastJobs, onClose: function () { setArchiveOpen(false); },
        onOpen: loadReport, onDiscuss: discussJob, onDelete: deleteJob, onCopy: copyReport,
        fileNo: fileNoOf, copiedId: copiedId
      }) : null
    );
  }

  window.__HERMES_PLUGINS__.register("deep-research", DeepResearchPage);
})();
