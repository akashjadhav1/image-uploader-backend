
const express = require("express");
const cors = require("cors");

// Connect MongoDB (db.js runs connectDB() on import)
require("./config/db");

// Routes
const authRoutes = require("./routes/auth");

const app = express();
// Render (and most PaaS) assign the port via process.env.PORT; fall back to 5000 locally
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: "http://localhost:5173",
}));
app.use(express.json());

// Serve uploaded images statically: /uploads/<filename>
app.use("/uploads", express.static("uploads"));

// Test route
app.get("/", (req, res) => {
  res.send("Express.js backend is running!");
});

// Auth routes: /api/auth/register, /api/auth/login
app.use("/api/auth", authRoutes);

// Sample API endpoint
app.get("/api/users", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Users fetched successfully",
    data: [
      { id: 1, name: "Akash" },
      { id: 2, name: "Rahul" },
    ],
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// 404 for unknown routes (must be after all routes)
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Global error handler — always respond with JSON, never an HTML stack trace
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error.message);

  // Malformed JSON in request body (thrown by express.json)
  if (error.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON in request body",
      error: error.message,
    });
  }

  // JSON payload too large
  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Request payload too large",
    });
  }

  const status = error.statusCode || error.status || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? "Internal server error" : error.message,
    error: error.message || "Unknown error",
  });
});
