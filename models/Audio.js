const mongoose = require("mongoose");

const audioSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  email:      { type: String },           
  audioURL:   { type: String },
  speechText: { type: String },
  translation:{ type: String },          
  summary:    { type: String },           
  stats:      { type: Object },           
  enhancedAudioUrl: { type: String },      
  enhancedAt: { type: Date },             
  createdAt:  { type: Date, default: Date.now },
});

module.exports = mongoose.model("Audio", audioSchema);