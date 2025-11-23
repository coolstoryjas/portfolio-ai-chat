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
async function fetchKnowledge(query: string): Promise<PortfolioRow[]> {
  if (!supabase) {
    console.warn(
      "[chat route] Supabase client not initialized; skipping knowledge fetch."
    );
    return [];
  }

  try {
    // escape LIKE wildcards in user query
    const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const pattern = `%${escaped}%`;

    const { data, error } = await supabase
      .from("portfolio-knowledge")
      .select("*")
      .or(
        [
          `content.ilike.${pattern}`,
          `title.ilike.${pattern}`,
          `project.ilike.${pattern}`,
          `tags.ilike.${pattern}`,
          `participant.ilike.${pattern}`,
        ].join(",")
      )
      .limit(8);

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
You are an AI assistant for Jasmine’s UX portfolio.

Your job:
- Give short, grounded answers (2–4 sentences).
- Base EVERYTHING you say ONLY on the Supabase portfolio knowledge provided.
- If you don’t have enough information, say:
  "I don’t have data on that yet, but here’s a related project…" and choose the closest match.

Never hallucinate new case studies, roles, companies, or metrics.
If something isn’t in the data, say so clearly.

Here is the portfolio knowledge you can use:
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

