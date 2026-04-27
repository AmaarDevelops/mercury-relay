const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { cors: { origin: "*" } });

app.use(express.json());

let currentTask = null; // Stores the command from your phone

// --- 1. PHONE COMMAND PORTAL ---
// Your phone hits this to tell the Army what to do
app.post("/phone_to_army", (req, res) => {
    const { prompt } = req.body;
    currentTask = { prompt, status: "pending", timestamp: Date.now() };
    console.log("New Mission Received from Phone:", prompt);
    res.status(200).json({ message: "Mission sent to the Army." });
});

// --- 2. LAPTOP POLLING PORTAL ---
// The laptop hits this to check for new missions
app.get("/get_mission", (req, res) => {
    if (currentTask && currentTask.status === "pending") {
        res.json(currentTask);
        currentTask.status = "executing"; // Mark as busy
    } else {
        res.status(204).send(); // No new tasks
    }
});

// --- 3. ARMY STATUS RELAY ---
// The laptop hits this to tell your phone it's done or stuck
app.post("/laptop_to_phone", (req, res) => {
    const data = req.body;
    console.log("Relaying Report to Phone:", data.message);
    io.to("phone").emit("notification", data); // Shouts to your phone app
    res.status(200).send("Report relayed.");
});

// --- 4. SOCKET CONNECTIONS ---
io.on("connection", (socket) => {
    socket.on("register", (deviceType) => {
        socket.join(deviceType);
        console.log(`${deviceType} registered for updates.`);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Mercury Command Center live on port ${PORT}`));
