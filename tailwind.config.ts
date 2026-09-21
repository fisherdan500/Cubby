import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: "hsl(var(--card))",
        "card-foreground": "hsl(var(--card-foreground))",
        surface: "hsl(var(--surface))",
        "surface-soft": "hsl(var(--surface-soft))",
        border: "hsl(var(--border))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        primary: "hsl(var(--primary))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        accent: "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        ring: "hsl(var(--ring))",
        danger: "hsl(var(--danger))",
        // The one warm spark: a timer that is running, and nothing else.
        live: "hsl(var(--live))"
      },
      borderRadius: {
        // One step up from Tailwind's defaults, applied in one place so the whole app stays
        // consistent rather than drifting between 8, 10 and 12.
        lg: "0.75rem",
        xl: "1rem"
      },
      boxShadow: {
        // Defined per mode in globals.css: light gets real shadows, dark gets a lit top edge,
        // because a dark shadow on a near-black canvas does nothing.
        soft: "var(--shadow-card)",
        lift: "var(--shadow-lift)"
      },
      fontFamily: {
        sans: ["Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
        editorial: ["Fraunces", "ui-serif", "Georgia", "serif"]
      }
    }
  },
  plugins: []
};

export default config;
