const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const { getPayload, saveImage, saveImageBuffer, UPLOAD_DIR, ALLOWED_IMAGE_TYPES } = require("../utils/payload");
const { authenticate } = require("../utils/auth");
const Image = require("../models/Image");

const router = express.Router();

// Read the raw request body as a Buffer (used for binary image uploads)
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Throw an error carrying an HTTP status for the error handler
function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Resolve the actual image name for a raw binary body. The bytes themselves
// carry no filename, so the client must send it out-of-band via (in order):
//   ?name= query param, X-File-Name header, or Content-Disposition header.
function resolveBinaryName(req) {
  if (req.query.name) return String(req.query.name);
  const headerName = req.headers["x-file-name"];
  if (headerName) return String(headerName);
  const cd = req.headers["content-disposition"] || "";
  const match = cd.match(/filename\*?="?([^";]+)"?/i);
  if (match) return decodeURIComponent(match[1].trim());
  return null;
}

// Persist the incoming image (raw binary body OR multipart form-data) to disk.
// Returns { url, size, mimeType, originalName }.
async function persistUpload(req) {
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();

  if (ALLOWED_IMAGE_TYPES[contentType]) {
    // Raw binary image body — express.json only parses application/json, so the
    // stream is still unconsumed and can be read directly.
    const buffer = await readRawBody(req);
    if (!buffer.length) {
      throw httpError("Empty request body. Send the image bytes as the request body.", 400);
    }
    const url = await saveImageBuffer(buffer, contentType);
    return { url, size: buffer.length, mimeType: contentType, originalName: resolveBinaryName(req) };
  }

  const { files } = await getPayload(req);
  const imageFile = files.image || files.profileImage;
  if (!imageFile) {
    throw httpError(
      "No image provided. Send multipart/form-data ('image' part) or a raw binary body with an image Content-Type.",
      400
    );
  }
  const url = await saveImage(imageFile);
  // imageFile.name is the actual uploaded image name from form-data
  return { url, size: imageFile.size, mimeType: imageFile.type, originalName: imageFile.name || null };
}

// Map any thrown error to a proper JSON response
function sendError(res, error) {
  console.error(error);

  // Errors with an explicit status (bad image type, oversized file)
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  // Missing file on disk -> 404
  if (error.code === "ENOENT") {
    return res.status(404).json({
      success: false,
      message: "Image not found",
    });
  }

  // Anything else -> 500 with the real error message
  return res.status(500).json({
    success: false,
    message: "Internal server error",
    error: error.message || "Unknown error",
  });
}

// POST /api/images/upload
// Requires a logged-in user (Authorization: Bearer <token>). Accepts either:
//   - multipart/form-data with an 'image' (or 'profileImage') file part, OR
//   - a raw binary body whose Content-Type is an allowed image MIME type
//     (image/jpeg, image/png, image/webp, image/gif).
// Validates, persists to uploads/, records ownership (createdBy), returns the URL.
router.post("/upload", authenticate, async (req, res) => {
  try {
    const { url, size, mimeType, originalName } = await persistUpload(req);
    const fileName = path.basename(url);

    await Image.create({ fileName, url, size, mimeType, originalName, createdBy: req.userId });

    return res.status(201).json({
      success: true,
      message: "Image uploaded successfully",
      data: {
        fileName,
        file_name: originalName || fileName,
        url,
        size,
        createdBy: req.authUser,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// Shallow user info for the createdBy relation (null when no owner)
function formatOwner(user) {
  if (!user) return null;
  return { id: user._id, username: user.username, email: user.email };
}

// Map fileName -> { originalName, createdBy } from the Image collection.
async function getMetaByFileName(fileNames) {
  const docs = await Image.find({ fileName: { $in: fileNames } }).populate(
    "createdBy",
    "username email"
  );
  const map = {};
  for (const doc of docs) {
    map[doc.fileName] = { originalName: doc.originalName || null, createdBy: formatOwner(doc.createdBy || null) };
  }
  return map;
}

// GET /api/images
// Lists all uploaded images in uploads/ (name, public URL, size, upload time,
// and the createdBy user's details when the uploader is known).
router.get("/", async (req, res) => {
  try {
    let entries;
    try {
      entries = await fs.readdir(UPLOAD_DIR, { withFileTypes: true });
    } catch (error) {
      // Directory doesn't exist yet -> nothing uploaded so far
      if (error.code === "ENOENT") entries = [];
      else throw error;
    }

    const allowedExts = new Set(Object.values(ALLOWED_IMAGE_TYPES));
    const files = entries.filter((entry) => entry.isFile() && allowedExts.has(path.extname(entry.name).toLowerCase()));

    const data = await Promise.all(
      files.map(async (entry) => {
        const stats = await fs.stat(path.join(UPLOAD_DIR, entry.name));
        return {
          fileName: entry.name,
          url: `/uploads/${entry.name}`,
          size: stats.size,
          uploadedAt: stats.mtime.toISOString(),
        };
      })
    );

    // Newest first
    data.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

    // Attach uploader details + original name (legacy files get null values)
    const meta = await getMetaByFileName(data.map((d) => d.fileName));
    for (const item of data) {
      const info = meta[item.fileName] || {};
      item.file_name = info.originalName || item.fileName;
      item.createdBy = info.createdBy || null;
    }

    return res.status(200).json({
      success: true,
      message: "Images fetched successfully",
      count: data.length,
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// DELETE /api/images/:fileName
// Removes an image from uploads/ by its stored file name.
router.delete("/:fileName", async (req, res) => {
  try {
    const { fileName } = req.params;

    // Reject anything that isn't a plain file name (blocks path traversal)
    if (fileName !== path.basename(fileName)) {
      return res.status(400).json({
        success: false,
        message: "Invalid file name",
      });
    }

    await fs.unlink(path.join(UPLOAD_DIR, fileName));
    // Remove the ownership record too (no-op if none exists)
    await Image.deleteOne({ fileName });

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully",
      data: { fileName },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
