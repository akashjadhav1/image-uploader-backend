const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const { getPayload, saveImage, saveImageBuffer, UPLOAD_DIR, ALLOWED_IMAGE_TYPES } = require("../utils/payload");

const router = express.Router();

// Read the raw request body as a Buffer (used for binary image uploads)
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
// Accepts either:
//   - multipart/form-data with an 'image' (or 'profileImage') file part, OR
//   - a raw binary body whose Content-Type is an allowed image MIME type
//     (image/jpeg, image/png, image/webp, image/gif).
// Validates, persists to uploads/, returns the public URL.
router.post("/upload", async (req, res) => {
  try {
    const mimeType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();

    let url;
    if (ALLOWED_IMAGE_TYPES[mimeType]) {
      // Raw binary image body — express.json only parses application/json, so the
      // stream is still unconsumed and can be read directly.
      const buffer = await readRawBody(req);
      if (!buffer.length) {
        return res.status(400).json({
          success: false,
          message: "Empty request body. Send the image bytes as the request body.",
        });
      }
      url = await saveImageBuffer(buffer, mimeType);
    } else {
      const { files } = await getPayload(req);
      const imageFile = files.image || files.profileImage;

      if (!imageFile) {
        return res.status(400).json({
          success: false,
          message: "No image provided. Send multipart/form-data ('image' part) or a raw binary body with an image Content-Type.",
        });
      }
      url = await saveImage(imageFile);
    }

    const fileName = path.basename(url);

    return res.status(201).json({
      success: true,
      message: "Image uploaded successfully",
      data: {
        fileName,
        url,
      },
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
