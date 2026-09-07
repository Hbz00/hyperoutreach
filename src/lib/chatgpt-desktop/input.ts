import type { CdpSession } from "@/lib/chatgpt-desktop/cdp";
import { ChatGptDesktopError } from "@/lib/chatgpt-desktop/errors";

const KEY_CODES: Record<string, number> = {
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowLeft: 37,
  Enter: 13,
  Escape: 27,
};

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Devtools input events are delivered straight to the renderer, so none of
 * this needs the window to be focused or even visible.
 */
export async function press(
  session: CdpSession,
  key: string,
  settleMs = 200,
): Promise<void> {
  const code = KEY_CODES[key];
  if (code === undefined) {
    throw new ChatGptDesktopError(`Unsupported key ${key}`, "evaluate");
  }
  for (const type of ["rawKeyDown", "keyUp"]) {
    await session.command("Input.dispatchKeyEvent", {
      type,
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
  }
  await wait(settleMs);
}

export async function typeText(
  session: CdpSession,
  text: string,
): Promise<void> {
  await session.command("Input.insertText", { text });
}

async function centerOf(
  session: CdpSession,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  return session.evaluate<{ x: number; y: number } | null>(
    `(() => {
       const element = document.querySelector(${JSON.stringify(selector)});
       if (!element || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"], [data-disabled]')) return null;
       // CDP uses viewport coordinates. A mounted sidebar item can be below
       // the viewport even though it has a nonzero layout box.
       element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
       const box = element.getBoundingClientRect();
       if (box.width <= 0 || box.height <= 0) return null;
       const x = box.left + box.width / 2;
       const y = box.top + box.height / 2;
       if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) return null;
       const hit = document.elementFromPoint(x, y);
       if (!hit || !element.contains(hit)) return null;
       return { x, y };
     })()`,
    10_000,
  );
}

/**
 * Radix menus only react to real pointer events, so synthetic `element.click()`
 * is not enough for the composer controls.
 */
export async function clickSelector(
  session: CdpSession,
  selector: string,
): Promise<boolean> {
  const point = await centerOf(session, selector);
  if (!point) return false;
  await session.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await session.command("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }
  return true;
}

export async function activeLabel(session: CdpSession): Promise<string> {
  return session.evaluate<string>(
    `(() => {
       const element = document.activeElement;
       if (!element) return "";
       return element.getAttribute("aria-label") || "";
     })()`,
    10_000,
  );
}
