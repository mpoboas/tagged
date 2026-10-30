module.exports = {
  content: ["../backend/tagged/web/index.html", "../backend/tagged/web/app.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ['"Geist Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      // text roles: base-content is primary, sub is secondary, mute is for meta and captions only
      colors: { sub: "#a1a1a6", mute: "#8c8c92" },
      transitionTimingFunction: { out: "cubic-bezier(0.22, 1, 0.36, 1)" },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [{
      tagged: {
        "color-scheme": "dark",
        primary: "#ededed", "primary-content": "#141415",
        secondary: "#232325", "secondary-content": "#ededed",
        accent: "#ededed", "accent-content": "#141415",
        neutral: "#232325", "neutral-content": "#ededed",
        "base-100": "#19191b", "base-200": "#141415", "base-300": "#232325", "base-content": "#ededed",
        info: "#8ab4e8", "info-content": "#0f0f10",
        success: "#4cc38a", "success-content": "#0f0f10",
        warning: "#e0a43a", "warning-content": "#0f0f10",
        error: "#e5484d", "error-content": "#0f0f10",
        "--rounded-box": "0.75rem", "--rounded-btn": "0.5rem", "--rounded-badge": "0.375rem",
        "--animation-btn": "0.15s", "--animation-input": "0.15s", "--btn-focus-scale": "0.98",
        "--border-btn": "1px", "--tab-border": "1px", "--tab-radius": "0.5rem",
      },
    }],
    logs: false,
  },
};
