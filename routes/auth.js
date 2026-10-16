const crypto = require("crypto");
const express = require("express");
const User = require("../models/User");
const { getPayload, extractProfile, saveImage } = require("../utils/payload");

const router = express.Router();

// Map any thrown error to a proper JSON response
function sendError(res, error) {
  console.error(error);

  // Errors with an explicit status (bad image type, oversized file, bad profile JSON)
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  // Mongoose validation errors -> 400 with per-field messages
  if (error.name === "ValidationError") {
    const details = Object.values(error.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: details,
    });
  }

  // Duplicate username (race condition between findOne and create) -> 409
  if (error.code === 11000) {
    const fields = Object.keys(error.keyValue || {});
    return res.status(409).json({
      success: false,
      message: `Username already exists${fields.length ? ` (${fields.join(", ")})` : ""}`,
    });
  }

  // Anything else -> 500 with the real error message
  return res.status(500).json({
    success: false,
    message: "Internal server error",
    error: error.message || "Unknown error",
  });
}

// Validate register fields -> array of { field, message } (empty = valid)
function validateRegisterInput(fields, email) {
  const { password } = fields;
  const errors = [];
  if (!email) {
    errors.push({ field: "email", message: "email is required" });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({ field: "email", message: "email is not valid" });
  }
  if (!password) {errors.push({ field: "password", message: "password is required" });}
  if (password && String(password).length < 6) {
    errors.push({ field: "password", message: "password must be at least 6 characters" });
  }
  return errors;
}

// Resolve a usable username. Explicit username that exists -> conflict.
// Derived (email prefix) username that exists -> append random suffix until free.
async function resolveUniqueUsername(rawUsername, email) {
  const prefix = email.split("@")[0];
  let username = rawUsername ? String(rawUsername).trim().toLowerCase() : prefix;
  let existing = await User.findOne({ username });

  if (rawUsername && existing) {
    return { username: null, conflict: true };
  }
  while (existing) {
    username = `${prefix}_${crypto.randomBytes(3).toString("hex")}`;
    existing = await User.findOne({ username });
  }
  return { username, conflict: false };
}

// Optional image from form-data -> save to disk, store public URL in profile
async function attachProfileImage(user, files) {
  const imageFile = files.image || files.profileImage;
  if (!imageFile) return;
  user.profile = user.profile || {};
  user.profile.image = await saveImage(imageFile);
  await user.save();
}

// POST /api/auth/register
// Requires { email, password }, profile is optional — accepts JSON OR multipart/form-data
// (form fields + optional 'image' file part). username is optional: derived from email
// prefix when not sent (the User schema requires a unique username).
router.post("/register", async (req, res) => {
  try {
    const { fields, files } = await getPayload(req);
    const { username: rawUsername } = fields;
    const profile = extractProfile(fields) || {};

    // Email can come as a top-level field or inside profile
    const email = String(fields.email || profile.email || "").trim().toLowerCase();

    const errors = validateRegisterInput(fields, email);
    if (errors.length) {
      return res.status(400).json({ success: false, message: "Validation failed", errors });
    }

    // Email is the login identifier — it lives on the user document, not inside profile
    delete profile.email;

    // Duplicate email check first (email is the real unique key for this route)
    const existingByEmail = await User.findOne({ email });
    if (existingByEmail) {
      return res.status(409).json({
        success: false,
        message: "Email already registered",
      });
    }

    // username: use the one sent, or derive it from the email prefix
    const { username, conflict } = await resolveUniqueUsername(rawUsername, email);
    if (conflict) {
      return res.status(409).json({
        success: false,
        message: "Username already exists",
      });
    }

    const user = await User.create({ username, password: fields.password, email, profile });

    await attachProfileImage(user, files);

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: {
        id: user._id,
        username: user.username,
        email: user.email,
        profile: user.profile || null,
        token: user.generateToken(),
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// POST /api/auth/login
// Accepts JSON { email, password } OR multipart/form-data
// (if an 'image' file part is sent, it is saved and set as the user's profile image)
router.post("/login", async (req, res) => {
  try {
    const { fields, files } = await getPayload(req);
    const { password } = fields;
    const email = String(fields.email || "").trim().toLowerCase();

    const errors = [];
    if (!email) errors.push({ field: "email", message: "email is required" });
    if (!password) errors.push({ field: "password", message: "password is required" });
    if (errors.length) {
      return res.status(400).json({ success: false, message: "Validation failed", errors });
    }

    // $or keeps legacy users (email only inside profile.email) able to log in
    // password has select:false, so fetch it explicitly
    const user = await User.findOne({
      $or: [{ email }, { "profile.email": email }],
    }).select("+password");
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Optional image update on login via form-data
    await attachProfileImage(user, files);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        id: user._id,
        username: user.username,
        email: user.email || email,
        profile: user.profile || null,
        token: user.generateToken(),
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
