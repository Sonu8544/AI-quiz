import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import Tesseract from "tesseract.js";
import {
  YoutubeTranscript,
  YoutubeTranscriptError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";
import { Innertube } from "youtubei.js";
import axios from "axios";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function extractFromFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".pdf") {
    const dataBuffer = fs.readFileSync(file.path);
    const data = await pdfParse(dataBuffer);
    return data.text;
  }

  if (ext === ".docx") {
    const data = await mammoth.extractRawText({ path: file.path });
    return data.value;
  }

  if ([".png", ".jpg", ".jpeg"].includes(ext)) {
    const result = await Tesseract.recognize(file.path, "eng");
    return result.data.text;
  }

  // Fallback: treat as plain text file
  const data = fs.readFileSync(file.path, "utf8");
  return data;
}

async function getVideoMetadata(videoId) {
  try {
    const yt = await Innertube.create();
    let video;
    
    try {
      video = await yt.getInfo(videoId);
    } catch (parseError) {
      // youtubei.js sometimes has parsing errors but still returns data
      // Even with parsing errors, we can often still access basic info
      if (parseError.video || parseError.info) {
        video = parseError.video || parseError.info;
      } else {
        // Try to get basic info even if full parsing failed
        try {
          // Use getBasicInfo as fallback
          video = await yt.getBasicInfo(videoId);
        } catch (basicError) {
          console.log("youtubei.js failed to get video info:", parseError.message);
          return null;
        }
      }
    }
    
    // Extract video metadata - try multiple possible property paths
    const getNestedValue = (obj, ...paths) => {
      for (const path of paths) {
        const keys = path.split('.');
        let value = obj;
        for (const key of keys) {
          if (value && typeof value === 'object' && key in value) {
            value = value[key];
          } else {
            value = null;
            break;
          }
        }
        if (value) return value;
      }
      return null;
    };
    
    const title = getNestedValue(
      video,
      'basic_info.title',
      'title',
      'video_details.title',
      'primary_info.title',
      'video.title'
    ) || "";
    
    const description = getNestedValue(
      video,
      'basic_info.short_description',
      'description',
      'video_details.short_description',
      'primary_info.short_description',
      'video.description',
      'basic_info.description',
      'video_details.description'
    ) || "";
    
    const channel = getNestedValue(
      video,
      'basic_info.channel.name',
      'channel.name',
      'video_details.channel.name',
      'primary_info.channel.name',
      'video.channel.name',
      'basic_info.channel',
      'channel'
    ) || "";
    
    const viewCount = getNestedValue(
      video,
      'basic_info.view_count.text',
      'view_count.text',
      'video_details.view_count.text',
      'primary_info.view_count.text',
      'video.view_count.text',
      'basic_info.view_count',
      'view_count'
    ) || "";
    
    // Build comprehensive content from metadata
    let content = "";
    
    if (title) {
      content += `Video Title: ${title}\n\n`;
    }
    
    if (description) {
      // Limit description length to avoid token limits
      const maxDescLength = 2000;
      const truncatedDesc = description.length > maxDescLength 
        ? description.substring(0, maxDescLength) + "..."
        : description;
      content += `Video Description: ${truncatedDesc}\n\n`;
    }
    
    if (channel) {
      content += `Channel: ${channel}\n\n`;
    }
    
    if (viewCount) {
      content += `View Count: ${viewCount}\n\n`;
    }
    
    // If we have at least title and description, that's enough to generate a quiz
    if (content.trim().length > 0) {
      return content.trim();
    }
    
    return null;
  } catch (error) {
    console.error("Error getting video metadata:", error.message || error);
    return null;
  }
}

async function extractTranscriptWithYoutubei(videoId) {
  try {
    const yt = await Innertube.create();
    
    // Try to get video info, but handle parsing errors gracefully
    let video;
    try {
      video = await yt.getInfo(videoId);
    } catch (parseError) {
      // youtubei.js sometimes has parsing errors but still returns data
      // Try to continue if we can still access the video object
      if (parseError.video || parseError.info) {
        video = parseError.video || parseError.info;
      } else {
        console.log("youtubei.js failed to parse video info:", parseError.message);
        return null;
      }
    }
    
    // Try to get captions/transcripts - check different possible properties
    let captions = null;
    
    // Method 1: Check video.captions
    if (video.captions) {
      if (video.captions.caption_tracks) {
        captions = video.captions.caption_tracks;
      } else if (video.captions.tracks) {
        captions = video.captions.tracks;
      } else if (Array.isArray(video.captions)) {
        captions = video.captions;
      }
    }
    
    // Method 2: Check direct properties
    if (!captions) {
      if (video.caption_tracks) {
        captions = video.caption_tracks;
      } else if (video.transcript) {
        captions = video.transcript;
      }
    }
    
    // Method 3: Try to get from streaming data
    if (!captions && video.streaming_data) {
      try {
        const streamingData = video.streaming_data;
        if (streamingData.captions) {
          captions = streamingData.captions;
        }
      } catch (e) {
        // Ignore streaming data errors
      }
    }
    
    if (!captions || captions.length === 0) {
      console.log("No captions found in video info");
      return null;
    }

    // Find English captions first, or use the first available
    let captionTrack = captions.find((track) => 
      track.language_code === "en" || 
      track.language?.code === "en" || 
      track.code === "en" ||
      track.language_code?.startsWith("en") ||
      (track.language && track.language.code === "en")
    ) || captions[0];
    
    if (!captionTrack) {
      console.log("No caption track found");
      return null;
    }

    // Get the caption URL - check different possible properties
    let captionUrl = null;
    if (captionTrack.base_url) {
      captionUrl = captionTrack.base_url;
    } else if (captionTrack.url) {
      captionUrl = captionTrack.url;
    } else if (typeof captionTrack.getUrl === 'function') {
      try {
        captionUrl = await captionTrack.getUrl();
      } catch (e) {
        console.log("Error getting caption URL:", e.message);
      }
    } else if (captionTrack.url_base) {
      captionUrl = captionTrack.url_base;
    }

    if (!captionUrl) {
      console.log("No caption URL found in track:", Object.keys(captionTrack));
      return null;
    }

    // Fetch the caption content using fetch (Node.js 18+) or axios as fallback
    let xmlText = null;
    try {
      // Try using fetch first (Node.js 18+)
      if (typeof fetch !== 'undefined') {
        const response = await fetch(captionUrl);
        xmlText = await response.text();
      } else {
        // Fallback to axios if fetch is not available
        const response = await axios.get(captionUrl);
        xmlText = response.data;
      }
    } catch (fetchError) {
      console.error("Error fetching caption content:", fetchError);
      return null;
    }
    
    if (!xmlText) {
      return null;
    }

    // Parse XML captions (simple extraction of text content)
    // YouTube captions are in XML format with <text> tags
    const textMatches = xmlText.match(/<text[^>]*>([^<]*)<\/text>/g);
    if (!textMatches || textMatches.length === 0) {
      // Try alternative format (some captions might use different XML structure)
      const altMatches = xmlText.match(/<p[^>]*>([^<]*)<\/p>/g);
      if (altMatches) {
        const transcriptText = altMatches
          .map((match) => {
            const textMatch = match.match(/<p[^>]*>([^<]*)<\/p>/);
            return textMatch ? textMatch[1].trim() : "";
          })
          .filter((text) => text.length > 0)
          .join(" ");
        return transcriptText.length > 0 ? transcriptText : null;
      }
      return null;
    }

    // Extract text from each caption entry and decode HTML entities
    const transcriptText = textMatches
      .map((match) => {
        const textMatch = match.match(/<text[^>]*>([^<]*)<\/text>/);
        if (textMatch) {
          let text = textMatch[1].trim();
          // Decode common HTML entities
          text = text.replace(/&amp;/g, '&')
                     .replace(/&lt;/g, '<')
                     .replace(/&gt;/g, '>')
                     .replace(/&quot;/g, '"')
                     .replace(/&#39;/g, "'")
                     .replace(/&nbsp;/g, ' ');
          return text;
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join(" ");

    return transcriptText.length > 0 ? transcriptText : null;
  } catch (error) {
    console.error("youtubei.js fallback error:", error.message || error);
    return null;
  }
}

export async function extractFromYoutube(url) {
  const videoIdMatch = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  if (!videoId) {
    throw new Error("Invalid YouTube URL. Please provide a valid YouTube video URL.");
  }

  let transcriptText = null;
  let primaryMethodFailed = false;

  // Try primary method first (youtube-transcript package)
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    
    if (!transcript || transcript.length === 0) {
      primaryMethodFailed = true;
    } else {
      transcriptText = transcript.map((t) => t.text).join(" ");
      
      if (!transcriptText || transcriptText.trim().length === 0) {
        primaryMethodFailed = true;
      }
    }
  } catch (error) {
    // Check if it's a recoverable error (transcript disabled/not available)
    if (
      error instanceof YoutubeTranscriptDisabledError ||
      error instanceof YoutubeTranscriptNotAvailableError ||
      (error.message && error.message.includes("disabled"))
    ) {
      primaryMethodFailed = true;
      console.log("Primary transcript method failed, trying fallback...");
    } else if (error instanceof YoutubeTranscriptVideoUnavailableError) {
      throw new Error("Video is unavailable or has been removed. Please check the video URL.");
    } else if (error instanceof YoutubeTranscriptError) {
      // Try fallback for other transcript errors
      primaryMethodFailed = true;
      console.log("Primary transcript method failed, trying fallback...");
    } else {
      // For other errors, try fallback before giving up
      primaryMethodFailed = true;
      console.log("Primary transcript method failed, trying fallback...");
    }
  }

  // If primary method failed, try fallback using youtubei.js
  if (primaryMethodFailed || !transcriptText) {
    console.log("Attempting to fetch transcript using youtubei.js fallback...");
    try {
      transcriptText = await extractTranscriptWithYoutubei(videoId);
    } catch (fallbackError) {
      console.error("Fallback method also failed:", fallbackError.message);
      // Continue to error handling below
    }
  }

  // If both transcript methods failed, try using video metadata as fallback
  if (!transcriptText || transcriptText.trim().length === 0) {
    console.log("No transcript available, trying to use video metadata...");
    try {
      const metadataContent = await getVideoMetadata(videoId);
      if (metadataContent && metadataContent.trim().length > 0) {
        console.log("Using video metadata to generate quiz");
        // Add a note that we're using metadata instead of transcript
        return `[Note: This quiz is generated from video metadata as the video doesn't have captions]\n\n${metadataContent}`;
      }
    } catch (metadataError) {
      console.error("Error getting video metadata:", metadataError.message);
    }
    
    // If everything failed, throw an error
    throw new Error(
      "Unable to generate quiz from this video. The video may be unavailable, private, or have restricted access. " +
      "Please try a different video."
    );
  }

  return transcriptText;
}


export async function generateQuizWithAI({ text, difficulty, numQuestions, allowImages }) {
  const clampedNum = Math.max(1, Math.min(20, Number(numQuestions) || 5));
  const trimmedText = text.slice(0, 6000);

  const systemPrompt = `
You are an AI that generates multiple-choice quiz questions.
You MUST return ONLY valid JSON in the following structure (no markdown, no comments):
{
  "questions": [
    {
      "question": "string",
      "image": "string or null",
      "options": [
        { "text": "string", "image": "string or null" },
        { "text": "string", "image": "string or null" },
        { "text": "string", "image": "string or null" },
        { "text": "string", "image": "string or null" }
      ],
      "correctAnswer": "option text, must exactly match one of the option.text values"
    }
  ]
}
Difficulty: ${difficulty}.
Images are optional; if unsure, set image fields to null or empty string.
`;

  const userPrompt = `
Source content:
${trimmedText}

Generate exactly ${clampedNum} multiple-choice questions from the above content.
Each with exactly 4 options and exactly one correct answer.
Allow image-based questions or options if it makes sense (set image to a short description or URL placeholder).
Return pure JSON, no markdown, no comments, matching the JSON schema described.
`;

  let response;
  try {
    response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });
  } catch (err) {
    // Surface quota / rate-limit errors in a friendlier way to the route handler
    if (err?.status === 429 || err?.code === "insufficient_quota") {
      const wrapped = new Error("AI_QUOTA_EXCEEDED");
      wrapped.status = 429;
      wrapped.originalMessage =
        err?.error?.message || err?.message || "AI provider quota exceeded";
      throw wrapped;
    }
    throw err;
  }

  const content = response.choices[0]?.message?.content || "{}";

  let parsed = {};
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.error("Failed to parse AI JSON:", e);
    parsed = {};
  }

  let questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(questions)) {
    questions = [];
  }

  return questions.map((q) => ({
    question: q.question || "",
    image: q.image || "",
    options: (q.options || []).slice(0, 4).map((opt) => ({
      text: opt.text || "",
      image: opt.image || "",
    })),
    correctAnswer: q.correctAnswer || (q.options?.[0]?.text || ""),
  }));
}


