/**
 * Share-card renderer: a separate Worker, reached only through the main Worker's CARD service binding,
 * so its WebAssembly (Satori layout, resvg) and fonts never touch the search path.
 * POST {question, answer, host} -> 1200x630 PNG.
 */
import { ImageResponse } from "workers-og";
import interRegular from "../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff";
import interBold from "../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff";
import { LOGO_SVG } from "./icons.ts";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
/** Answer Markdown to plain text: no images, citations, links or formatting marks. */
const plain = (md: string) =>
  md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s*\[(\d+(?:,\s*\d+)*)\]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node =>
  ({ type, props: { style, children, ...extra } });

export default {
  async fetch(req: Request): Promise<Response> {
    try {
      return await render(req);
    } catch (e) {
      return new Response(`card render failed: ${(e as Error).stack ?? e}`, { status: 500 });
    }
  },
};

async function render(req: Request): Promise<Response> {
  {
    const { question, answer, host } = (await req.json()) as { question: string; answer: string; host: string };
    const q = clip(question.trim(), 120);
    const tree = el("div", {
      width: 1200, height: 630, display: "flex", flexDirection: "column", padding: "64px 72px",
      background: "linear-gradient(135deg, #ffffff 0%, #eef3ff 100%)", fontFamily: "Inter", color: "#111827",
    }, [
      el("div", { display: "flex", alignItems: "center", gap: 16 }, [
        el("img", { width: 56, height: 56 }, undefined, { src: `data:image/svg+xml;base64,${btoa(LOGO_SVG)}`, width: 56, height: 56 }),
        el("div", { fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }, "QuickAsk"),
      ]),
      el("div", { marginTop: 44, fontSize: q.length > 70 ? 48 : 60, fontWeight: 700, lineHeight: 1.15, letterSpacing: -1.5 }, q),
      el("div", { marginTop: 28, fontSize: 30, lineHeight: 1.4, color: "#4b5563" }, clip(plain(answer), q.length > 70 ? 150 : 210)),
      el("div", { marginTop: "auto", fontSize: 26, fontWeight: 700, color: "#2563eb" }, host),
    ]);
    return new ImageResponse(tree as never, {
      width: 1200, height: 630,
      fonts: [{ name: "Inter", data: interRegular, weight: 400, style: "normal" }, { name: "Inter", data: interBold, weight: 700, style: "normal" }],
    });
  }
}
