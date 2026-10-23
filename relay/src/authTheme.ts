export const AUTH_NAVY = "#0B1B3A";
export const AUTH_PANEL = "#0d1b29";
export const AUTH_CYAN = "#8ddff1";
export const AUTH_TEXT = "#ffffff";

export const CLERK_SIGN_IN_APPEARANCE = {
  variables: {
    colorBackground: AUTH_PANEL,
    colorPrimary: AUTH_CYAN,
    colorPrimaryForeground: AUTH_NAVY,
    colorText: AUTH_TEXT,
    colorForeground: AUTH_TEXT,
    colorInputBackground: AUTH_NAVY,
    colorInput: AUTH_NAVY,
    colorInputText: AUTH_TEXT,
    colorInputForeground: AUTH_TEXT,
    colorMuted: AUTH_NAVY,
    colorMutedForeground: "rgba(255,255,255,0.72)",
    colorNeutral: AUTH_TEXT,
  },
} as const;

export function clerkMountSignInOptions(): string {
  return `{ routing: "hash", forceRedirectUrl: window.location.href, signUpForceRedirectUrl: window.location.href, appearance: ${JSON.stringify(CLERK_SIGN_IN_APPEARANCE)} }`;
}

export function authPageStyles(): string {
  return `:root { color-scheme: dark; }
html, body { min-height: 100%; margin: 0; background: ${AUTH_NAVY}; color: ${AUTH_TEXT}; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; }
.card { width: min(100%, 420px); padding: 32px 28px 28px; border: 1px solid rgba(141, 223, 241, 0.28); border-radius: 20px; background: ${AUTH_PANEL}; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35); text-align: center; }
h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.03em; }
p, label, noscript { color: rgba(255, 255, 255, 0.78); }
#code { font-size: 1.75rem; letter-spacing: 0.2em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 16px 0; }
button { padding: 10px 14px; border: 0; border-radius: 10px; background: ${AUTH_CYAN}; color: ${AUTH_NAVY}; font-weight: 600; cursor: pointer; }
#clerk-sign-in { margin-top: 16px; text-align: left; }
#status { min-height: 1.4em; }`;
}

export function renderAuthPage(input: {
  readonly title: string;
  readonly heading: string;
  readonly intro: string;
  readonly body: string;
}): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${input.title}</title><style>${authPageStyles()}</style><body><main class="card"><h1>${input.heading}</h1><p>${input.intro}</p>${input.body}</main></body></html>`;
}
