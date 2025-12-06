import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useQuiz } from "../context/QuizContext.jsx";
import client from "../api/client.js";
import PrimaryButton from "../components/PrimaryButton.jsx";

function SettingsPage() {
  const navigate = useNavigate();
  const { input, settings, setSettings, setSession } = useQuiz();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleGenerate = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await client.post("/generate-quiz", {
        sourceType: input.sourceType,
        text: input.sourceType === "text" || input.sourceType === "file" ? input.text : undefined,
        youtubeUrl: input.sourceType === "youtube" ? input.youtubeUrl : undefined,
        difficulty: settings.difficulty,
        numQuestions: settings.numQuestions,
        allowImages: settings.allowImages,
      });

      setSession({
        quizId: res.data.quizId,
        questions: res.data.questions,
        answers: [],
        score: 0,
        coins: 0,
        perQuestionStatus: [],
      });

      navigate("/quiz-detail");
    } catch (err) {
      console.error(err);
      // Display the actual error message from the backend if available
      const errorMessage = err?.response?.data?.error || err?.message || "Failed to generate quiz. Please try again.";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <h2 className="text-2xl md:text-3xl font-semibold mb-2 tracking-tight">Quiz settings</h2>
      <p className="text-xs md:text-sm text-slate-400 mb-5">
        Fine-tune difficulty and question count. Each question gets 60 seconds and rewards +4 coins
        for a correct answer.
      </p>
      <div className="space-y-4 mb-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 md:p-5 shadow-lg shadow-black/40">
        <div>
          <label className="block text-sm mb-1 text-slate-300">Difficulty</label>
          <div className="flex flex-wrap gap-2">
            {["easy", "medium", "hard"].map((level) => (
              <button
                key={level}
                onClick={() => setSettings((s) => ({ ...s, difficulty: level }))}
                className={`px-3 py-1.5 rounded-full text-xs capitalize border transition-colors ${
                  settings.difficulty === level
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-slate-800 hover:border-slate-600"
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm mb-1 text-slate-300">Number of questions</label>
          <input
            type="number"
            min={1}
            max={20}
            value={settings.numQuestions}
            onChange={(e) =>
              setSettings((s) => ({ ...s, numQuestions: Number(e.target.value) || 1 }))
            }
            className="w-24 rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            id="allow-images"
            type="checkbox"
            checked={settings.allowImages}
            onChange={(e) => setSettings((s) => ({ ...s, allowImages: e.target.checked }))}
            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-primary focus:ring-primary/60"
          />
          <label htmlFor="allow-images" className="text-sm text-slate-300">
            Allow image-based questions or options (when AI decides)
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      <PrimaryButton onClick={handleGenerate} disabled={loading}>
        {loading ? "Generating quiz..." : "Generate Quiz"}
      </PrimaryButton>
    </div>
  );
}

export default SettingsPage;


