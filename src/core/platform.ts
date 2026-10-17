/**
 * The desktop platform the webview runs on. The control window's chrome
 * differs: macOS draws vibrancy behind a transparent page and puts traffic
 * lights over the toolbar; Linux and Windows have an opaque window with a
 * native title bar.
 */

export type Platform = "macos" | "windows" | "linux";

/** WKWebView, WebView2 and WebKitGTK each name their OS in the user agent. */
export const platformFromUserAgent = (userAgent: string): Platform => {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Macintosh")) return "macos";
  return "linux";
};
