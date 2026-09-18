/**
 * Cipher relay — single-flight missions, recovery if executing gets stuck.
 */
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { cors: { origin: "*" } });

app.use(express.json());

const TOKEN = (process.env.CIPHER_BRIDGE_TOKEN || "").trim();
function auth(req, res, next) {
  if (!TOKEN) return next();
  if ((req.get("X-Cipher-Token") || "") === TOKEN) return next();
  return res.status(401).send("unauthorized");
}

/** @type {{ prompt: string, status: string, timestamp: number } | null} */
let currentTask = null;
const missionQueue = [];
let currentDecision = null;
let openApprovalId = null;
let seq = 1;
const inbox = [];
const INBOX_MAX = 80;
const EXEC_STALE_MS = 3 * 60 * 1000; // reclaim if laptop died mid-mission

function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function reclaimIfStale() {
  if (!currentTask) return;
  if (currentTask.status !== "executing") return;
  const age = Date.now() - (currentTask.timestamp || 0);
  if (age < EXEC_STALE_MS) return;
  console.log("reclaim stale executing mission:", (currentTask.prompt || "").slice(0, 80));
  currentTask.status = "done";
  promoteNext();
}

function enqueueMission(prompt) {
  const p = String(prompt || "").trim();
  if (!p) return;
  reclaimIfStale();
  if (currentTask && currentTask.prompt === p && currentTask.status !== "done") {
    console.log("skip dup mission (active):", p.slice(0, 80));
    // Re-emit so a reconnecting laptop still sees it
    if (currentTask.status === "pending") {
      io.to("laptop").emit("mission", currentTask);
    }
    return;
  }
  if (missionQueue.some((t) => t.prompt === p)) {
    console.log("skip dup mission (queued):", p.slice(0, 80));
    return;
  }
  const task = { prompt: p, status: "pending", timestamp: Date.now() };
  if (!currentTask || currentTask.status === "done") {
    currentTask = task;
    console.log("mission active:", p.slice(0, 120));
    io.to("laptop").emit("mission", currentTask);
  } else if (currentTask.status === "pending") {
    // Replace unused pending with newest (user re-spoke)
    console.log("replace pending mission with newer");
    currentTask = task;
    io.to("laptop").emit("mission", currentTask);
  } else {
    // executing — queue behind
    missionQueue.push(task);
    console.log("mission queued behind active:", p.slice(0, 80), "depth=", missionQueue.length);
    // Nudge laptop in case it missed the active one
    io.to("laptop").emit("mission", currentTask);
  }
}

function promoteNext() {
  if (missionQueue.length === 0) {
    currentTask = null;
    return;
  }
  currentTask = missionQueue.shift();
  currentTask.status = "pending";
  currentTask.timestamp = Date.now();
  console.log("promote mission:", currentTask.prompt.slice(0, 120));
  io.to("laptop").emit("mission", currentTask);
}

app.get("/", (_req, res) => res.send("Cipher relay live."));

io.on("connection", (socket) => {
  socket.on("register", (deviceType) => {
    const room = String(deviceType || "unknown");
    socket.join(room);
    console.log(room, "registered", socket.id);
    if (room === "phone") {
      const recent = inbox
        .filter((m) => m.kind !== "approve" && m.kind !== "answer")
        .slice(-30);
      if (recent.length) socket.emit("inbox", { messages: recent });
    }
    if (room === "laptop") {
      reclaimIfStale();
      // Replay pending mission so push-mode laptop starts immediately
      if (currentTask && currentTask.status === "pending") {
        socket.emit("mission", currentTask);
      }
    }
  });

  socket.on("phone_to_army", (data) => {
    const prompt = (data && (data.prompt || data.message)) || "";
    console.log("phone_to_army:", String(prompt).slice(0, 120));
    enqueueMission(prompt);
  });

  socket.on("phone_to_laptop", (data) => {
    const command = (data && (data.command || data.message)) || "";
    const id = (data && data.id) || openApprovalId || newId();
    console.log("decision:", command, "id=", id);
    currentDecision = {
      id: String(id),
      command: String(command),
      status: "pending",
      timestamp: Date.now(),
    };
    io.to("laptop").emit("decision", currentDecision);
  });
});

/** HTTP path so phone can send even if socket is flaky */
app.post("/phone_mission", auth, (req, res) => {
  const prompt = String((req.body && (req.body.prompt || req.body.message)) || "").trim();
  console.log("POST /phone_mission:", prompt.slice(0, 120));
  if (!prompt) return res.status(400).json({ ok: false, error: "empty" });
  enqueueMission(prompt);
  res.status(200).json({ ok: true, queued: missionQueue.length, active: !!(currentTask && currentTask.status !== "done") });
});

app.get("/get_mission", auth, (req, res) => {
  reclaimIfStale();
  if (!currentTask || currentTask.status !== "pending") {
    return res.status(204).send();
  }
  currentTask.status = "executing";
  currentTask.timestamp = Date.now();
  return res.json({
    prompt: currentTask.prompt,
    status: currentTask.status,
    timestamp: currentTask.timestamp,
  });
});

app.post("/mission_done", auth, (req, res) => {
  if (currentTask) {
    currentTask.status = "done";
  }
  promoteNext();
  res.status(200).json({ ok: true, pending: missionQueue.length });
});

/** Force-clear stuck mission (laptop can call on start) */
app.post("/mission_reset", auth, (_req, res) => {
  currentTask = null;
  missionQueue.length = 0;
  console.log("mission_reset");
  res.status(200).json({ ok: true });
});

app.post("/clear_decision", auth, (_req, res) => {
  currentDecision = null;
  openApprovalId = null;
  res.status(200).json({ ok: true });
});

app.post("/begin_approval", auth, (req, res) => {
  const id = (req.body && req.body.id) || newId();
  currentDecision = null;
  openApprovalId = String(id);
  res.status(200).json({ id: openApprovalId });
});

app.get("/get_decision", auth, (req, res) => {
  const wantId = (req.query.id || "").toString();
  if (!currentDecision || currentDecision.status !== "pending") {
    return res.status(204).send();
  }
  if (wantId && currentDecision.id && currentDecision.id !== wantId) {
    return res.status(204).send();
  }
  currentDecision.status = "consumed";
  const out = { ...currentDecision };
  openApprovalId = null;
  currentDecision = null;
  return res.json(out);
});

app.post("/laptop_to_phone", auth, (req, res) => {
  const data = req.body || {};
  const message = String(data.message || "");
  const kind = String(data.kind || "status");
  const id = data.id ? String(data.id) : undefined;
  const payload = { message, kind, timestamp: Date.now(), seq: seq++ };
  if (id) payload.id = id;
  inbox.push(payload);
  while (inbox.length > INBOX_MAX) inbox.shift();
  console.log("to phone", kind, message.slice(0, 120));
  io.to("phone").emit("notification", payload);
  res.status(200).send("ok");
});

app.get("/phone_inbox", auth, (req, res) => {
  const after = parseInt(String(req.query.after || "0"), 10) || 0;
  const messages = inbox.filter((m) => (m.seq || 0) > after);
  res.json({ messages, latest: seq - 1 });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    task: currentTask
      ? { status: currentTask.status, prompt: (currentTask.prompt || "").slice(0, 80) }
      : null,
    queue: missionQueue.length,
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Cipher relay on", PORT));
