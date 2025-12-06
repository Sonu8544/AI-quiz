import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

import quizRoutes from "./routes/quizRoutes.js";
import authRoutes from "./routes/authRoutes.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.use("/api", quizRoutes);
app.use("/api/auth", authRoutes);

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "AI Quiz API running" });
});

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ai_quiz";

mongoose
  .connect(MONGO_URI, { dbName: "ai_quiz" })
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    }).on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Please free the port or use a different one.`);
        console.error(`To find and kill the process using port ${PORT}, run: lsof -ti:${PORT} | xargs kill -9`);
      } else {
        console.error("Server error:", err);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });


