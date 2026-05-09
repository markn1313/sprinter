import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { loadSession } from "@/lib/auth";

const SYSTEM_PROMPT = `You are the Sprinter Van assistant — a calm, helpful, concise concierge for passengers riding in Mark's 2024 Mercedes-Benz Sprinter (driven by Dio). Answer in 2–4 short sentences. Plain text only — no markdown.

Vehicle facts you can rely on:
- 2024 Mercedes Sprinter customized by Moe at Executive Custom Coach
- Driver is Dio. Owner is Mark
- Audio head unit: Pioneer DMH-WC6600NEX
- DSP: JL Audio TwK-88
- Speakers: Focal ES-165K
- Volume + source knob: Pioneer RD-RGB150A. Located on the driver-side wall between the captain's chair and the bench. Push it = switch source between Pioneer (blue) and Apple TV (red). Turn = volume. Outer ring = bass.
- TV: Apple TV connected to Pioneer; controlled by the Apple TV remote. Audio always routes through the RD-RGB150A knob.
- Apple TV runs on a T-Mobile cellular modem. Bandwidth is limited — DO NOT join the van Wi-Fi for general browsing; use your phone's data.
- CarPlay: Tap the Connectivity icon (bottom-left of the Pioneer screen). Pick your phone from the list, or tap the magnifying glass to add a new one.
- Bluetooth audio: pair through CarPlay's Connectivity menu the same way.
- LED cabin lighting has a button to change colors (currently broken; Moe will fix).
- Phone charging outlet next to driver-side captain chair is broken (Moe will fix).
- Want music or temperature changes? Use the Cabin controls in the app — Dio sees the request and adjusts.

If asked something you genuinely don't know about the van, say "Not sure on that — ask Mark or Dio." Never invent answers.`;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { messages?: Array<{ role: "user" | "assistant"; content: string }> }
    | null;
  if (!body?.messages || body.messages.length === 0) {
    return NextResponse.json({ error: "missing messages" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "missing API key" }, { status: 500 });

  const anthropic = new Anthropic({ apiKey });
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const block = resp.content[0];
    const text = block && block.type === "text" ? block.text : "Sorry, no answer available.";
    return NextResponse.json({ reply: text });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
