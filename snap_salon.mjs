import { chromium } from "playwright";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("https://3000-ill643l5qkz5vsh4fjqrw-3824037d.us2.manus.computer/salon", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/salon.png", fullPage: false });
await browser.close();
console.log("OK");
