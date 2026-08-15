import type { CdpSession } from "@/lib/chatgpt-desktop/cdp";
import { ChatGptDesktopError } from "@/lib/chatgpt-desktop/errors";
import {
  activeLabel,
  clickSelector,
  press,
  typeText,
  wait,
} from "@/lib/chatgpt-desktop/input";

/**
 * Every hook the driver depends on, in one place: a ChatGPT desktop update
 * that renames one of these is a single-line fix, and `chatgpt:doctor`
 * reports which one broke.
 */
export const SELECTORS = {
  composer: '[role="textbox"][aria-label="Message ChatGPT"]',
  modelTrigger: '[aria-label="Select ChatGPT model"]',
  menu: "[data-radix-menu-content]",
  modelRow: '[role="menuitem"][aria-label^="Model "]',
  effortRow: '[role="menuitem"][aria-label^="Effort "]',
  assistantMessage: '[data-markdown-text-style="assistant-message"]',
  newChat: "New chat",
  temporaryOn: "Turn on temporary chat",
  temporaryOff: "Turn off temporary chat",
} as const;

const ADVANCED_COLLAPSED = "Show advanced options";
const ADVANCED_EXPANDED = "Show compact options";
const MENU_STEP_LIMIT = 12;

export type SurfaceState = {
  hasComposer: boolean;
  model: string | null;
  effort: string | null;
  temporary: boolean | null;
};

function labelExpression(label: string): string {
  return `(() => {
     const element = Array.from(document.querySelectorAll("button, [role=button], [role=menuitem], [aria-label]"))
       .find((candidate) => ((candidate.getAttribute("aria-label") || candidate.textContent || "").trim() === ${JSON.stringify(label)}));
     if (!element) return null;
     element.setAttribute("data-chatgpt-cli-target", "1");
     return true;
   })()`;
}

async function clickByLabel(
  session: CdpSession,
  label: string,
): Promise<boolean> {
  const tagged = await session.evaluate<boolean | null>(
    labelExpression(label),
    10_000,
  );
  if (!tagged) return false;
  const clicked = await clickSelector(session, '[data-chatgpt-cli-target="1"]');
  await session.evaluate<null>(
    `(() => {
       const element = document.querySelector('[data-chatgpt-cli-target="1"]');
       if (element) element.removeAttribute("data-chatgpt-cli-target");
       return null;
     })()`,
    10_000,
  );
  return clicked;
}

export async function readSurface(session: CdpSession): Promise<SurfaceState> {
  return session.evaluate<SurfaceState>(
    `(() => {
       const trigger = document.querySelector(${JSON.stringify(SELECTORS.modelTrigger)});
       const modelRow = document.querySelector(${JSON.stringify(SELECTORS.modelRow)});
       const effortRow = document.querySelector(${JSON.stringify(SELECTORS.effortRow)});
       const labels = Array.from(document.querySelectorAll("[aria-label]"))
         .map((element) => (element.getAttribute("aria-label") || "").trim());
       const temporary = labels.includes(${JSON.stringify(SELECTORS.temporaryOff)})
         ? true
         : labels.includes(${JSON.stringify(SELECTORS.temporaryOn)})
           ? false
           : null;
       const strip = (value, prefix) => (value ? value.slice(prefix.length).trim() : null);
       return {
         hasComposer: document.querySelector(${JSON.stringify(SELECTORS.composer)}) !== null,
         model: strip(modelRow && modelRow.getAttribute("aria-label"), "Model"),
         effort: strip(effortRow && effortRow.getAttribute("aria-label"), "Effort")
           || (trigger && trigger.getAttribute("data-selected-reasoning-effort")),
         temporary,
       };
     })()`,
    15_000,
  );
}

async function focusedItemText(session: CdpSession): Promise<string> {
  return session.evaluate<string>(
    `(() => {
       const element = document.activeElement;
       if (!element) return "";
       return (element.textContent || "").trim().replace(/\\s+/g, " ");
     })()`,
    10_000,
  );
}

async function openPicker(session: CdpSession): Promise<void> {
  if (!(await clickSelector(session, SELECTORS.modelTrigger))) {
    throw new ChatGptDesktopError(
      "ChatGPT desktop model picker was not found",
      "evaluate",
      SELECTORS.modelTrigger,
    );
  }
  await wait(700);
  for (let step = 0; step < MENU_STEP_LIMIT; step += 1) {
    const label = await activeLabel(session);
    if (label === ADVANCED_EXPANDED) return;
    if (label === ADVANCED_COLLAPSED) {
      await press(session, "Enter", 600);
      return;
    }
    await press(session, "ArrowDown");
  }
  throw new ChatGptDesktopError(
    "ChatGPT desktop advanced options row was not reachable",
    "evaluate",
  );
}

async function closePicker(session: CdpSession): Promise<void> {
  await press(session, "Escape", 250);
  await press(session, "Escape", 250);
}

async function openRowSubmenu(
  session: CdpSession,
  prefix: "Model" | "Effort",
): Promise<void> {
  for (let step = 0; step < MENU_STEP_LIMIT; step += 1) {
    if ((await activeLabel(session)).startsWith(`${prefix} `)) {
      await press(session, "ArrowRight", 700);
      return;
    }
    await press(session, "ArrowDown");
  }
  throw new ChatGptDesktopError(
    `ChatGPT desktop ${prefix.toLowerCase()} row was not reachable`,
    "evaluate",
  );
}

async function readSubmenuOptions(session: CdpSession): Promise<string[]> {
  return session.evaluate<string[]>(
    `(() => {
       const menus = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.menu)}));
       const submenu = menus[menus.length - 1];
       if (!submenu || menus.length < 2) return [];
       return Array.from(submenu.querySelectorAll("[role=menuitem], [role=menuitemradio]"))
         .map((item) => (item.textContent || "").trim().replace(/\\s+/g, " "))
         .filter((text) => text.length > 0);
     })()`,
    15_000,
  );
}

async function chooseSubmenuOption(
  session: CdpSession,
  wanted: string,
): Promise<void> {
  const options = await readSubmenuOptions(session);
  const match = options.find(
    (option) => option.toLowerCase() === wanted.toLowerCase(),
  );
  if (!match) {
    throw new ChatGptDesktopError(
      `ChatGPT desktop does not offer "${wanted}"`,
      "evaluate",
      `available: ${options.join(", ")}`,
    );
  }
  for (let step = 0; step < MENU_STEP_LIMIT; step += 1) {
    if ((await focusedItemText(session)) === match) {
      await press(session, "Enter", 700);
      return;
    }
    await press(session, "ArrowDown");
  }
  throw new ChatGptDesktopError(
    `ChatGPT desktop option "${wanted}" was not reachable`,
    "evaluate",
  );
}

async function listRowOptions(
  session: CdpSession,
  prefix: "Model" | "Effort",
): Promise<string[]> {
  await openPicker(session);
  try {
    await openRowSubmenu(session, prefix);
    return await readSubmenuOptions(session);
  } finally {
    await closePicker(session);
  }
}

export function listModels(session: CdpSession): Promise<string[]> {
  return listRowOptions(session, "Model");
}

export function listEfforts(session: CdpSession): Promise<string[]> {
  return listRowOptions(session, "Effort");
}

/**
 * The Model row only exists while the picker is open, so reading the active
 * model costs one open/close cycle.
 */
export async function readSelectedModel(
  session: CdpSession,
): Promise<string | null> {
  await openPicker(session);
  try {
    return await session.evaluate<string | null>(
      `(() => {
         const row = document.querySelector(${JSON.stringify(SELECTORS.modelRow)});
         const label = row && row.getAttribute("aria-label");
         return label ? label.slice("Model".length).trim() : null;
       })()`,
      15_000,
    );
  } finally {
    await closePicker(session);
  }
}

async function readRowValue(
  session: CdpSession,
  prefix: "Model" | "Effort",
): Promise<string | null> {
  const selector =
    prefix === "Model" ? SELECTORS.modelRow : SELECTORS.effortRow;
  return session.evaluate<string | null>(
    `(() => {
       const row = document.querySelector(${JSON.stringify(selector)});
       const label = row && row.getAttribute("aria-label");
       return label ? label.slice(${prefix.length}).trim() : null;
     })()`,
    15_000,
  );
}

async function selectRowOption(
  session: CdpSession,
  prefix: "Model" | "Effort",
  wanted: string,
): Promise<void> {
  await openPicker(session);
  try {
    const current = await readRowValue(session, prefix);
    // Walking the submenu costs a second of animation waits; skip it when the
    // app is already on the requested value.
    if (current?.toLowerCase() === wanted.toLowerCase()) return;
    await openRowSubmenu(session, prefix);
    await chooseSubmenuOption(session, wanted);
  } finally {
    await closePicker(session);
  }
}

export function selectModel(session: CdpSession, model: string): Promise<void> {
  return selectRowOption(session, "Model", model);
}

export function selectEffort(
  session: CdpSession,
  effort: string,
): Promise<void> {
  return selectRowOption(session, "Effort", effort);
}

export async function startNewChat(session: CdpSession): Promise<boolean> {
  const clicked = await clickByLabel(session, SELECTORS.newChat);
  if (clicked) await wait(900);
  return clicked;
}

/**
 * `unavailable` means the toggle was not on the surface, so the mode could be
 * neither read nor set. Callers must not treat that as success: silently
 * leaving temporary chat off would persist a turn the caller asked to keep
 * ephemeral.
 */
export type TemporaryOutcome = "already" | "toggled" | "unavailable";

export async function setTemporary(
  session: CdpSession,
  enabled: boolean,
): Promise<TemporaryOutcome> {
  const state = await readSurface(session);
  if (state.temporary === null) return "unavailable";
  if (state.temporary === enabled) return "already";
  const clicked = await clickByLabel(
    session,
    enabled ? SELECTORS.temporaryOn : SELECTORS.temporaryOff,
  );
  if (!clicked) return "unavailable";
  await wait(700);
  return "toggled";
}

export async function countAssistantMessages(
  session: CdpSession,
): Promise<number> {
  return session.evaluate<number>(
    `document.querySelectorAll(${JSON.stringify(SELECTORS.assistantMessage)}).length`,
    10_000,
  );
}

export async function submitPrompt(
  session: CdpSession,
  prompt: string,
): Promise<void> {
  const focused = await session.evaluate<boolean>(
    `(() => {
       const composer = document.querySelector(${JSON.stringify(SELECTORS.composer)});
       if (!composer) return false;
       composer.focus();
       return document.activeElement === composer;
     })()`,
    10_000,
  );
  if (!focused) {
    throw new ChatGptDesktopError(
      "ChatGPT desktop composer could not be focused",
      "evaluate",
      SELECTORS.composer,
    );
  }
  await typeText(session, prompt);
  await wait(350);
  await press(session, "Enter", 300);
}

export type AnswerOptions = {
  timeoutMs: number;
  /** How long the answer text must stay unchanged before it counts as final. */
  quietMs?: number;
  baselineCount: number;
};

/**
 * Reads the answer from the document tree rather than from the rendering.
 *
 * `innerText` reports text as laid out, so it inserts a line break wherever
 * the layout puts one — around a linkified URL, for instance, which lands a
 * newline inside a JSON string and makes the answer unparsable. `textContent`
 * has the opposite flaw: it ignores `<br>` and block boundaries, running
 * separate lines and paragraphs together.
 *
 * Walking the tree takes the text from the nodes themselves and the line
 * breaks from the markup: `<br>` and block elements break, inline elements
 * never do, and `<pre>` is copied verbatim so code keeps its own whitespace.
 */
export const EXTRACT_ANSWER = `(root) => {
  const BLOCK = new Set(["ADDRESS","ARTICLE","ASIDE","BLOCKQUOTE","DD","DETAILS","DIV","DL","DT","FIELDSET","FIGCAPTION","FIGURE","FOOTER","FORM","H1","H2","H3","H4","H5","H6","HEADER","HR","LI","MAIN","NAV","OL","P","SECTION","TABLE","TR","UL"]);
  const SENTINEL = String.fromCharCode(57344);
  const verbatim = [];
  const parts = [];
  const visit = (node, isRoot) => {
    if (node.nodeType === 3) {
      parts.push((node.nodeValue || "").replace(/\\s+/g, " "));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === "PRE") {
      verbatim.push(node.textContent || "");
      parts.push("\\n" + SENTINEL + (verbatim.length - 1) + SENTINEL + "\\n");
      return;
    }
    if (tag === "BR") {
      parts.push("\\n");
      return;
    }
    // A wrapper holding a code block also holds that block's chrome — the
    // language label, the copy button — which is not part of the answer.
    const elements = Array.prototype.slice.call(node.children || []);
    const code = isRoot
      ? []
      : elements.filter((child) => child.tagName === "PRE");
    const children =
      code.length > 0 ? code : Array.prototype.slice.call(node.childNodes || []);
    const isBlock = BLOCK.has(tag);
    if (isBlock) parts.push("\\n");
    children.forEach((child) => visit(child, false));
    if (isBlock) parts.push("\\n");
  };
  visit(root, true);
  const text = parts
    .join("")
    .split("\\n")
    .map((line) => line.trim())
    .join("\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
  return text.replace(
    new RegExp(SENTINEL + "([0-9]+)" + SENTINEL, "g"),
    (match, index) => verbatim[Number(index)],
  );
}`;

export async function awaitAnswer(
  session: CdpSession,
  options: AnswerOptions,
): Promise<string> {
  const quietMs = options.quietMs ?? 1_800;
  const deadline = Date.now() + options.timeoutMs;
  let lastText = "";
  let stableSince: number | null = null;
  // The stop control is the only positive signal that generation is still
  // running, and it is found by an English aria-label. If that ever stops
  // matching — a renamed control, a localised interface — the loop would be
  // left with "the text has not changed for a moment", which a pause in
  // streaming also satisfies: a truncated answer would pass as a complete one.
  // Never having seen the control is therefore treated as a reason to be more
  // patient, not as evidence that nothing is generating.
  let sawGenerating = false;

  while (Date.now() < deadline) {
    const snapshot = await session.evaluate<{
      count: number;
      text: string;
      generating: boolean;
    }>(
      `(() => {
         const extract = ${EXTRACT_ANSWER};
         const nodes = document.querySelectorAll(${JSON.stringify(SELECTORS.assistantMessage)});
         const last = nodes[nodes.length - 1];
         const generating = Array.from(document.querySelectorAll("button, [role=button]"))
           .some((element) => /stop/i.test(element.getAttribute("aria-label") || ""));
         return {
           count: nodes.length,
           text: last ? extract(last) : "",
           generating,
         };
       })()`,
      15_000,
    );

    if (snapshot.generating) sawGenerating = true;
    if (snapshot.count > options.baselineCount && snapshot.text.length > 0) {
      if (snapshot.text === lastText && !snapshot.generating) {
        stableSince ??= Date.now();
        const requiredQuietMs = sawGenerating ? quietMs : quietMs * 4;
        if (Date.now() - stableSince >= requiredQuietMs) return snapshot.text;
      } else {
        stableSince = null;
      }
      lastText = snapshot.text;
    }
    await wait(400);
  }

  // Returning what arrived so far would pass a truncated answer off as a
  // complete one; the partial goes in the detail instead, so nothing is lost.
  throw new ChatGptDesktopError(
    "ChatGPT desktop did not finish the answer in time",
    "timeout",
    lastText.length > 0
      ? `partial answer (${lastText.length} chars): ${lastText.slice(0, 500)}`
      : "no answer started",
  );
}
