import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name}: ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FONT_DIR = join(process.cwd(), "node_modules/geist/dist/fonts/geist-sans");

/** Geist, the site typeface. If the files cannot be read the image still renders in the default sans. */
async function loadGeist() {
  try {
    const [regular, semibold] = await Promise.all([readFile(join(FONT_DIR, "Geist-Regular.ttf")), readFile(join(FONT_DIR, "Geist-SemiBold.ttf"))]);
    return [
      { name: "Geist", data: regular, weight: 400 as const, style: "normal" as const },
      { name: "Geist", data: semibold, weight: 600 as const, style: "normal" as const },
    ];
  } catch {
    return [];
  }
}

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: "#0b0d12",
          color: "#eef1f6",
          fontFamily: "Geist, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>
          <svg width="56" height="56" viewBox="0 0 32 32" fill="none" stroke="#f5822a" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5.5 6.5 14.5 20 26.5 8" />
            <path d="M8 25.5h16" />
          </svg>
          backstop
        </div>
        <div style={{ marginTop: 44, fontSize: 76, fontWeight: 600, lineHeight: 1.04, letterSpacing: "-0.035em" }}>{SITE.tagline}</div>
        <div style={{ marginTop: 28, fontSize: 30, color: "#a3acba", lineHeight: 1.4 }}>{SITE.description}</div>
        <div style={{ marginTop: 40, fontSize: 24, color: "#f5822a" }}>Aave loan protection on Base and Arbitrum</div>
      </div>
    ),
    { ...size, fonts: await loadGeist() },
  );
}
