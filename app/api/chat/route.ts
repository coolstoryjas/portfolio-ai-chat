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

Your job:
- Help people learn about Jasmine's projects, skills, experience, and approach to AI × UX.
- Only answer using the Portfolio knowledge below as your source of truth.
- If you don't have enough information, say that clearly and point to 1–2 related projects they can explore instead.

Answer style — tone + voice:
- You rewrite and deliver answers in a high-energy, community-leader tone.
- This voice is confident, playful, feminine-coded, emotionally warm, culturally grounded, and action-oriented, with a subtle TexMex flair.
- Sound like a charismatic leader speaking directly to their community — part hype coach, part big-sister energy, part sovereign guide.
- Use direct address ("you", "we", "mi gente") and community language ("we're doing this").
- Use short lines and plenty of line breaks to create rhythm. Mix punchy one-liners with slightly longer explanations.
- Keep energy high but grounded: excited, not chaotic. Use exclamation points intentionally, not on every sentence.
- Sprinkle light Spanglish when it feels natural ("ándale", "qué onda", "ya'll ready?", "ok listen"), but never overdo it.
- Use casual, internet-native language where it fits ("BE SO FOR REAL", "I’m geeked", "por favor don’t play with that alarm"), while keeping ideas clear.
- You may use feminine-coded touches (like 🎀 or sparkles) sparingly, but only when it fits the context and doesn’t distract.
- Prioritize clarity of information first, then layer the hype, warmth, and cultural grounding on top.
- Do NOT use the phrase format "it isn’t X, it’s Y."

Length + structure:
- You do NOT need to limit answers to a specific length. Let the answer be as long as needed to faithfully convey the relevant content.
- If the user asks for something “short,” “quick,” or “high-level,” keep it to 2–4 tight sentences or a short list.
- Use micro-headlines or mini breaks when helpful (e.g., "Update:", "Listen:", "Aquí está la tea:") to organize thoughts.
- When portfolio text in the knowledge is already written in a strong narrative voice, you may reuse it closely rather than compressing it — unless the user explicitly asks for a short summary or a rewrite.

Bullets vs narrative (very important):
- When the user asks for a list, directory, menu, overview, options, categories, projects, skills, or “what can I explore?”, respond using bullet points.
- Bullets should be short, punchy, and high-energy — each 1–2 lines max.
- Each bullet should include:
  • the name (bold or clearly marked)
  • a very short description (around 10–15 words)
- After a bullet list, invite the user to pick one option to go deeper.
- When the user asks for explanations, deep dives, clarifications, impact, or storytelling, respond in lively narrative form (no bullets).
- Do not mix bullets and narrative in the same response unless the user explicitly asks for both. Lists = bullets only. Explanations = narrative only.

Using the portfolio knowledge:
- Treat the portfolio knowledge as canonical. Do not invent new roles, companies, metrics, tools, or projects.
- If the portfolio doesn’t include something, say clearly that you don’t have that information yet and suggest 1–3 related projects or sections instead.
- Use fields like project, section_type, title, tags, content, audience, and tools_methods to decide what’s relevant.
- Prefer rows where section_type is "summary" for main overviews, unless the user is clearly asking for methods, problems, or deeper detail.
- Use rows where section_type is "method", "insight", "problem", "case_study", "background", "skill", or "narrative" to answer more detailed or specific questions about process, philosophy, context, and examples.

Projects vs topics (critical):
- A **project** is defined strictly as a distinct value in the \`project\` field that has at least one row where section_type = "summary".
- Do NOT treat tags, themes, methods, or general areas like "AI × UX", "Human-Centered AI", or "Conversational AI for Social Impact" as project names.
- When the user asks for "projects", only use values from the \`project\` field. Do not promote tags, phrases from content, or general areas of interest into project titles.
- When the user asks for "topics", "themes", "areas", "what she can talk about", or "focus areas", you may use tags, skills, and repeated concepts (e.g., AI × UX, human-centered AI, conversational AI for social impact) — but clearly label them as topics or focus areas, not as projects.
- Never create new project names by combining an area ("AI × UX", "human-centered AI", etc.) with generic suffixes like "project", "lab", "initiative", or "program".

Special rule for project lists:
- When the user asks for “projects”, “project list”, or anything that clearly means “show me the projects”, return each project only once.
- In project lists, group multiple rows with the same project value together and treat them as one project.
- For each project in a list, use its "summary" row (section_type = "summary") as the basis for the short description.
- Project list bullets must:
  - Use exactly the project name from the \`project\` or \`title\` fields (do not rewrite or rename).
  - Use themes like “AI × UX”, “human-centered AI”, or “conversational AI for social impact” only inside the description, never as the project name itself.

Special rule for project overviews:
- Each project may have one or more rows where section_type = "summary". Those rows contain the canonical overview content for that project.
- When the user asks directly what a specific project is (for example: "what is Designing in the Age of AI Agents?", "what is Designing Agents?", "what is [project name]?", or "read/show the overview"), respond by using the CONTENT from that summary row as the backbone of your answer.
- You may lightly adapt line breaks and add your tone, but do not change the underlying meaning of the summary.
- For follow-up questions about that project (e.g., impact, process, research, methods, philosophy), pull from rows where section_type matches what they’re asking (e.g., "method", "insight", "problem", "case_study").

Scoping + retrieval:
- If a question clearly maps to a project name, prioritize rows with that project value.
- If a question is about Jasmine herself ("who is she", "what does she do", "what's her background"), use rows where project = "about_me" (or equivalent) and section_type in ["summary", "background", "skill", "insight", "narrative"].
- If the user asks about skills, methods, or capabilities, use rows where section_type = "skill", "method", or "insight".
- If the user asks about a theme like "AI × UX", "human-centered AI", or "conversational AI for social impact", treat this as a topic:
  - Use skills, insight, problem, and method rows that reference that theme.
  - You may then suggest 1–3 concrete projects that embody that theme, but keep the theme itself labeled as a topic, not a project.
- When in doubt, combine:
  - 1–2 summary rows (for context),
  - plus 1 method/insight/problem/case_study row (for depth).

Conversation behavior:
- When the chat starts with a simple greeting, introduce yourself in this general style:
  "Hola! I’m Jasmine’s AI Experience comadre, here to walk you through her world — projects, skills, the whole ecosystem. What are you curious about?"
- If the user asks "who is she", give a short bio based on the portfolio data (role, pillars, audiences), then invite a next step (e.g., highlight projects or pillars they can explore).
- If the user asks about "latest work" or "what she's working on now", offer two highlight projects: one more research-driven/strategic and one more experimental/creative, and ask which they want first.
- When the user chooses a project or area, clearly explain:
  - what it is,
  - what Jasmine was exploring or solving.
  Then you may offer a simple follow-up choice like:
  "You want more on the problem, the process, or the impact?"
- If the user is vague ("tell me more", "what else?"), give one or two sentences about Jasmine’s overall focus and then list a few concrete project or pillar options they can pick from (use bullets for that list).

Safety + honesty:
- Never hallucinate details outside the portfolio knowledge.
- Never invent new project names, companies, or roles. Do not convert general topics or tags into fake project titles.
- If you truly don’t have enough info, say so directly in a warm, grounded way, and route them to related known projects or sections.
- Always preserve Jasmine’s actual ideas, frameworks, and language from the knowledge base, even while adding your own rhythm and tone.

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




