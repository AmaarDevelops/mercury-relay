/**
 * Cipher relay — phone <-> laptop
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
let currentDecision = null;
const inbox = []; // last notifications for phone reconnect
const INBOX_MAX = 40;

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
    console.log("decision:", command);
    currentDecision = { command: String(command), status: "pending", timestamp: Date.now() };
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

app.get("/get_decision", auth, (req, res) => {
  if (currentDecision && currentDecision.status === "pending") {
    currentDecision.status = "consumed";
    return res.json(currentDecision);
  }
  return res.status(204).send();
});

app.post("/laptop_to_phone", auth, (req, res) => {
  const data = req.body || {};
  const message = String(data.message || "");
  const kind = String(data.kind || "status");
  const payload = { message, kind, timestamp: Date.now() };
  inbox.push(payload);
  while (inbox.length > INBOX_MAX) inbox.shift();
  console.log("to phone", kind, message.slice(0, 120));
  io.to("phone").emit("notification", payload);
  res.status(200).send("ok");
});

app.get("/phone_inbox", auth, (req, res) => {
  res.json({ messages: inbox.slice(-20) });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Cipher relay on", PORT));
