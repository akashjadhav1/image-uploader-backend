const mongoose = require("mongoose");

// One document per uploaded image. `createdBy` links it to the logged-in user
// (null for legacy files uploaded before ownership tracking was added).
const imageSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true, unique: true, index: true },
    originalName: { type: String, default: null }, // actual uploaded image name
    url: { type: String, required: true }, // public path like /uploads/xxx.jpg
    size: { type: Number },                // bytes
    mimeType: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Image", imageSchema);
