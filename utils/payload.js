// Dual-format payload handling: JSON or multipart/form-data (with optional image)
// Uses Node's built-in undici (Request.formData) — no external packages needed.
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// Parse multipart/form-data into { fields, files }
async function parseMultipart(req) {
  const webStream = Readable.toWeb(req);
  // Dummy URL is required by the Request constructor; the stream is the body
  const request = new Request("http://localhost", {
    method: req.method,
    headers: req.headers,
    body: webStream,
    duplex: "half",
  });
  const form = await request.formData();

  const fields = {};
  const files = {};
  for (const [key, value] of form.entries()) {
    // undici returns File objects (with .arrayBuffer + .filename) for file parts
    if (typeof value === "object" && value && typeof value.arrayBuffer === "function") {
      files[key] = value;
    } else {
      fields[key] = value;
    }
  }
  return { fields, files };
}

// Returns { fields, files } regardless of content type
async function getPayload(req) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    return parseMultipart(req);
  }
  // JSON / urlencoded bodies are already parsed by express middleware
  return { fields: req.body || {}, files: {} };
}

// Normalize profile: object (JSON), JSON string (form field), or flat name/email/phone fields
function extractProfile(fields) {
  let profile = fields.profile;
  if (typeof profile === "string") {
    try {
      profile = JSON.parse(profile);
    } catch {
      const err = new Error("profile must be a valid JSON string in form-data");
      err.statusCode = 400;
      throw err;
    }
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    profile = {};
  }
  // Allow flat form fields as an alternative: name=..., email=..., phone=...
  for (const key of ["name", "email", "phone"]) {
    if (!profile[key] && fields[key]) profile[key] = fields[key];
  }
  return Object.keys(profile).length ? profile : null;
}

// Validate buffer + mime type, persist to uploads/, returns its public URL path
async function saveImageBuffer(buffer, mimeType) {
  const ext = ALLOWED_IMAGE_TYPES[mimeType];
  if (!ext) {
    const err = new Error(
      `Unsupported image type '${mimeType || "unknown"}'. Allowed: ${Object.keys(ALLOWED_IMAGE_TYPES).join(", ")}`
    );
    err.statusCode = 400;
    throw err;
  }
  if (buffer.length > MAX_IMAGE_SIZE) {
    const err = new Error(`Image too large. Max ${MAX_IMAGE_SIZE / 1024 / 1024} MB`);
    err.statusCode = 413;
    throw err;
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const fileName = `${Date.now()}_${crypto.randomBytes(8).toString("hex")}${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, fileName), buffer);
  return `/uploads/${fileName}`;
}

// Validate + persist an image File to uploads/, returns its public URL path
async function saveImage(file) {
  const buffer = Buffer.from(await file.arrayBuffer());
  return saveImageBuffer(buffer, file.type);
}

module.exports = { getPayload, extractProfile, saveImage, saveImageBuffer, UPLOAD_DIR, ALLOWED_IMAGE_TYPES };
