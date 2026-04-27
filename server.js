const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { cors: { origin: "*" } });

app.use(express.json());

// --- THIS IS THE NEW "MAILBOX" FOR PYTHON ---
app.post("/laptop_to_phone", (req, res) => {
    const data = req.body;
    console.log("Received from Python Army:", data.message);

    // Broadcast to the registered 'phone' socket
    io.to("phone").emit("notification", data);

    res.status(200).send("Relayed to phone successfully");
});

// --- THE REST OF YOUR SOCKET LOGIC ---
io.on("connection", (socket) => {
    console.log("Device connected:", socket.id);

    socket.on("register", (deviceType) => {
        socket.join(deviceType);
        console.log(`${deviceType} registered.`);
    });

    socket.on("disconnect", () => console.log("Device disconnected"));
});

// Start the server on port 3000 (Render will usually provide a port)
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Mercury Relay running on port ${PORT}...`);
});
