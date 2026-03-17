const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name:             { type: String, required: true },
  email:            { type: String, unique: true, required: true },
  password:         { type: String, required: true },
  isVerified:       { type: Boolean, default: false },
  resetToken:       String,
  resetTokenExpiry: Date,
  createdAt:        { type: Date, default: Date.now }, 
});

module.exports = mongoose.model("User", userSchema);