import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// --- CORS handler (for cross-domain calls from Orchids) ---
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

// --- Initialize Supabase client ---
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// --- Initialize Groq ---
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// --- Helper: fetch matching portfolio entries ---
async function fetchKnowledge(query: string) {
  try {
    const { data, error } = await supabase
      .from("portfolio_knowledge")
      .select("*")
      .or(
        `content.ilike.%${query}%,title.ilike.%${query}%,project.ilike.%${query}%`
      )
      .limit(8);

    if (error) {
      console.error("Supabase error:", error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error("Knowledge fetch failed:", err);
    return [];
  }
}

// --- Main handler ---
export async function POST(req: NextRequest) {
  try {
    const { message, history, conversationHistory } = await req.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { response: "No message provided." },
        {
          status: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Normalize conversation history (supports both field names)
    const convo = Array.isArray(history)
      ? history
      : Array.isArray(conversationHistory)
      ? conversationHistory
      : [];

    // 1. Fetch context from Supabase
    const knowledge = await fetchKnowledge(message);

    const contextText = knowledge
      .map(
        (row: any) =>
          `PROJECT: ${row.project}\nTYPE: ${row.type}\nTITLE: ${row.title}\nCONTENT: ${row.content}`
      )
      .join("\n\n---\n\n");

    // 2. Build system prompt
    const systemPrompt = `
You are an AI assistant for Jasmine’s UX portfolio.
Your job is to give short, grounded answers (2–4 sentences).
Base EVERYTHING you say ONLY on the Supabase knowledge provided.
If something is missing, say:
"I don’t have data on that yet, but here’s a related project…" and pick the closest match.

Never hallucinate. Never invent case studies, roles, or details not explicitly in the dataset.

Here is the portfolio knowledge you can use:
${contextText || "No matching entries found."}
`;

    // 3. Prepare conversation history
    const groqMessages: any[] = [
      { role: "system", content: systemPrompt },
      ...convo.map((m: any) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    // 4. Call Groq
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-70b",
      messages: groqMessages,
      temperature: 0.4,
      max_tokens: 350,
    });

    const aiResponse =
      completion.choices?.[0]?.message?.content ||
      "I couldn’t generate a response.";

    // 5. Return the correct frontend format
    return NextResponse.json(
      { response: aiResponse },
      {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    console.error("Chat route error:", err);
    return NextResponse.json(
      { response: "Server error while generating response." },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
