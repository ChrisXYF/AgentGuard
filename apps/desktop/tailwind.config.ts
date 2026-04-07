import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        app: "#edf1f5",
        panel: "#fafafa",
        card: "#ffffff",
        obsidian: "#08111b",
        steel: "#132334",
        pulse: "#fdba74",
        ember: "#fb7185",
        mint: "#34d399",
      },
      fontFamily: {
        display: ['"Inter"', "sans-serif"],
        body: ['"Inter"', "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(251,113,133,0.2), 0 24px 80px rgba(8,17,27,0.45)",
      },
      backgroundImage: {
        grid: "linear-gradient(rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.08) 1px, transparent 1px)",
      },
    },
  },
  plugins: [],
} satisfies Config;
