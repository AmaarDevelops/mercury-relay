const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { cors: { origin: "*" } });

app.use(express.json());

let currentTask = null;

// --- ADD THIS: Root route to stop the "Cannot GET /" error ---
app.get("/", (req, res) => {
    res.send("📡 Mercury Command Center is Live.");
});

// --- 1. THE BRIDGE: SOCKET -> TASK VARIABLE ---
io.on("connection", (socket) => {
    socket.on("register", (deviceType) => {
        socket.join(deviceType);
        console.log(`${deviceType} registered.`);
    });

    // THIS IS WHAT WAS MISSING:
    // When the phone emits via Socket, we save it to currentTask
    socket.on("phone_to_army", (data) => {
        console.log("Mission received via Socket:", data.prompt);
        currentTask = {
            prompt: data.prompt,
            status: "pending",
            timestamp: Date.now()
        };
    });
});

// --- 2. LAPTOP POLLING PORTAL (Keep this as is) ---
app.get("/get_mission", (req, res) => {
    if (currentTask && currentTask.status === "pending") {
        console.log("Serving mission to Laptop:", currentTask.prompt);
        res.json(currentTask);
        currentTask.status = "executing";
    } else {
        res.status(204).send();
    }
});

// --- 3. ARMY STATUS RELAY (Keep this as is) ---
app.post("/laptop_to_phone", (req, res) => {
    const data = req.body;
    console.log("Relaying Report to Phone:", data.message);
    io.to("phone").emit("notification", data);
    res.status(200).send("Report relayed.");
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Mercury Command Center live on port ${PORT}`));
