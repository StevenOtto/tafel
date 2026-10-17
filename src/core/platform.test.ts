import { describe, expect, it } from "vitest";
import { platformFromUserAgent } from "./platform";

describe("platformFromUserAgent", () => {
  it("recognises WKWebView on macOS", () => {
    expect(
      platformFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      ),
    ).toBe("macos");
  });

  it("recognises WebView2 on Windows", () => {
    expect(
      platformFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe("windows");
  });

  it("recognises WebKitGTK on Linux", () => {
    expect(
      platformFromUserAgent(
        "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      ),
    ).toBe("linux");
  });
});
