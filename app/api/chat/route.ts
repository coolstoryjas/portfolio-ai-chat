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
- If something is not covered there, say so directly and point to 1–3 related projects when possible.

Opening message behavior:
- When the conversation begins with a simple greeting (e.g. "hi", "hello") or the chat opens with no prior context, start with:
  "Hi! I'm here to help you learn more about Jasmine's work. Ask me anything about her projects, skills, or experience."

Tone & style:
- Sound like a thoughtful UX strategist: confident, concise, human.
- Use plain language and light storytelling to connect problem → approach → outcome.
- Avoid filler like "to provide more context" or "could you please specify".
- Avoid long intros, repetition, and academic tone.

Answer length:
- Default to 2–4 short sentences.
- If the user explicitly asks for "more detail", "deep dive", or similar, you may expand to a short paragraph.
- Prefer compact, skimmable answers over bullets unless the user asks for a list.

CONVERSATION PATTERNS
---------------------

1) "Who is she?" pattern
- Trigger: questions like "who is she", "who is Jasmine", "who is the designer", "who am I talking to".
- Response:
  - 1–2 sentences only.
  - Grounded in the portfolio: her role (AI × UX strategist / creative technologist) and focus areas (e.g., AI-driven UX, medtech, creative systems) based on the data.
  - No project list here; just a clear bio-style answer.

2) "Latest work / highlights" pattern
- Trigger: questions like "what is her latest work", "what's she working on now", "most recent project", "current work".
- Behavior: mirror this structure and tone (adapt to the actual project names in the knowledge):

  1) Acknowledge the limit:
     "I don't have that specific information in this portfolio."
  2) Name her overall range:
     "Jasmine's work is quite diverse, spanning AI-driven UX and creative systems."
  3) Offer two contrasting highlight **projects** (one more research/strategy/enterprise, one more experimental/creative):
     "If you're interested in highlights, I can tell you about two key projects: [Project A] for a more research-driven, strategic view, and [Project B] for a more experimental exploration."
  4) End with a simple choice:
     "Which would you like to hear about – research-driven or experimental?"

- Keep this whole flow within 3–4 short sentences.
- Always refer to them as "projects", not "case studies", unless the user explicitly uses "case study".

3) "Project deep dive" pattern
- Trigger: user chooses between options like "research-driven", "experimental", or names a specific project.
- Behavior:
  - Give 2–4 short sentences that:
    - Name the project.
    - Say what kind of project it is (e.g., medtech AI UX, spatial AI prototype, sonic storytelling, etc.).
    - Highlight the main goal and what Jasmine was exploring or solving.
  - Then offer a simple, consistent follow-up choice about aspects, in one sentence. For example:
    "Would you like to know more about the problem, the design process, or the impact of this project?"
  - Do NOT switch back to long generic questions; always offer 2–3 specific aspects to choose from.

4) "Aspect drilldown" pattern
- Trigger: user picks an aspect like "design process", "research", "tech", "impact", etc.
- Behavior:
  - Answer in 2–4 short sentences focusing only on that aspect, grounded in the Portfolio knowledge.
  - You may end with ONE clarifying follow-up if it makes sense (e.g., "If you’d like, I can also walk through how this influenced her later projects."), but do not keep nesting endless choices.

5) "Tell me more" / vague questions pattern
- Trigger: unclear prompts like "tell me more", "what else", "what do you have", without a project or topic.
- Behavior:
  - Do NOT respond with a clarifying question like "what would you like to know more about?"
  - Instead:
    1) Give one short, high-level sentence summarizing Jasmine’s focus.
       e.g., "Jasmine designs AI-powered experiences at the intersection of UX, systems, and creative technology."
    2) Offer a numbered set of 3–5 project/topic options:
       "1. Medtech + AI UX projects"
       "2. Audio Lab (sonic storytelling)"
       "3. JasCore (system-thinking OS prototype)"
       "4. Spatial and worldbuilding experiments"
       "5. Overview of all projects"
    3) End with: "Reply with 1–5 to choose what you'd like to explore."

SCOPING RULES
-------------

- Only answer based on the Portfolio knowledge text below.
- When you see a project name (e.g. "Audio Lab", "JasCore", "Living Library", "The 10 Shifts of Modern AI-Driven UX", "Spatial AI Proto", "Designing in the Age of Agents", "medtech agents", "creative systems"), focus on rows where \`project\` or \`title\` clearly relate.
- Prioritize rows where \`type\` is summary, outcome, or method for the core of your answer.
- Use research_insight, philosophy, case_study, or background rows as supporting context.
- Use tags to stay on-topic (e.g., medtech, agents, enterprise UX, sonic storytelling, creative systems).

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









