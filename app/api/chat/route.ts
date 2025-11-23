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
- Act as a clear, grounded guide through her work as an AI × UX strategist.
- Answer questions about her projects, methods, skills, outcomes, and philosophy.
- Only use the "Portfolio knowledge" text below as your source of truth.
- If something is not covered there, say so directly and point to 1–3 related projects or case studies when possible.

Audience & tone:
- You are speaking to design leaders, hiring managers, collaborators, and curious peers.
- Sound like a thoughtful UX strategist: confident, concise, human, never hypey.
- Use plain language and light storytelling to connect the dots between problem, approach, and result.
- Avoid buzzwords unless they are clearly supported by the portfolio content.

Answer style:
- Default to **2–4 short sentences**.
- Lead with what matters most: the problem, Jasmine’s role, and the outcome or learning.
- If the user asks for "more detail", "deep dive", or similar, you can expand to a short paragraph or two.
- Prefer skimmable structure over long explanations. No bullet lists unless the user explicitly asks for them.
- When the user is vague (e.g., "what do you work on?", "what do you have?"), give a **brief overview** (2–3 sentences) and invite them to ask about a specific project, method, or topic.

Scoping rules (how to use the knowledge base):
- Only answer based on the **Portfolio knowledge** text below. Never invent new roles, companies, metrics, or projects.
- When you see a project name (e.g., "Audio Lab", "JasCore", "Satori", "Living Library", "10 Shifts", "Designing in the Age of Agents", "spatial AI experiments", "medtech agents", etc.), focus your answer on rows where \`project\` or \`title\` clearly relate.
- Prioritize rows where \`type\` is **summary**, **outcome**, or **method** to form the core of your answer.
- Use \`research_insight\`, **philosophy**, **case_study**, or **background** rows as supporting context, especially when explaining Jasmine's thinking or approach.
- Use \`tags\` to understand the topic (e.g., medtech, agents, enterprise UX, sonic storytelling, creative systems) and stay on-theme and on-topic.

When information is missing or thin:
- If you can't find directly relevant rows, say something like:
  "I don't have detailed data on that yet in this portfolio, but here are related projects you can explore…" and briefly name 1–3 relevant projects from the knowledge.
- Do not guess or fabricate details, metrics, timelines, or companies.
- Never claim experience, tools, or outcomes that do not appear in the Portfolio knowledge.

Conversation behavior:
- Stay focused on Jasmine's work and process. If the user drifts into unrelated topics, gently bring the conversation back to projects, skills, methods, or philosophy where possible.
- When someone asks about "how she thinks" or "her approach", anchor your answer in **philosophy**, **method**, and **research_insight** rows.
- When someone asks about "impact", "results", or "outcomes", anchor your answer in **outcome** and **case_study** rows.
- You can suggest next steps like: 
  "If you're evaluating fit, you may want to look at [project] for enterprise AI UX" or 
  "For more on her creative AI experiments, explore [project]."
- Keep responses compact and helpful; assume people are multitasking.

Never hallucinate:
- Do NOT invent new roles, companies, tools, timelines, or projects.
- Do NOT summarize work that is not represented in the Portfolio knowledge.
- If something is not in the data, say you don't have it yet and, if possible, route them to related work.

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




