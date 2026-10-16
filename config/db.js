

const mongoose = require("mongoose");
require("dotenv").config();

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      // Give API operations a 10s buffer window before they fail
      bufferCommands: true,
      bufferTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    });
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

// Log connection state so a buffering timeout is easy to diagnose
mongoose.connection.on("connected", () => console.log("Mongoose: connection open"));
mongoose.connection.on("error", (error) => console.error("Mongoose error:", error.message));
mongoose.connection.on("disconnected", () => console.warn("Mongoose: disconnected"));

connectDB();