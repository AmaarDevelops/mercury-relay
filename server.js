const io = require("socket.io")(3000, {
    cors: { origin: "*" }
});

console.log("Mercury Relay Server started on port 3000...");

io.on("connection", (socket) => {
    console.log("Device connected:", socket.id);

    // Identify if the device is 'laptop' or 'phone'
    socket.on("register", (deviceType) => {
        socket.join(deviceType);
        console.log(`${deviceType} registered.`);
    });

    // When Laptop sends a request for help
    socket.on("laptop_to_phone", (data) => {
        console.log("Relaying to Phone:", data.message);
        socket.to("phone").emit("notification", data);
    });

    // When Phone sends a command back
    socket.on("phone_to_laptop", (data) => {
        console.log("Relaying to Laptop:", data.command);
        socket.to("laptop").emit("execute", data);
    });

    socket.on("disconnect", () => console.log("Device disconnected"));
});
