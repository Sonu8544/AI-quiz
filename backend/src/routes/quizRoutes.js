import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

import { extractFromFile, extractFromYoutube, generateQuizWithAI } from "../services/quizService.js";
import Quiz from "../models/Quiz.js";
import Result from "../models/Result.js";
import User from "../models/User.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  dest: path.join(__dirname, "../../uploads"),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const text = await extractFromFile(req.file);
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to extract text from file" });
  }
});

router.post("/generate-quiz", async (req, res) => {
  try {
    const { sourceType, text, youtubeUrl, difficulty, numQuestions, allowImages } = req.body;

    let baseText = text || "";
    if (sourceType === "youtube" && youtubeUrl) {
      try {
        baseText = await extractFromYoutube(youtubeUrl);
      } catch (youtubeError) {
        // Return YouTube-specific errors with proper status code
        return res.status(400).json({ 
          error: youtubeError.message || "Failed to extract transcript from YouTube video" 
        });
      }
    }

    if (!baseText || baseText.trim().length === 0) {
      return res.status(400).json({ error: "No text available for quiz generation" });
    }

    const questions = await generateQuizWithAI({
      text: baseText,
      difficulty,
      numQuestions,
      allowImages: !!allowImages,
    });

    const quiz = await Quiz.create({
      inputText: baseText.slice(0, 5000),
      difficulty,
      numQuestions,
      aiResponse: questions,
    });

    res.json({ quizId: quiz._id, questions });
  } catch (err) {
    console.error("Quiz generation error:", err);
    if (err?.status === 429 || err?.message === "AI_QUOTA_EXCEEDED") {
      return res
        .status(429)
        .json({
          error:
            "AI provider quota or rate limit exceeded. Please update your API plan/keys or try again later.",
        });
    }
    // Return the actual error message if it's a known error, otherwise generic message
    const errorMessage = err?.message && err.message !== "Failed to generate quiz" 
      ? err.message 
      : "Failed to generate quiz";
    res.status(500).json({ error: errorMessage });
  }
});

router.post("/save-result", async (req, res) => {
  try {
    const { userId, quizId, score, coinsEarned, perQuestionStatus } = req.body;
    if (!userId || !quizId) {
      return res.status(400).json({ error: "userId and quizId are required" });
    }

    const result = await Result.create({
      userId,
      quizId,
      score,
      coinsEarned,
      perQuestionStatus,
    });

    res.json({ resultId: result._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save result" });
  }
});

router.get("/history/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const results = await Result.find({ userId })
      .sort({ createdAt: -1 })
      .populate("quizId")
      .lean();
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

import mongoose from "mongoose";

router.get("/leaderboard", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Aggregate results by userId
    const leaderboardData = await Result.aggregate([
      {
        $group: {
          _id: "$userId",
          totalScore: { $sum: "$score" },
          totalCoins: { $sum: "$coinsEarned" },
          quizzesCompleted: { $sum: 1 },
          totalQuestions: { $sum: { $size: "$perQuestionStatus" } },
          correctAnswers: {
            $sum: {
              $size: {
                $filter: {
                  input: "$perQuestionStatus",
                  as: "q",
                  cond: { $eq: ["$$q.isCorrect", true] },
                },
              },
            },
          },
        },
      },
      {
        $addFields: {
          averageAccuracy: {
            $cond: {
              if: { $gt: ["$totalQuestions", 0] },
              then: {
                $multiply: [{ $divide: ["$correctAnswers", "$totalQuestions"] }, 100],
              },
              else: 0,
            },
          },
        },
      },
      {
        $sort: { totalScore: -1, averageAccuracy: -1 },
      },
    ]);

    // Count before pagination
    let totalUsers = leaderboardData.length;
    let paginatedData = leaderboardData.slice(skip, skip + limit);
    let leaderboard = [];

    // -------------------------------------------
    // IF NO DATA → RETURN DUMMY SCOREBOARD
    // -------------------------------------------
    if (totalUsers === 0) {
      const dummyNames = [
        "Alex Johnson", "Sarah Williams", "Michael Brown", "Emily Davis", "David Miller",
        "Jessica Wilson", "Christopher Moore", "Amanda Taylor", "Daniel Anderson", "Lisa Thomas",
        "Matthew Jackson", "Ashley White", "James Harris", "Michelle Martin", "Robert Thompson",
        "Nicole Garcia", "William Martinez", "Stephanie Robinson", "John Clark", "Jennifer Rodriguez"
      ];

      const dummyRoles = ["student", "teacher", "institute"];
      
      totalUsers = 25;
      const totalPages = Math.ceil(totalUsers / limit);
      const startIndex = skip;
      const endIndex = Math.min(skip + limit, totalUsers);

      leaderboard = [];

      for (let i = startIndex; i < endIndex; i++) {
        const totalScore = Math.floor(Math.random() * 200) + 50;
        const quizzesCompleted = Math.floor(Math.random() * 15) + 5;
        const totalQuestions = quizzesCompleted * 5;
        const correctAnswers = Math.floor(totalQuestions * (0.6 + Math.random() * 0.3));
        const averageAccuracy = (correctAnswers / totalQuestions) * 100;
        const totalCoins = correctAnswers * 4;

        leaderboard.push({
          userId: `dummy_${i}`,
          name: dummyNames[i % dummyNames.length],
          email: `dummy${i + 1}@example.com`,
          image: `https://i.pravatar.cc/150?img=${i + 1}`,
          role: dummyRoles[i % dummyRoles.length],
          totalScore,
          totalCoins,
          quizzesCompleted,
          averageAccuracy,
        });
      }

      return res.json({
        leaderboard,
        totalPages,
        totalUsers,
        currentPage: page,
        isDummy: true,
      });
    }

    // -------------------------------------------
    // FIX: ONLY QUERY VALID OBJECT IDS
    // -------------------------------------------
    const rawUserIds = paginatedData.map((entry) => entry._id);

    const validUserIds = rawUserIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

    const users = await User.find({ _id: { $in: validUserIds } })
      .select("name email image role")
      .lean();

    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    // -------------------------------------------
    // MERGE USER DETAILS WITH SCOREBOARD
    // -------------------------------------------
    leaderboard = paginatedData.map((entry) => {
      const user = userMap.get(String(entry._id));

      return {
        userId: entry._id,
        name: user?.name || `User ${String(entry._id).slice(-6)}`,
        email: user?.email || null,
        image:
          user?.image ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(user?.name || "User")}&background=6366F1&color=fff&size=128`,
        role: user?.role || null,
        totalScore: entry.totalScore,
        totalCoins: entry.totalCoins,
        quizzesCompleted: entry.quizzesCompleted,
        averageAccuracy: entry.averageAccuracy,
      };
    });

    const totalPages = Math.ceil(totalUsers / limit);

    return res.json({
      leaderboard,
      totalPages,
      totalUsers,
      currentPage: page,
      isDummy: false,
    });
  } catch (err) {
    console.error("Leaderboard Error:", err);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});


router.get("/recent-quizzes", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const skip = (page - 1) * limit;

    const totalQuizzes = await Quiz.countDocuments();
    const quizzes = await Quiz.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("difficulty numQuestions createdAt")
      .lean();

    const totalPages = Math.ceil(totalQuizzes / limit);

    res.json({
      quizzes,
      totalPages,
      totalQuizzes,
      currentPage: page,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch recent quizzes" });
  }
});

router.get("/quiz/:id", async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id).select("-aiResponse").lean();
    if (!quiz) {
      return res.status(404).json({ error: "Quiz not found" });
    }
    res.json({ quiz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

export default router;


