import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// --- CORS handler (for cross-domain calls, e.g. Orchids) ---
export async function OPTIONS() {
  return NextResponse.json(
    {},
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    }
  );
}

// --- Environment variables ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Log once at module load so you see issues in Vercel logs
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[chat route] Supabase env vars missing. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
  );
}

if (!GROQ_API_KEY) {
  console.warn("[chat route] GROQ_API_KEY is missing.");
}

// --- Initialize Supabase client (if envs exist) ---
const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// --- Initialize Groq client ---
const groq = new Groq({
  apiKey: GROQ_API_KEY || "",
});

type PortfolioRow = {
  project: string;
  type: string;
  title: string | null;
  content: string;
  tags: string | null;
  participant: string | null;
};

// --- Helper: fetch matching portfolio entries from Supabase ---
async function fetchKnowledge(_query: string): Promise<PortfolioRow[]> {
  if (!supabase) {
    console.warn(
      "[chat route] Supabase client not initialized; skipping knowledge fetch."
    );
    return [];
  }

  try {
    // For now: just grab the first 20 rows, no filter
    const { data, error } = await supabase
      .from("portfolio-knowledge")
      .select("*")
      .order("id", { ascending: true })
      .limit(20);

    if (error) {
      console.error("[chat route] Supabase error:", error);
      return [];
    }

    return (data as PortfolioRow[]) || [];
  } catch (err) {
    console.error("[chat route] Knowledge fetch failed:", err);
    return [];
  }
}

// --- Main handler ---
export async function POST(req: NextRequest) {
  try {
    if (!GROQ_API_KEY) {
      return NextResponse.json(
        { response: "Server misconfigured: GROQ_API_KEY is not set." },
        {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    const body = await req.json().catch(() => null);

    if (!body || typeof body.message !== "string") {
      return NextResponse.json(
        { response: "No message provided." },
        {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    const message: string = body.message;
    const historyRaw = Array.isArray(body.history)
      ? body.history
      : Array.isArray(body.conversationHistory)
      ? body.conversationHistory
      : [];

    // Normalize history into { role, content } pairs
    const convo = historyRaw
      .map((m: any) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
      }))
      .filter((m: { content: string }) => m.content.trim().length > 0);

    // 1. Fetch context from Supabase
    const knowledge = await fetchKnowledge(message);

    const contextText =
      knowledge.length > 0
        ? knowledge
            .map(
              (row) =>
                `PROJECT: ${row.project}\nTYPE: ${row.type}\nTITLE: ${
                  row.title ?? "(no title)"
                }\nTAGS: ${row.tags ?? "(none)"}\nCONTENT: ${row.content}`
            )
            .join("\n\n---\n\n")
        : "No matching entries found in portfolio-knowledge.";

    // 2. Build system prompt
const systemPrompt = `
You are an AI assistant for Jasmine's AI × UX portfolio.

Your job:
- Help people learn about Jasmine's projects, skills, experience, and approach to AI × UX.
- Only use the Portfolio knowledge below as your source of truth.
- If you don't have a specific detail, say so clearly and offer related projects they can explore instead.

When the chat starts:
- Greet the user like this:
  "Hi! I'm here to help you learn more about Jasmine's work. Ask me anything about her projects, skills, or experience."

Tone and style:
- Friendly, clear, and professional-warm.
- Short, direct sentences. No filler like "to provide more context" or "could you please specify".
- Aim for 2–4 sentences by default. Expand only if the user asks for more detail.

If the user asks "who is she?":
- Give a 1–2 sentence bio based on the portfolio:
  - Her role (AI × UX strategist / creative technologist).
  - The kinds of work she does (e.g., AI-driven UX, medtech, creative systems, spatial/sonic experiments).

If the user asks about "latest work" or "what she's working on now":
- Follow this pattern (adapt project names from the knowledge):
  "I don't have that specific information in this portfolio. Jasmine's work is quite diverse, spanning AI-driven UX and creative systems. If you're interested in highlights, I can tell you about two key projects: [Project A] for a more research-driven, strategic view, and [Project B] for a more experimental exploration. Which would you like to hear about – research-driven or experimental?"

When the user picks a project or type (e.g., "experimental" or a project name):
- Briefly explain the project in 2–4 sentences:
  - What it is.
  - What Jasmine was exploring or solving.
  - Any important context (e.g., prototype vs live, who it was for) if the data supports it.
- Then always end with one follow-up like:
  "Would you like to know more about the tech, the design process, or the impact?"

When the user picks an aspect (e.g., tech, design process, research, impact):
- Answer with 2–4 sentences focused on that aspect only, using the most relevant rows.
- You may add a light follow-up such as:
  "If you'd like, I can also connect this to her other projects."

If the user asks "what can you answer about Jasmine?":
- Explain the scope in 2–3 sentences:
  - You can talk about her projects, methods, tools, audiences, outcomes, and how she thinks about AI × UX.
  - Invite them to choose something specific, for example:
    "You can ask about a specific project, her UX process, her AI work in medtech, or her experimental systems. What would you like to know?"

If the user is vague ("tell me more", "what else?", "what do you have?"):
- Give one short sentence about her overall focus.
- Then list 3–5 concrete options they can choose from, such as:
  "1. Medtech + AI UX"
  "2. Audio Lab (sonic storytelling)"
  "3. JasCore (OS-style system thinking)"
  "4. Spatial AI experiments"
  "5. Overview of all projects"

Never hallucinate:
- Do not invent new roles, companies, metrics, tools, or projects.
- If the portfolio doesn’t include something, say you don’t have that information yet and point them to related projects instead.

Portfolio knowledge (only source of truth):
${contextText}
`;


    // 3. Prepare messages for Groq
    const groqMessages: any[] = [
      { role: "system", content: systemPrompt },
      ...convo,
      { role: "user", content: message },
    ];
    
    // 4. Call Groq with a valid model ID
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant", // Groq's Llama 3 8B Instruct-equivalent
      messages: groqMessages,
      temperature: 0.3,
      max_tokens: 350,
    });

    const content =
      completion.choices?.[0]?.message?.content?.trim() ?? "";

    const aiResponse =
      content.length > 0
        ? content
        : "I couldn’t generate a response based on the current portfolio data.";

    // 5. Return in the shape your frontend expects
    return NextResponse.json(
      { response: aiResponse },
      {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  } catch (err: any) {
    console.error("[chat route] Fatal error:", err);

    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "string"
        ? err
        : "Unknown error";

    return NextResponse.json(
      { response: `Server error in chat route: ${msg}` },
      {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  }
}











