/**
 * Cipher relay — single-flight missions (no double deliver).
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

function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function enqueueMission(prompt) {
  const p = String(prompt || "").trim();
  if (!p) return;
  // Drop exact duplicate of what's running or already queued
  if (currentTask && currentTask.prompt === p) {
    console.log("skip dup mission (active):", p.slice(0, 80));
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
  } else {
    missionQueue.push(task);
    console.log("mission queued behind active:", p.slice(0, 80), "depth=", missionQueue.length);
  }
}

function promoteNext() {
  if (missionQueue.length === 0) {
    currentTask = null;
    return;
  }
  currentTask = missionQueue.shift();
  currentTask.status = "pending";
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
  });

  socket.on("phone_to_army", (data) => {
    enqueueMission((data && data.prompt) || "");
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

app.get("/get_mission", auth, (req, res) => {
  if (!currentTask || currentTask.status !== "pending") {
    return res.status(204).send();
  }
  // Claim exactly once
  currentTask.status = "executing";
  return res.json({
    prompt: currentTask.prompt,
    status: currentTask.status,
    timestamp: currentTask.timestamp,
  });
});

/** Laptop finished a mission — allow next queued item */
app.post("/mission_done", auth, (req, res) => {
  if (currentTask) {
    currentTask.status = "done";
  }
  promoteNext();
  res.status(200).json({ ok: true, pending: missionQueue.length });
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
  const since = parseInt(req.query.since || "0", 10) || 0;
  const messages = inbox.filter(
    (m) => (m.seq || 0) > since && m.kind !== "approve" && m.kind !== "answer"
  );
  res.json({ messages, latest: seq - 1 });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Cipher relay on", PORT));
