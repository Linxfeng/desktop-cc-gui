import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { PiFamilyOauthSection } from "./PiFamilyOauthSection";
import type { PiFamilyOauthProvider } from "./piFamilyAuthCatalog";

const provider: PiFamilyOauthProvider = {
  id: "openai-codex",
  name: "ChatGPT Plus / Pro (Codex)",
  iconSrc: null,
  loginArg: "openai-codex",
  statusIds: ["openai-codex"],
  descKey: "codex",
};

describe("PiFamilyOauthSection", () => {
  it("shows logout only when the subscription is authorized", () => {
    const props = {
      engine: "omp" as const,
      providers: [provider],
      onLaunchLogin: vi.fn(),
      onLaunchLogout: vi.fn(),
    };
    const unauthorized = renderToStaticMarkup(
      <PiFamilyOauthSection {...props} oauthActive={new Set()} />,
    );
    const authorized = renderToStaticMarkup(
      <PiFamilyOauthSection {...props} oauthActive={new Set(["openai-codex"])} />,
    );
    expect(unauthorized.match(/<button/g)).toHaveLength(1);
    expect(authorized.match(/<button/g)).toHaveLength(2);
  });

  it("keeps WSL subscribed rows on manual instructions without host terminal actions", () => {
    const html = renderToStaticMarkup(
      <PiFamilyOauthSection
        engine="pi"
        providers={[provider]}
        oauthActive={new Set(["openai-codex"])}
        onLaunchLogin={null}
        onLaunchLogout={null}
      />,
    );

    expect(html).not.toContain("<button");
    expect(html).toContain("pi /login openai-codex");
  });
});
