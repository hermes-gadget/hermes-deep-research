/* —— Deep Research Agent Graph ——
   Canvas 2D force-directed mini-graph.
   Root = orchestrator, children = research steps & documents.
   No deps, 60fps, Hermes-themed.
*/

(function (global) {
  "use strict";

  var TAU = Math.PI * 2;
  var COLORS = {
    root:  "#22d3ee",   /* primary cyan */
    step:  "#818cf8",   /* indigo */
    doc:   "#34d399",   /* emerald */
    error: "#f87171",   /* red */
    edge:  "#475569",   /* slate */
    glow:  "rgba(34,211,238,0.25)",
    text:  "#e2e8f0",
  };

  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx*dx + dy*dy); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* —— Node —— */
  function Node(id, type, label, parent) {
    this.id = id;
    this.type = type;        /* root | step | doc | error */
    this.label = label;
    this.parent = parent || null;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.radius = type === "root" ? 28 : type === "step" ? 18 : 12;
    this.targetR = this.radius;
    this.birth = performance.now();
    this.state = "spawn";    /* spawn | idle | active | done | error */
    this.progress = 0;       /* 0-1 fill arc for active steps */
    this.pulse = 0;
  }

  Node.prototype.color = function () {
    if (this.state === "error") return COLORS.error;
    if (this.type === "root") return COLORS.root;
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
      var ideal = a.type === "step" ? 140 : 90;
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
      ctx.font = (n.type === "root" ? "bold 12px" : "11px") + " system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(n.label, cx, cy + r + 14);
    }
  };

  global.AgentGraph = AgentGraph;
})(window);
