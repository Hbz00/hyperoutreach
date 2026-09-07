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
  temporaryIdle: "Temporary chat",
  powerPicker: "[data-model-picker-view]",
  powerControl: '[data-reasoning-slider="true"]',
  powerModelToggle: '[data-model-picker-view-toggle="true"]',
} as const;

const ADVANCED_COLLAPSED = "Show advanced options";
const ADVANCED_EXPANDED = "Show compact options";
const MENU_STEP_LIMIT = 12;

// Updates can leave an older panel mounted during a transition. Its labels
// cannot establish the state of the controls the user can currently operate.
const VISIBLE_CONTROLS = `
  const visible = (element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const visibleMatches = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const uniqueVisible = (selector) => {
    const matches = visibleMatches(selector);
    return matches.length === 1 ? matches[0] : null;
  };
`;

export type SurfaceState = {
  hasComposer: boolean;
  model: string | null;
  effort: string | null;
  temporary: boolean | null;
};

function labelExpression(label: string, textOnly = false): string {
  return `(() => {
     ${VISIBLE_CONTROLS}
     document.querySelectorAll('[data-chatgpt-cli-target]').forEach(element => element.removeAttribute('data-chatgpt-cli-target'));
     const candidates = visibleMatches("button, [role=button], [role=menuitem], [aria-label]")
       .filter((candidate) => !candidate.matches(':disabled, [aria-disabled="true"], [data-disabled]'));
     // The current sidebar offers both a text-only New chat button and an
     // explicitly labelled icon. Prefer the explicit control; text is only
     // a fallback, and duplicate explicit labels must still be refused.
     const explicit = candidates.filter(candidate => (candidate.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
     if (explicit.length > 1) return null;
     const usingExplicit = !${textOnly} && explicit.length > 0;
     const matches = usingExplicit ? explicit : candidates.filter(candidate => !candidate.getAttribute('aria-label') && (candidate.textContent || '').trim() === ${JSON.stringify(label)});
     if (matches.length !== 1) return null;
     const element = matches[0];
     element.setAttribute("data-chatgpt-cli-target", "1");
     return usingExplicit ? "explicit" : "text";
   })()`;
}

async function clickByLabel(
  session: CdpSession,
  label: string,
  textOnly = false,
): Promise<boolean> {
  const tagged = await session.evaluate<"explicit" | "text" | null>(
    labelExpression(label, textOnly),
    10_000,
  );
  if (!tagged) return false;
  let clicked: boolean;
  try {
    clicked = await clickSelector(session, '[data-chatgpt-cli-target="1"]');
  } finally {
    await session.evaluate<null>(
      `(() => {
         document.querySelectorAll('[data-chatgpt-cli-target]').forEach(element => element.removeAttribute('data-chatgpt-cli-target'));
         return null;
       })()`,
      10_000,
    );
  }
  // A covered sidebar icon is not actionable even after scrolling. Only
  // New chat has the observed equivalent text button. A false click result
  // means no mouse input was sent, so trying that unique alternative is safe.
  if (!clicked && tagged === "explicit" && label === SELECTORS.newChat) {
    return clickByLabel(session, label, true);
  }
  return clicked;
}

export async function readSurface(session: CdpSession): Promise<SurfaceState> {
  return session.evaluate<SurfaceState>(
    `(() => {
       ${VISIBLE_CONTROLS}
       const trigger = uniqueVisible(${JSON.stringify(SELECTORS.modelTrigger)});
       const modelRow = uniqueVisible(${JSON.stringify(SELECTORS.modelRow)});
       const effortRows = visibleMatches(${JSON.stringify(SELECTORS.effortRow)});
       const effortRow = effortRows.length === 1 ? effortRows[0] : null;
       const labels = visibleMatches("button[aria-label], [role=button][aria-label]")
         .map((element) => (element.getAttribute("aria-label") || "").trim());
       const temporaryLabels = labels.filter(label => ${JSON.stringify([SELECTORS.temporaryOff, SELECTORS.temporaryOn, SELECTORS.temporaryIdle])}.includes(label));
       const temporary = temporaryLabels.length === 1 ? temporaryLabels[0] === ${JSON.stringify(SELECTORS.temporaryOff)} : null;
       const strip = (value, prefix) => (value ? value.slice(prefix.length).trim() : null);
       // The power picker uses "medium" internally for both Medium and Pro.
       // Read its displayed label rather than treating that value as proof.
       const display = trigger?.querySelector('[data-tooltip-overflow-target]')?.cloneNode(true);
       display?.querySelectorAll('[aria-hidden="true"]').forEach(e => e.remove());
       const displayedEffort = display?.textContent?.trim()
         .match(/^(?:\\d+(?:\\.\\d+)*\\s+)?(Extra High|Instant|Medium|High|Pro)$/)?.[1];
       const usesPowerLabel = trigger?.hasAttribute('data-codex-intelligence-trigger') || display !== undefined;
       return {
         hasComposer: document.querySelector(${JSON.stringify(SELECTORS.composer)}) !== null,
         model: strip(modelRow && modelRow.getAttribute("aria-label"), "Model"),
         effort: effortRows.length > 1 ? null : strip(effortRow && effortRow.getAttribute("aria-label"), "Effort")
           || (usesPowerLabel ? displayedEffort || null : trigger && trigger.getAttribute("data-selected-reasoning-effort")),
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
  if (await hasPowerPicker(session)) return;
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

async function hasPowerPicker(session: CdpSession): Promise<boolean> {
  return session.evaluate<boolean>(
    `(() => { ${VISIBLE_CONTROLS} return uniqueVisible(${JSON.stringify(SELECTORS.powerPicker)}) !== null; })()`,
    10_000,
  );
}

async function readPowerModel(session: CdpSession): Promise<string | null> {
  return session.evaluate<string | null>(
    `(() => {
      ${VISIBLE_CONTROLS}
      const picker = uniqueVisible('${SELECTORS.powerPicker}');
      // The current picker keeps its model list in an inert panel while its
      // Power view is shown. Read that list only within the active picker,
      // and require one selected row instead of trusting the first match.
      const selected = picker?.querySelectorAll('[role="menuitemradio"][data-model-selected="true"]');
      const checked = picker?.querySelectorAll('[role="menuitemradio"][aria-checked="true"]');
      return selected?.length === 1 && checked?.length === 1 && selected[0] === checked[0]
        ? selected[0].textContent?.trim() || null : null;
    })()`,
    10_000,
  );
}

async function powerModels(
  session: CdpSession,
  wanted?: string,
): Promise<string[]> {
  const simple = await session.evaluate<boolean>(
    `(() => { ${VISIBLE_CONTROLS} return uniqueVisible('${SELECTORS.powerPicker}')?.getAttribute('data-model-picker-view') === 'simple'; })()`,
    10_000,
  );
  if (simple) {
    if (!(await clickSelector(session, SELECTORS.powerModelToggle))) {
      throw new ChatGptDesktopError(
        "ChatGPT desktop model list was not reachable",
        "evaluate",
      );
    }
    await wait(700);
  }
  const options = await session.evaluate<string[]>(
    `(() => {
      ${VISIBLE_CONTROLS}
      const picker = uniqueVisible('${SELECTORS.powerPicker}');
      return Array.from(picker?.querySelectorAll('[role="menuitemradio"]') || [])
        .filter(e => visible(e) && !e.hasAttribute('data-disabled') && e.getAttribute('aria-disabled') !== 'true')
        .map(e => e.textContent.trim()).filter(Boolean);
    })()`,
    10_000,
  );
  if (wanted !== undefined) {
    const matches = options.filter(
      (option) => option.toLowerCase() === wanted.toLowerCase(),
    );
    if (matches.length > 1)
      throw new ChatGptDesktopError(
        `ChatGPT desktop model option "${wanted}" is ambiguous`,
        "evaluate",
      );
    const match = matches[0];
    if (!match)
      throw new ChatGptDesktopError(
        `ChatGPT desktop does not offer "${wanted}"`,
        "evaluate",
        `available: ${options.join(", ")}`,
      );
    await session.evaluate(
      `(() => {
        ${VISIBLE_CONTROLS}
        const picker = uniqueVisible('${SELECTORS.powerPicker}');
        const e = Array.from(picker?.querySelectorAll('[role="menuitemradio"]') || [])
          .find(e => visible(e) && !e.hasAttribute('data-disabled') && e.getAttribute('aria-disabled') !== 'true' && e.textContent.trim() === ${JSON.stringify(match)});
        e?.setAttribute('data-chatgpt-cli-model', '1');})()`,
      10_000,
    );
    try {
      if (!(await clickSelector(session, '[data-chatgpt-cli-model="1"]'))) {
        throw new ChatGptDesktopError(
          "ChatGPT desktop model option was not reachable",
          "evaluate",
        );
      }
      await wait(700);
    } finally {
      await session.evaluate(
        `document.querySelector('[data-chatgpt-cli-model="1"]')?.removeAttribute('data-chatgpt-cli-model')`,
        10_000,
      );
    }
  }
  return options;
}

async function readPower(
  session: CdpSession,
): Promise<{ value: number; max: number; label: string }> {
  const state = await session.evaluate<{
    value: number;
    max: number;
    label: string;
  } | null>(
    `(() => {
      const control = document.querySelector('${SELECTORS.powerControl}');
      const slider = control?.querySelector('[role="slider"]');
      if (!control || control.closest('[inert], [aria-hidden="true"]') || control.getAttribute('aria-disabled') === 'true' || !slider) return null;
      const status = (control.getAttribute('aria-describedby') || '').split(/\\s+/).map(id => document.getElementById(id)).find(e => e?.getAttribute('role') === 'status');
      const match = status?.textContent?.trim().match(/^(.+), (\\d+) of (\\d+)\\.$/);
      const value = Number(slider.getAttribute('aria-valuenow'));
      const max = Number(slider.getAttribute('aria-valuemax'));
      if (!match || slider.getAttribute('aria-valuemin') !== '0' || !Number.isInteger(value) || !Number.isInteger(max) || max < 0 || max >= ${MENU_STEP_LIMIT} || value < 0 || value > max || Number(match[2]) !== value + 1 || Number(match[3]) !== max + 1) return null;
      return {value, max, label: match[1]};
    })()`,
    10_000,
  );
  if (!state)
    throw new ChatGptDesktopError(
      "ChatGPT desktop effort slider could not be verified",
      "evaluate",
    );
  return state;
}

async function movePower(session: CdpSession, target: number): Promise<void> {
  for (let step = 0; step < MENU_STEP_LIMIT; step += 1) {
    const current = await readPower(session);
    if (current.value === target) return;
    const focused = await session.evaluate<boolean>(
      `(() => {const e = document.querySelector('${SELECTORS.powerControl}'); e?.focus(); return e !== null && document.activeElement === e;})()`,
      10_000,
    );
    if (!focused) break;
    await press(
      session,
      current.value < target ? "ArrowRight" : "ArrowLeft",
      300,
    );
  }
  throw new ChatGptDesktopError(
    "ChatGPT desktop effort slider did not reach the requested stop",
    "evaluate",
  );
}

async function powerEfforts(
  session: CdpSession,
  wanted?: string,
): Promise<string[]> {
  const original = await readPower(session);
  const options: string[] = [];
  let selected = false;
  try {
    for (let value = 0; value <= original.max; value += 1) {
      await movePower(session, value);
      const current = await readPower(session);
      options.push(current.label);
      if (
        wanted !== undefined &&
        current.label.toLowerCase() === wanted.toLowerCase()
      ) {
        selected = true;
        return options;
      }
    }
    if (wanted !== undefined)
      throw new ChatGptDesktopError(
        `ChatGPT desktop does not offer "${wanted}"`,
        "evaluate",
        `available: ${options.join(", ")}`,
      );
    return options;
  } finally {
    if (!selected) {
      await movePower(session, original.value);
      if ((await readPower(session)).label !== original.label) {
        throw new ChatGptDesktopError(
          "ChatGPT desktop effort could not be restored",
          "evaluate",
        );
      }
    }
  }
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
  try {
    await openPicker(session);
    if (await hasPowerPicker(session)) {
      return prefix === "Model"
        ? await powerModels(session)
        : await powerEfforts(session);
    }
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
  try {
    await openPicker(session);
    if (await hasPowerPicker(session)) return await readPowerModel(session);
    return await session.evaluate<string | null>(
      `(() => {
         ${VISIBLE_CONTROLS}
         const row = uniqueVisible(${JSON.stringify(SELECTORS.modelRow)});
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
       ${VISIBLE_CONTROLS}
       const row = uniqueVisible(${JSON.stringify(selector)});
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
  try {
    await openPicker(session);
    if (await hasPowerPicker(session)) {
      if (prefix === "Model") await powerModels(session, wanted);
      else await powerEfforts(session, wanted);
      return;
    }
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
  let clicked = await clickByLabel(
    session,
    enabled ? SELECTORS.temporaryOn : SELECTORS.temporaryOff,
  );
  if (!clicked && enabled)
    clicked = await clickByLabel(session, SELECTORS.temporaryIdle);
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
  const focused = await session.evaluate<boolean | "not_empty">(
    `(() => {
       const composer = document.querySelector(${JSON.stringify(SELECTORS.composer)});
       if (!composer) return false;
       if ((composer.textContent || "").trim() !== "") return "not_empty";
       composer.focus();
       return document.activeElement === composer;
     })()`,
    10_000,
  );
  if (focused === "not_empty") {
    throw new ChatGptDesktopError(
      "ChatGPT desktop composer is not empty",
      "evaluate",
      "the new-chat action left an existing draft; refusing to append the prompt",
    );
  }
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
