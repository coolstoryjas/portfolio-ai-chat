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

// Match your actual Supabase / CSV schema
type PortfolioRow = {
  project: string;
  type: string;
  title: string | null;
  content: string;
  tags: string | null;
  role: string | null;
  pillar: string | null;
  medium: string | null;
  aspect: string | null;
  audience: string | null;
  tools_methods: string | null;
  one_liner: string | null;
  is_highlight: boolean | null;
  depth: string | null;
};

// In-memory cache so we don't hit Supabase every turn
let knowledgeCache: PortfolioRow[] | null = null;

// Types to prioritize for core explanation
const PREFERRED_TYPES = new Set(["project_summary", "summary", "outcome", "method"]);

// Depth priority: overview > supporting > deep_dive
function depthScore(depth: string | null | undefined): number {
  const d = depth?.toLowerCase() ?? "";
  if (d === "overview") return 2;
  if (d === "supporting_detail") return 1;
  return 0;
}

// Max conversation history messages to send
const MAX_HISTORY_MESSAGES = 6;

// --- Load all knowledge once (cached) ---
async function loadAllKnowledge(): Promise<PortfolioRow[]> {
  if (!supabase) {
    console.warn(
      "[chat route] Supabase client not initialized; skipping knowledge fetch."
    );
    return [];
  }

  if (knowledgeCache) {
    return knowledgeCache;
  }

  const dbStart = Date.now();
  try {
    const { data, error } = await supabase
      .from("portfolio-knowledge")
      .select("*")
      .order("id", { ascending: true });

    console.log(
      "[chat route] Supabase fetch time (ms):",
      Date.now() - dbStart
    );

    if (error) {
      console.error("[chat route] Supabase error:", error);
      return [];
    }

    knowledgeCache = (data as PortfolioRow[]) || [];
    return knowledgeCache;
  } catch (err) {
    console.error("[chat route] Knowledge fetch failed:", err);
    return [];
  }
}

// --- Scope knowledge using project / title / tags / pillar / medium / audience ---
function scopeKnowledgeToMessage(
  message: string,
  rows: PortfolioRow[],
  maxRows: number = 12
): PortfolioRow[] {
  if (!rows.length) return [];

  const q = message.toLowerCase();

  const matches = rows.filter((row) => {
    const project = row.project?.toLowerCase?.() ?? "";
    const title = row.title?.toLowerCase?.() ?? "";
    const tags = row.tags?.toLowerCase?.() ?? "";
    const pillar = row.pillar?.toLowerCase?.() ?? "";
    const medium = row.medium?.toLowerCase?.() ?? "";
    const audience = row.audience?.toLowerCase?.() ?? "";

    const hitProject = project && q.includes(project);
    const hitTitle = title && q.includes(title);
    const hitTags =
      tags &&
      q
        .split(/\W+/)
        .some((word) => word && tags.includes(word.toLowerCase()));
    const hitPillar = pillar && q.includes(pillar);
    const hitMedium = medium && q.includes(medium);
    const hitAudience = audience && q.includes(audience);

    return hitProject || hitTitle || hitTags || hitPillar || hitMedium || hitAudience;
  });

  const relevant = matches.length > 0 ? matches : rows;

  // Prioritize by type + depth
  const sorted = [...relevant].sort((a, b) => {
    const aTypePref = PREFERRED_TYPES.has(a.type.toLowerCase()) ? 1 : 0;
    const bTypePref = PREFERRED_TYPES.has(b.type.toLowerCase()) ? 1 : 0;
    const aScore = aTypePref * 2 + depthScore(a.depth);
    const bScore = bTypePref * 2 + depthScore(b.depth);
    return bScore - aScore;
  });

  return sorted.slice(0, maxRows);
}

// --- Build the text that actually goes into the prompt ---
function buildContextText(rows: PortfolioRow[]): string {
  if (!rows.length) {
    return "No matching entries found in portfolio-knowledge.";
  }

  return rows
    .map((row) => {
      const lines = [
        `PROJECT: ${row.project}`,
        `TYPE: ${row.type}`,
        `TITLE: ${row.title ?? "(no title)"}`,
        `PILLAR: ${row.pillar ?? "(none)"}`,
        `MEDIUM: ${row.medium ?? "(none)"}`,
        `AUDIENCE: ${row.audience ?? "(none)"}`,
        `TAGS: ${row.tags ?? "(none)"}`,
        `ROLE: ${row.role ?? "(unspecified)"}`,
        `ONE_LINER: ${row.one_liner ?? "(none)"}`,
        `TOOLS_METHODS: ${row.tools_methods ?? "(none)"}`,
        `DEPTH: ${row.depth ?? "(none)"}`,
        `CONTENT: ${row.content}`,
      ];
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

// --- Main handler ---
export async function POST(req: NextRequest) {
  const routeStart = Date.now();

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

    // Trim history so prompt doesn’t grow unbounded
    const convoTrimmed =
      convo.length > MAX_HISTORY_MESSAGES
        ? convo.slice(-MAX_HISTORY_MESSAGES)
        : convo;

    // 1. Load + scope knowledge
    const allKnowledge = await loadAllKnowledge();
    const scopedKnowledge = scopeKnowledgeToMessage(message, allKnowledge);
    const contextText = buildContextText(scopedKnowledge);

    // 2. System prompt: constrained, short, grounded, using your actual data
const systemPrompt = `
You are an AI assistant for Jasmine's AI × UX portfolio.

ROLE
- Help people learn about Jasmine's projects, skills, experience, and approach to AI × UX.
- Only use the Portfolio knowledge below as your source of truth.
- If you don’t have information, say so clearly and suggest 1–2 related projects or topics instead.

TONE
- Warm, confident, and a little playful; community-leader energy.
- Use direct address ("you", "we", "mi gente") and light Spanglish when it fits.
- Keep language clear and simple. Hype is fine, confusion is not.
- Do NOT use the phrase pattern "it isn’t X, it’s Y."

DATA MODEL
- Each row has: project, section_type, title, content, tags, audience, tools_methods.
- The only valid project IDs in this portfolio are:
  - designing_agents
  - jascore_1_0
  - living_library
  - mj_creative_system
  - satori_2_0
  - spatial_interfaces_ai_design
  - ten_shifts_ai_ux
- The "about_me" project is NOT a case study. Use it only for questions about who Jasmine is, her background, and her overall focus.
- A “project” is one of the project IDs listed above that has at least one row with section_type = "summary".
- Never treat tags, themes, or phrases from content (like "AI × UX", "Human-Centered AI", "Conversational AI for Social Impact") as project names.

PROJECT LIST BEHAVIOR
- WHEN USER SAYS: "projects", "show me the projects", "what projects can I explore?" or similar:
  - Respond with a bullet list.
  - For each valid project ID:
    - Use the \`title\` from one of its \`summary\` rows as the display name.
    - Use 1 short sentence based on its \`content\` as the description.
  - After the list, ask: "Which one do you want to explore first?"
- Do NOT list anything else as a project.

ANSWER PATTERNS
- On greeting:
  "Hola! I’m Jasmine’s AI Experience comadre, here to walk you through her world — projects, skills, the whole ecosystem. What are you curious about?"
- “Who is she?” → Use about_me summary/background rows for a short bio, then suggest 2–3 things to explore (key projects or themes).
- “What’s the latest work?” → If no explicit “latest”, say you don’t have that, then offer 1 strategic/research project + 1 experimental/creative project and ask which they want first.
- When the user picks a project:
  - First explain what it is and what Jasmine was exploring/solving (using summary rows).
  - Then offer a follow-up choice like: “You want more on the problem, the process, or the impact?”
- “What questions can I ask?” → List 3–5 categories (e.g., design process, favorite projects, tools, background, philosophy), then ask which they want.

FORMATTING
- Answer in short paragraphs by default.
- Use bullet lists only when the user asks for options, lists, menus, “what can I explore”, or “what questions can I ask?”
- After any list, offer a simple next step question about what they want next.

HONESTY
- If the portfolio doesn’t contain what they asked for, say that directly, then route them to nearby projects or topics.
- Always stay grounded in the portfolio text; lightly rewrite for clarity and tone, but don’t change the meaning.

Portfolio knowledge:
\${contextText}
`.trim();



    // 3. Prepare messages for Groq
    const groqMessages: any[] = [
      { role: "system", content: systemPrompt },
      ...convoTrimmed,
      { role: "user", content: message },
    ];

    const llmStart = Date.now();
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: groqMessages,
      temperature: 0.3,
      max_tokens: 350,
    });
    console.log(
      "[chat route] Groq call time (ms):",
      Date.now() - llmStart
    );

    const content =
      completion.choices?.[0]?.message?.content?.trim() ?? "";

    const aiResponse =
      content.length > 0
        ? content
        : "I couldn’t generate a response based on the current portfolio data.";

    console.log(
      "[chat route] Total route time (ms):",
      Date.now() - routeStart
    );

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






