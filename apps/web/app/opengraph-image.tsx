import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name}: ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
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
          background: "#0e1519",
          color: "#e8f0f0",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 40, color: "#2dd4bf" }}>
          <svg width="64" height="64" viewBox="0 0 32 32">
            <path d="M16 3 5 7v8c0 7 4.7 12.1 11 14 6.3-1.9 11-7 11-14V7L16 3Z" fill="none" stroke="#2dd4bf" strokeWidth="2" />
            <path d="m11 16 3.5 3.5L21 13" fill="none" stroke="#2dd4bf" strokeWidth="2.2" />
          </svg>
          {SITE.name}
        </div>
        <div style={{ marginTop: 40, fontSize: 72, fontWeight: 700, lineHeight: 1.1 }}>{SITE.tagline}</div>
        <div style={{ marginTop: 28, fontSize: 30, color: "#9fb3b5", lineHeight: 1.4 }}>{SITE.description}</div>
        <div style={{ marginTop: 40, fontSize: 24, color: "#f5c76b" }}>Aave loan protection on Base and Arbitrum</div>
      </div>
    ),
    size,
  );
}
