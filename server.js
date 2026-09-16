/**
 * Cipher relay — phone <-> laptop
 * Decisions are id-scoped so a stale "No" cannot apply to a later ship prompt.
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

let currentTask = null;
/** @type {{ id: string, command: string, status: string, timestamp: number } | null} */
let currentDecision = null;
/** Active approval the laptop is waiting on (set by POST /begin_approval) */
let openApprovalId = null;

const inbox = [];
const INBOX_MAX = 40;

function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

app.get("/", (_req, res) => res.send("Cipher relay live."));

io.on("connection", (socket) => {
  socket.on("register", (deviceType) => {
    const room = String(deviceType || "unknown");
    socket.join(room);
    console.log(room, "registered", socket.id);
    if (room === "phone" && inbox.length) {
      socket.emit("inbox", { messages: inbox.slice(-20) });
    }
  });

  socket.on("phone_to_army", (data) => {
    const prompt = (data && data.prompt) || "";
    console.log("mission:", String(prompt).slice(0, 200));
    currentTask = { prompt: String(prompt), status: "pending", timestamp: Date.now() };
    io.to("laptop").emit("mission", currentTask);
  });

  socket.on("phone_to_laptop", (data) => {
    const command = (data && (data.command || data.message)) || "";
    // Bind decision to the open approval id if any
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
  if (currentTask && currentTask.status === "pending") {
    currentTask.status = "executing";
    return res.json(currentTask);
  }
  return res.status(204).send();
});

/** Drop any stale yes/no before a new approval wait. */
app.post("/clear_decision", auth, (_req, res) => {
  currentDecision = null;
  openApprovalId = null;
  res.status(200).json({ ok: true });
});

/**
 * Laptop starts an approval; returns id. Phone Yes/No should include same id.
 * Clears previous pending decision so old No cannot leak.
 */
app.post("/begin_approval", auth, (req, res) => {
  const id = (req.body && req.body.id) || newId();
  currentDecision = null;
  openApprovalId = String(id);
  console.log("begin_approval", openApprovalId);
  res.status(200).json({ id: openApprovalId });
});

app.get("/get_decision", auth, (req, res) => {
  const wantId = (req.query.id || "").toString();
  if (!currentDecision || currentDecision.status !== "pending") {
    return res.status(204).send();
  }
  // If laptop asked for a specific id, only return matching decision
  if (wantId && currentDecision.id && currentDecision.id !== wantId) {
    return res.status(204).send();
  }
  // If openApprovalId is set and decision has no id match, still require match when wantId set
  if (openApprovalId && wantId && currentDecision.id !== wantId) {
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
  const payload = { message, kind, timestamp: Date.now() };
  if (id) payload.id = id;
  inbox.push(payload);
  while (inbox.length > INBOX_MAX) inbox.shift();
  console.log("to phone", kind, message.slice(0, 120));
  io.to("phone").emit("notification", payload);
  res.status(200).send("ok");
});

app.get("/phone_inbox", auth, (_req, res) => {
  res.json({ messages: inbox.slice(-20) });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Cipher relay on", PORT));
