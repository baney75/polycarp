# Why the extension asks for each permission

Paste each reason into the Chrome Web Store dashboard's Privacy tab. `test/store-package.test.mjs` fails when the manifest asks for something with no row here.

| Permission | Why it's needed |
| --- | --- |
| `storage` | Saves settings, site permissions and tab state in the browser. |
| `unlimitedStorage` | Chats, skills and on-device speech models are kept locally and can pass the default quota. Nothing goes to a server of ours. |
| `activeTab` | Takes a screenshot of the tab the agent works in (`chrome.tabs.captureVisibleTab`), which needs this permission. Screenshots are how the agent checks its work on canvas apps and other pages with no readable text. |
| `scripting` | Reads a page and records what happens on it, so the agent can see the result of each step. |
| `sidePanel` | The chat interface lives in the side panel. |
| `webNavigation` | Keeps track of the agent's tabs when the browser replaces one, and notices when a page navigates, so the agent's tools act on the right page. |
| `debugger` | The agent's clicks, typing and page reads go through the Chrome DevTools Protocol. This is the only way to send real input to a background tab, and to read pages whose security policy blocks injected scripts. It attaches only to tabs the agent opened or the user gave it. |
| `declarativeNetRequest` | Adds CORS headers to responses from the AI provider APIs in `cors-rules.json` (Anthropic and Z.ai), so the side panel can call them directly with the user's own key instead of going through a proxy. No other site's traffic is changed. |
| `tabGroups` | Puts the agent's tabs in their own named group, so they stay separate from the user's tabs. |
| `nativeMessaging` | Connects to the Polycarp helper on the user's computer, which is how coding agents such as Claude Code reach the extension. It's optional for the user, and side panel chat works without it. |
| `alarms` | Keeps the connection to the helper alive across service worker restarts. |
| `offscreen` | Reads the text of a PDF the agent opens, page by page, in a hidden page of the extension. Chrome's PDF viewer has no page text, and the reader (pdf.js) needs a worker a service worker can't start. Nothing leaves the browser. |
| `userScripts` (optional) | Asked for only when the user turns it on. Runs the agent's page scripts in an isolated world, so they can't touch the page's own scripts and aren't blocked by its security policy. |
| `http://*/*` | The agent works on whatever site the user sends it to, so it can't name them ahead of time. Each new site still needs approval before the agent can open it, in the side panel or with `polycarp browser allow`, a command on the user's own computer. |
| `https://*/*` | Same as above. |
| `http://localhost/*` | Local development servers, and AI models running on the user's own computer. |
| `http://127.0.0.1/*` | Same as above. |
