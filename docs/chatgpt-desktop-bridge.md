# The ChatGPT desktop bridge

[← Back to the README](../README.md)

`src/lib/chatgpt-desktop` drives the ChatGPT macOS app's Chat surface from
Node, so a prompt can be answered by the ChatGPT subscription rather than a
billed API key. It is macOS-only, and with `AI_PROVIDER=chatgpt_desktop` it is
the surface every agent runs on — `src/lib/ai/production-provider-bundle`
builds both lanes on top of it. The commands below drive the same bridge by
hand, which is how a broken selector is diagnosed.

```bash
npm run chatgpt -- --models
npm run chatgpt -- --model "GPT-5.6 Sol" --effort High "your prompt"
echo "your prompt" | npm run chatgpt -- --json
npm run chatgpt:doctor
```

```ts
import { askChatGptDesktop } from "@/lib/chatgpt-desktop";

const { text } = await askChatGptDesktop({
  prompt: "…",
  model: "GPT-5.6 Sol",
  effort: "High",
});
```

Each call opens a new chat, switches Temporary chat on so the turn leaves no
history, selects the model, sends the prompt, waits for the answer to settle,
and restores the mode it found. Calls are serialised, because the Chat surface
is a single shared window.

### How it works, and what it does not do

The app is Electron, and it already accepts Chromium's devtools switch. The
bridge attaches to that port and drives the app's own surface with devtools
input events, which reach the renderer without the window being focused or
visible, so it runs quietly in the background.

Everything network-facing stays inside the app: the request, its authentication
and its integrity checks are performed by ChatGPT itself, exactly as when you
press send. The bridge never reconstructs that traffic. Two paths were explored
and rejected on purpose:

- Calling `chatgpt.com/backend-api/f/conversation` from the app's bundled
  webview returns `403 Unusual activity` without the sentinel proof-of-work
  tokens. Reproducing them would mean defeating an anti-abuse measure, so the
  bridge does not.
- The app shell renderer cannot reach the backend at all — its `app://` scheme
  is not CORS-enabled, and its traffic goes through the main process over
  private IPC.

### Requirements and failure modes

The app must be running with its devtools port open. The bridge launches it
hidden and unfocused when it is closed:

```bash
open -g -j -a /Applications/ChatGPT.app --args --remote-debugging-port=9333
```

macOS ignores `--args` for an app that is already running, so an app started
without the switch cannot be attached to; the bridge reports that rather than
guessing. Override the port with `--port` or `CHATGPT_DESKTOP_CDP_PORT`.

Because the bridge drives a real interface, a ChatGPT desktop update can rename
a hook or change how a control works. The supported hooks and selection logic
live in `chat-surface.ts`, and
`npm run chatgpt:doctor` checks them in order and names the first that no longer
holds.

The bridge supports the observed historical menu and the newer model list/Power
slider. It checks visible, usable controls and verifies each explicitly requested model
and effort. Hidden stale controls cannot certify these settings; ambiguity in a
requested setting is refused before submission. Pointer actions scroll their target into view and refuse inactive, covered or
unreachable controls. A text draft
left in the composer after New chat is also refused before the bridge types its
prompt. These checks protect against silent misconfiguration, but do not promise
compatibility with an arbitrary future layout or cover every form of attachment.

After an application update, run the doctor and a harmless temporary-chat request
using each configured lane before resuming outreach. The local Chromium/CDP cases
in `tests/integration/chatgpt-desktop-surface.test.ts` cover supported controls,
stale/hidden elements, ambiguity and refusal/recovery. Real-app probes remain
necessary to confirm a new application's actual layout; a passing DOM fixture
alone does not certify that release.

Two failures are deliberately loud rather than silent, because degrading
quietly would break a guarantee the caller asked for:

- If the temporary-chat control cannot be found, the turn is refused instead of
  sent. Sending anyway would persist a prompt the caller asked to keep
  ephemeral.
- If the answer does not finish within the timeout, the call throws instead of
  returning what had arrived, which would pass a truncated answer off as a
  complete one. The partial text is carried in the error's `detail`.
