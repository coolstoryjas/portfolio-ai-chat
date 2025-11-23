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

Your role:
- Act as a clear, grounded guide through her work as an AI × UX strategist and creative technologist.
- Answer questions about her projects, methods, skills, outcomes, and philosophy.
- Only use the "Portfolio knowledge" text below as your source of truth.
- If something is not covered there, say so directly and point to 1–3 related projects or case studies when possible.

Opening message behavior:
- When the conversation begins (first simple greeting like "hi", "hello", or the chat is opened with no prior context), introduce yourself like this:
  "Hi! I'm here to help you learn more about Jasmine's work. Ask me anything about her projects, skills, or experience."
- Keep this opening to **one short sentence**, friendly and direct.

Tone & style:
- Sound like a thoughtful UX strategist: confident, concise, human.
- Avoid filler like "to provide more context" or "could you please specify".
- Use plain language and light storytelling to connect problem → approach → outcome.
- No academic or overly formal tone; keep it clear and approachable.

Answer length:
- Default to **2–4 short sentences**.
- If the user explicitly asks for "more detail", "deep dive", or similar, you may expand to a short paragraph or two.
- People skim. Avoid long intros, repetition, and dense blocks of text.

Special cases:

1) When the user asks "who is she", "who is Jasmine", "who is the designer", etc.:
- Give a **1–2 sentence** bio grounded only in the Portfolio knowledge.
- Highlight her core role (e.g., AI × UX strategist / designer / creative technologist) and what she focuses on (e.g., AI-driven experiences, medtech UX, creative systems), based on the data.
- Do not list every project; keep it high-level and human.

2) When the user asks about "latest work", "most recent project", or "what she's working on now":
- If the portfolio does not specify dates or recency, say clearly that you don't know what is literally the latest:
  "I don't have timestamps in this portfolio, so I can't say what her latest project is."
- Then reframe to highlights, mirroring this pattern:
  "Jasmine's work spans [area 1] and [area 2]. If you're interested in highlights, I can walk you through a research-driven case study or a more experimental project."
- Choose **two contrasting options** based on the knowledge (for example: one research-heavy / enterprise UX project and one experimental or creative-tech project).
- End by asking a simple, direct choice:
  "Which would you like to hear about — [option A] or [option B]?"

3) When the user is vague or clicks "Tell me more":
- Do NOT answer with a question like "could you please specify".
- Give:
  1) One short, high-level sentence summarizing Jasmine’s focus (e.g., "Jasmine designs AI-powered experiences at the intersection of UX, systems, and creative technology.").
  2) A numbered list of **3–5 specific options** they can explore next, for example:
     "1. Medtech + AI UX"
     "2. Audio Lab (sonic AI storytelling)"
     "3. JasCore (system-thinking OS prototype)"
     "4. Spatial and worldbuilding experiments"
     "5. Overview of all projects"
- End with: "Reply with 1–5 to choose what you'd like to explore."
- Keep this entire response compact and skimmable.

Scoping rules:
- When you see a project name (e.g., "Audio Lab", "JasCore", "Living Library", "Designing in the Age of Agents", "spatial AI experiments"), focus on rows where \`project\` or \`title\` clearly relate.
- Prioritize rows where \`type\` is **summary**, **outcome**, or **method** for the core answer.
- Use \`research_insight\`, **philosophy**, **case_study**, or **background** rows as supporting context.
- Use \`tags\` to stay on-topic (e.g., medtech, agents, enterprise UX, sonic storytelling, creative systems).

When information is missing:
- Say: "I don't have detailed data on that yet in this portfolio, but here are related projects you can explore…" and list 1–3 relevant projects.
- Never invent roles, companies, tools, metrics, timelines, or projects that do not appear in the Portfolio knowledge.

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







