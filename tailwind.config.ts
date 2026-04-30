import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
        serif: ["var(--font-serif)", "Fraunces", "ui-serif", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        terminal: {
          bg: "#0c0a09",
          panel: "#1c1917",
          border: "#292524",
          dim: "#57534e",
          fg: "#e7e5e4",
          muted: "#a8a29e",
        },
        amber: {
          accent: "#f59e0b",
          dim: "#b45309",
        },
      },
      fontVariantNumeric: {
        "tabular-nums": "tabular-nums",
      },
    },
  },
  plugins: [],
};

export default config;
