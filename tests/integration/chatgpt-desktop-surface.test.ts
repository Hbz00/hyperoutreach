import { chromium, type Browser, type Page } from "@playwright/test";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { askChatGptDesktop } from "@/lib/chatgpt-desktop/client";
import * as desktopApp from "@/lib/chatgpt-desktop/desktop-app";
import { clickSelector } from "@/lib/chatgpt-desktop/input";
import { CdpSession, type CdpResponse } from "@/lib/chatgpt-desktop/cdp";
import {
  listEfforts,
  listModels,
  readSelectedModel,
  readSurface,
  selectEffort,
  selectModel,
  setTemporary,
  startNewChat,
} from "@/lib/chatgpt-desktop/chat-surface";

// Public control attributes observed on the 2026-09-06 desktop surface. The
// hidden model panel remains mounted, as it does in the real Radix picker.
// Exercise production DOM queries and trusted CDP input, with no desktop app,
// model request, database or network navigation.
const fixture = `<!doctype html><style>
button,[role=menuitem],[role=menuitemradio]{display:block;padding:10px;width:240px}
[inert]{visibility:hidden;height:0;overflow:hidden} [hidden]{display:none}
</style>
<button aria-label="Temporary chat"></button>
<div role="textbox" aria-label="Message ChatGPT" contenteditable></div>
<button aria-label="Select ChatGPT model" aria-expanded="false" data-codex-intelligence-trigger="true" data-selected-reasoning-effort="none"><span data-tooltip-overflow-target><span aria-hidden="true">Thinking effort</span><span>Instant</span></span></button>
<div id="mount"></div>
<script>
const models=['Latest','GPT-5.6 Sol','GPT-5.5'];
const efforts=['Instant','Medium','High','Extra High','Pro'];
let model='Latest',power=0,view='simple';
const trigger=document.querySelector('[aria-label="Select ChatGPT model"]');
const temporary=document.querySelector('[aria-label="Temporary chat"]');
temporary.onclick=()=>temporary.setAttribute('aria-label',temporary.getAttribute('aria-label')==='Temporary chat'?'Turn off temporary chat':'Temporary chat');
function render(){
 trigger.setAttribute('data-selected-reasoning-effort',['none','medium','high','max','medium'][power]);
 trigger.firstElementChild.lastElementChild.textContent=(model==='Latest'?'':'5.6 ')+efforts[power];
 mount.innerHTML='<div data-radix-menu-content role="menu"><div data-model-picker-view="'+view+'">'+
 '<div '+(view==='simple'?'':'inert aria-hidden="true"')+'><div role="menuitem" tabindex="0" aria-label="Select model" data-model-picker-view-toggle="true">Select model</div>'+
 '<span id="power-status" role="status">'+efforts[power]+', '+(power+1)+' of 5.</span>'+
 '<div role="menuitem" tabindex="-1" aria-label="Power" data-reasoning-slider="true" aria-describedby="power-status"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="'+power+'"></span></div></div>'+
 '<div '+(view==='advanced'?'':'inert aria-hidden="true"')+'>'+models.map(m=>'<div role="menuitemradio" tabindex="-1" aria-checked="'+(m===model)+'" '+(m===model?'data-model-selected="true"':'')+'>'+m+'</div>').join('')+'</div></div></div>';
 document.querySelector('[data-model-picker-view-toggle]').onclick=()=>{view='advanced';render()};
 document.querySelectorAll('[role=menuitemradio]').forEach(e=>e.onclick=()=>{model=e.textContent;view='simple';render()});
 const slider=document.querySelector('[data-reasoning-slider]');
 slider.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){power=Math.max(0,Math.min(4,power+(e.key==='ArrowRight'?1:-1)));render();document.querySelector('[data-reasoning-slider]').focus();}};
}
trigger.onclick=()=>{trigger.setAttribute('aria-expanded','true');view='simple';render()};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){mount.innerHTML='';trigger.setAttribute('aria-expanded','false');}});
</script>`;

let browser: Browser;
let page: Page;
let session: CdpSession;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=33105",
    ],
  });
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(fixture);
  const cdp = await page.context().newCDPSession(page);
  session = {
    command: async (method: string, params: Record<string, unknown>) =>
      ({
        result: await cdp.send(
          method as Parameters<typeof cdp.send>[0],
          params,
        ),
      }) as CdpResponse,
    evaluate: CdpSession.prototype.evaluate,
  } as CdpSession;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await page.close();
});
afterAll(async () => {
  await browser?.close();
});

describe("current desktop controls", () => {
  it("refuses a disabled pointer target", async () => {
    await page.evaluate(() => {
      const target = document.createElement("button");
      target.id = "disabled-target";
      target.disabled = true;
      document.body.append(target);
    });
    expect(await clickSelector(session, "#disabled-target")).toBe(false);
  });
  it("refuses a pointer target covered by an overlay without clicking the overlay", async () => {
    await page.evaluate(() => {
      const target = document.createElement("button");
      target.id = "covered-target";
      target.style.cssText = "position:fixed;top:100px;left:100px";
      target.onclick = () => {
        document.body.dataset.targetClicked = "true";
      };
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:100";
      overlay.onclick = () => {
        document.body.dataset.overlayClicked = "true";
      };
      document.body.append(target, overlay);
    });
    expect(await clickSelector(session, "#covered-target")).toBe(false);
    expect(
      await page.locator("body").getAttribute("data-target-clicked"),
    ).toBeNull();
    expect(
      await page.locator("body").getAttribute("data-overlay-clicked"),
    ).toBeNull();
  });
  it("refuses a pointer target clipped by a container that cannot scroll", async () => {
    await page.evaluate(() => {
      const container = document.createElement("div");
      container.style.cssText =
        "position:fixed;top:20px;left:20px;width:260px;height:40px;overflow:clip";
      const target = document.createElement("button");
      target.id = "clipped-target";
      target.style.cssText = "position:absolute;top:150px;left:0";
      target.onclick = () => {
        document.body.dataset.targetClicked = "true";
      };
      container.append(target);
      document.body.append(container);
    });
    expect(await clickSelector(session, "#clipped-target")).toBe(false);
    expect(
      await page.locator("body").getAttribute("data-target-clicked"),
    ).toBeNull();
  });
  it("keeps the unique text-only New chat fallback when no explicit label exists", async () => {
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = " New chat";
      button.onclick = () => {
        document.body.dataset.fallbackClicked = "true";
      };
      document.body.append(button);
    });
    expect(await startNewChat(session)).toBe(true);
    expect(
      await page.locator("body").getAttribute("data-fallback-clicked"),
    ).toBe("true");
  });
  it.each([
    "hidden",
    "inert",
    'aria-hidden="true"',
    'style="display:none"',
    'style="visibility:hidden"',
  ])("ignores a stale temporary ON control inside %s", async (attribute) => {
    await page.locator("body").evaluate((body, attribute) => {
      body.insertAdjacentHTML(
        "afterbegin",
        `<div ${attribute}><button aria-label="Turn off temporary chat"></button></div>`,
      );
    }, attribute);
    expect((await readSurface(session)).temporary).toBe(false);
    expect(await setTemporary(session, true)).toBe("toggled");
    expect((await readSurface(session)).temporary).toBe(true);
  });
  it("refuses contradictory visible temporary controls without clicking", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "afterbegin",
        '<button aria-label="Turn off temporary chat"></button>',
      );
    });
    expect((await readSurface(session)).temporary).toBeNull();
    expect(await setTemporary(session, true)).toBe("unavailable");
    expect(await page.locator('[aria-label="Temporary chat"]').count()).toBe(1);
  });
  it("reaches the visible temporary toggle when an older hidden copy remains mounted", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "afterbegin",
        '<div hidden><button aria-label="Temporary chat"></button></div>',
      );
    });
    expect(await setTemporary(session, true)).toBe("toggled");
    expect((await readSurface(session)).temporary).toBe(true);
  });
  it("does not certify a hidden historical effort row over the current displayed effort", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "afterbegin",
        '<div hidden><div role="menuitem" aria-label="Effort High">High</div></div>',
      );
    });
    expect((await readSurface(session)).effort).toBe("Instant");
  });
  it("reads the active model from the visible picker when an older hidden picker remains mounted", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "afterbegin",
        '<div hidden data-model-picker-view="advanced"><div role="menuitemradio" data-model-selected="true" aria-checked="true">GPT-5.6 Sol</div></div>',
      );
    });
    expect(await readSelectedModel(session)).toBe("Latest");
    expect(await page.locator("#mount [role=menu]").count()).toBe(0);
  });
  it("lists and selects visible models despite an older hidden picker", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "afterbegin",
        '<div hidden data-model-picker-view="advanced"><div role="menuitemradio" data-model-selected="true" aria-checked="true">Stale model</div></div>',
      );
    });
    expect(await listModels(session)).toEqual([
      "Latest",
      "GPT-5.6 Sol",
      "GPT-5.5",
    ]);
    await selectModel(session, "GPT-5.6 Sol");
    expect(await readSelectedModel(session)).toBe("GPT-5.6 Sol");
  });
  it("refuses to certify two checked models in the current picker", async () => {
    await page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="Select ChatGPT model"]',
      )!;
      const open = trigger.onclick!;
      trigger.onclick = function (event) {
        open.call(this, event);
        const otherModel = document.querySelectorAll(
          '[role="menuitemradio"]',
        )[1]!;
        otherModel.setAttribute("aria-checked", "true");
        otherModel.setAttribute("data-model-selected", "true");
      };
    });
    expect(await readSelectedModel(session)).toBeNull();
    expect(await page.locator("[role=menu]").count()).toBe(0);
  });
  it.each(["aria-checked", "data-model-selected"])(
    "refuses conflicting model selection when only %s is duplicated",
    async (attribute) => {
      await page.evaluate((attribute) => {
        const trigger = document.querySelector<HTMLButtonElement>(
          '[aria-label="Select ChatGPT model"]',
        )!;
        const open = trigger.onclick!;
        trigger.onclick = function (event) {
          open.call(this, event);
          document
            .querySelectorAll('[role="menuitemradio"]')[1]!
            .setAttribute(attribute, "true");
        };
      }, attribute);
      expect(await readSelectedModel(session)).toBeNull();
      expect(await page.locator("[role=menu]").count()).toBe(0);
    },
  );
  it("refuses duplicate visible model names instead of clicking the first match", async () => {
    await page.evaluate(() => {
      const fixtureWindow = window as unknown as { render: () => void };
      const render = fixtureWindow.render;
      fixtureWindow.render = () => {
        render();
        const option = document.querySelectorAll('[role="menuitemradio"]')[1]!;
        option.after(option.cloneNode(true));
      };
    });
    await expect(selectModel(session, "GPT-5.6 Sol")).rejects.toThrow(
      /ambiguous/,
    );
    expect(await readSelectedModel(session)).toBe("Latest");
    expect(await page.locator("[role=menu]").count()).toBe(0);
  });
  it.each(["Thinking effort", "Ultra High", null])(
    "does not certify an ambiguous raw effort when the displayed label is %s",
    async (label) => {
      await page
        .locator('[aria-label="Select ChatGPT model"]')
        .evaluate((element, label) => {
          element.setAttribute("data-selected-reasoning-effort", "medium");
          if (label === null)
            element.querySelector("[data-tooltip-overflow-target]")!.remove();
          else
            element.querySelector(
              "[data-tooltip-overflow-target]",
            )!.textContent = label;
        }, label);
      expect((await readSurface(session)).effort).toBeNull();
    },
  );
  it("keeps the historical expanded model and effort controls working", async () => {
    await page.setContent(`<button aria-label="Turn on temporary chat"></button>
      <div role="textbox" aria-label="Message ChatGPT"></div>
      <button aria-label="Select ChatGPT model" data-selected-reasoning-effort="Instant">Model</button><div id="mount"></div>
      <script>document.querySelector('[aria-label="Select ChatGPT model"]').onclick=()=>{
        mount.innerHTML='<div role="menu" data-radix-menu-content><button aria-label="Show compact options">Compact</button><div role="menuitem" aria-label="Model GPT-5.6 Sol">Model</div><div role="menuitem" aria-label="Effort Instant">Effort</div></div>';
        document.querySelector('[aria-label="Show compact options"]').focus();
      }; document.addEventListener('keydown',e=>{if(e.key==='Escape')mount.innerHTML=''});</script>`);
    expect(await readSelectedModel(session)).toBe("GPT-5.6 Sol");
    await selectModel(session, "GPT-5.6 Sol");
    await selectEffort(session, "Instant");
    expect(await readSurface(session)).toMatchObject({
      effort: "Instant",
      temporary: false,
    });
    expect(await page.locator("[role=menu]").count()).toBe(0);
  });
  it("refuses two visible model rows in the historical picker", async () => {
    await page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="Select ChatGPT model"]',
      )!;
      trigger.onclick = () => {
        document.getElementById("mount")!.innerHTML =
          '<div role="menu" data-radix-menu-content><button aria-label="Show compact options">Compact</button><div role="menuitem" aria-label="Model GPT-5.6 Sol">Model</div><div role="menuitem" aria-label="Model GPT-5.5">Model</div></div>';
        document
          .querySelector<HTMLElement>('[aria-label="Show compact options"]')!
          .focus();
      };
    });
    expect(await readSelectedModel(session)).toBeNull();
    expect(await page.locator("[role=menu]").count()).toBe(0);
  });
  it("reads and restores the renamed temporary toggle", async () => {
    expect((await readSurface(session)).temporary).toBe(false);
    expect(await setTemporary(session, true)).toBe("toggled");
    expect((await readSurface(session)).temporary).toBe(true);
    expect(await setTemporary(session, false)).toBe("toggled");
    expect((await readSurface(session)).temporary).toBe(false);
  });
  it("lists and selects the explicit model instead of silently accepting Latest", async () => {
    expect(await listModels(session)).toEqual([
      "Latest",
      "GPT-5.6 Sol",
      "GPT-5.5",
    ]);
    expect(await readSelectedModel(session)).toBe("Latest");
    await selectModel(session, "GPT-5.6 Sol");
    expect(await readSelectedModel(session)).toBe("GPT-5.6 Sol");
    expect(await page.locator("[role=menu]").count()).toBe(0);
  }, 30_000);
  it("reads the UI effort label, including Pro whose raw effort is also medium", async () => {
    await selectEffort(session, "High");
    expect((await readSurface(session)).effort).toBe("High");
    await selectEffort(session, "Pro");
    expect((await readSurface(session)).effort).toBe("Pro");
  });
  it("lists every slider stop and restores the selected effort and model", async () => {
    await selectModel(session, "GPT-5.6 Sol");
    await selectEffort(session, "High");
    expect(await listEfforts(session)).toEqual([
      "Instant",
      "Medium",
      "High",
      "Extra High",
      "Pro",
    ]);
    expect((await readSurface(session)).effort).toBe("High");
    expect(await readSelectedModel(session)).toBe("GPT-5.6 Sol");
  }, 30_000);
  it("refuses an unavailable model and closes its menu", async () => {
    await expect(selectModel(session, "Imaginary model")).rejects.toThrow(
      /does not offer/,
    );
    expect(await page.locator("[role=menu]").count()).toBe(0);
    expect(await readSelectedModel(session)).toBe("Latest");
  });
  it("refuses an unavailable effort and restores the original stop", async () => {
    await expect(selectEffort(session, "Imaginary effort")).rejects.toThrow(
      /does not offer/,
    );
    expect((await readSurface(session)).effort).toBe("Instant");
    expect(await page.locator("[role=menu]").count()).toBe(0);
  });
  it("closes a picker whose controls are unknown", async () => {
    await page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="Select ChatGPT model"]',
      )!;
      trigger.onclick = () => {
        document.getElementById("mount")!.innerHTML =
          '<div data-radix-menu-content role="menu">Unknown controls</div>';
      };
    });
    await expect(listModels(session)).rejects.toThrow(/advanced options/);
    expect(await page.locator("[role=menu]").count()).toBe(0);
  });
});

describe("client submission against the real synthetic DOM", () => {
  beforeEach(async () => {
    const cdp = await page.context().newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.detach();
    // Redirect only app discovery. The client attaches a real websocket and
    // uses the production surface queries and trusted input events below.
    vi.spyOn(desktopApp, "resolveRenderer").mockResolvedValue({
      port: 33105,
      target: {
        id: targetInfo.targetId,
        type: "page",
        title: "Synthetic Desktop fixture",
        url: "about:blank",
        webSocketDebuggerUrl: `ws://127.0.0.1:33105/devtools/page/${targetInfo.targetId}`,
      },
    });
    await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(
        '[aria-label="Message ChatGPT"]',
      )!;
      const temporaryButton = document.querySelector<HTMLButtonElement>(
        '[aria-label="Temporary chat"]',
      )!;
      const newChat = document.createElement("button");
      newChat.setAttribute("aria-label", "New chat");
      newChat.onclick = () => {
        composer.textContent = "";
        document
          .querySelectorAll("[data-markdown-text-style], [data-fixture-stop]")
          .forEach((element) => element.remove());
      };
      document.body.prepend(newChat);
      composer.onkeydown = (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        document.body.dataset.submissions = String(
          Number(document.body.dataset.submissions || 0) + 1,
        );
        document.body.dataset.submittedTemporary = String(
          temporaryButton.getAttribute("aria-label") ===
            "Turn off temporary chat",
        );
        const stop = document.createElement("button");
        stop.setAttribute("aria-label", "Stop generating");
        stop.setAttribute("data-fixture-stop", "true");
        document.body.append(stop);
        const answer = document.createElement("div");
        answer.setAttribute("data-markdown-text-style", "assistant-message");
        answer.textContent = "Synthetic fixture answer";
        document.body.append(answer);
        setTimeout(() => stop.remove(), 800);
      };
    });
  });

  it("scrolls the offscreen New chat control and actually clears the answer during cleanup", async () => {
    await page.setViewportSize({ width: 1090, height: 760 });
    await page.evaluate(() => {
      const newChat = document.querySelector<HTMLButtonElement>(
        '[aria-label="New chat"]',
      )!;
      const temporary = document.querySelector<HTMLButtonElement>(
        '[aria-label="Temporary chat"]',
      )!;
      const composer = document.querySelector<HTMLElement>(
        '[aria-label="Message ChatGPT"]',
      )!;
      const originalNewChat = newChat.onclick!;
      newChat.onclick = function (event) {
        document.body.dataset.newChatClicks = String(
          Number(document.body.dataset.newChatClicks || 0) + 1,
        );
        document.body.dataset.trustedClick = String(event.isTrusted);
        originalNewChat.call(this, event);
        temporary.hidden = false;
      };
      const originalSubmit = composer.onkeydown!;
      composer.onkeydown = function (event) {
        originalSubmit.call(this, event);
        if (event.key === "Enter") temporary.hidden = true;
      };
      document.body.style.marginLeft = "300px";
      const sidebar = document.createElement("aside");
      sidebar.style.cssText =
        "position:fixed;top:0;left:0;width:280px;height:100vh;overflow:auto";
      const contents = document.createElement("div");
      contents.style.cssText = "position:relative;height:1400px";
      newChat.style.cssText =
        "position:absolute;left:241px;top:980px;width:24px;height:24px;padding:0";
      const textButton = document.createElement("button");
      textButton.textContent = " New chat";
      textButton.style.cssText = "position:absolute;left:8px;top:86px";
      contents.append(textButton, newChat);
      sidebar.append(contents);
      document.body.append(sidebar);
    });
    expect(
      await page
        .locator('[aria-label="New chat"]')
        .evaluate(
          (element) => element.getBoundingClientRect().top > window.innerHeight,
        ),
    ).toBe(true);
    await expect(
      askChatGptDesktop(
        { prompt: "Synthetic fixture only", temporary: true },
        { port: 33105, autoLaunch: false },
      ),
    ).resolves.toMatchObject({
      text: "Synthetic fixture answer",
      temporary: true,
    });
    expect((await readSurface(session)).temporary).toBe(false);
    expect(
      await page
        .locator("[data-markdown-text-style=assistant-message]")
        .count(),
    ).toBe(0);
    expect(
      await page.locator("body").getAttribute("data-new-chat-clicks"),
    ).toBe("2");
    expect(await page.locator("body").getAttribute("data-trusted-click")).toBe(
      "true",
    );
    expect(await page.locator("body").getAttribute("data-submissions")).toBe(
      "1",
    );
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("");
  });

  it("uses the unique text New chat fallback when the explicit control remains covered after scrolling", async () => {
    await page.setViewportSize({ width: 1090, height: 760 });
    await page.evaluate(() => {
      const newChat = document.querySelector<HTMLButtonElement>(
        '[aria-label="New chat"]',
      )!;
      const temporary = document.querySelector<HTMLButtonElement>(
        '[aria-label="Temporary chat"]',
      )!;
      const composer = document.querySelector<HTMLElement>(
        '[aria-label="Message ChatGPT"]',
      )!;
      const reset = newChat.onclick!;
      newChat.onclick = () => {
        document.body.dataset.explicitClicked = "true";
      };
      const originalSubmit = composer.onkeydown!;
      composer.onkeydown = function (event) {
        originalSubmit.call(this, event);
        if (event.key === "Enter") temporary.hidden = true;
      };
      document.body.style.marginLeft = "300px";
      const sidebar = document.createElement("aside");
      sidebar.style.cssText =
        "position:fixed;top:0;left:0;width:280px;height:100vh;overflow:auto";
      const contents = document.createElement("div");
      contents.style.cssText = "position:relative;height:1400px";
      newChat.style.cssText =
        "position:absolute;left:241px;top:980px;width:24px;height:24px;padding:0";
      const cover = document.createElement("div");
      cover.style.cssText =
        "position:absolute;left:235px;top:975px;width:40px;height:40px;z-index:10";
      cover.onclick = () => {
        document.body.dataset.coverClicked = "true";
      };
      const textButton = document.createElement("button");
      textButton.textContent = " New chat";
      textButton.style.cssText = "position:absolute;left:8px;top:86px";
      textButton.onclick = function (event) {
        document.body.dataset.fallbackClicks = String(
          Number(document.body.dataset.fallbackClicks || 0) + 1,
        );
        document.body.dataset.trustedClick = String(event.isTrusted);
        reset.call(this, event);
        temporary.hidden = false;
      };
      contents.append(textButton, newChat, cover);
      sidebar.append(contents);
      document.body.append(sidebar);
    });
    await expect(
      askChatGptDesktop(
        { prompt: "Synthetic fixture only", temporary: true },
        { port: 33105, autoLaunch: false },
      ),
    ).resolves.toMatchObject({
      text: "Synthetic fixture answer",
      temporary: true,
    });
    expect((await readSurface(session)).temporary).toBe(false);
    expect(
      await page
        .locator("[data-markdown-text-style=assistant-message]")
        .count(),
    ).toBe(0);
    expect(
      await page.locator("body").getAttribute("data-fallback-clicks"),
    ).toBe("2");
    expect(await page.locator("body").getAttribute("data-trusted-click")).toBe(
      "true",
    );
    expect(
      await page.locator("body").getAttribute("data-explicit-clicked"),
    ).toBeNull();
    expect(
      await page.locator("body").getAttribute("data-cover-clicked"),
    ).toBeNull();
    expect(await page.locator("body").getAttribute("data-submissions")).toBe(
      "1",
    );
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("");
  });

  it("prefers the explicit New chat label when the observed text-only sidebar button is also visible", async () => {
    await page.evaluate(() => {
      const explicit = document.querySelector<HTMLButtonElement>(
        '[aria-label="New chat"]',
      )!;
      const open = explicit.onclick!;
      explicit.onclick = function (event) {
        document.body.dataset.explicitClicks = String(
          Number(document.body.dataset.explicitClicks || 0) + 1,
        );
        open.call(this, event);
      };
      explicit.textContent = " ";
      const sidebar = document.createElement("button");
      sidebar.textContent = " New chat";
      sidebar.onclick = () => {
        document.body.dataset.fallbackClicked = "true";
      };
      document.body.prepend(sidebar);
      document.querySelector('[aria-label="Message ChatGPT"]')!.textContent =
        "Synthetic prior draft";
    });
    await expect(
      askChatGptDesktop(
        { prompt: "Synthetic fixture only", temporary: true },
        { port: 33105, autoLaunch: false },
      ),
    ).resolves.toMatchObject({
      text: "Synthetic fixture answer",
      temporary: true,
    });
    expect(await page.locator("body").getAttribute("data-submissions")).toBe(
      "1",
    );
    expect(
      await page.locator("body").getAttribute("data-explicit-clicks"),
    ).toBe("2");
    expect(
      await page.locator("body").getAttribute("data-fallback-clicked"),
    ).toBeNull();
    expect(
      await page.locator("body").getAttribute("data-submitted-temporary"),
    ).toBe("true");
    expect((await readSurface(session)).temporary).toBe(false);
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("");
    expect(
      await page
        .locator("[data-markdown-text-style=assistant-message]")
        .count(),
    ).toBe(0);
  });

  it("refuses two explicit New chat labels even when a text-only fallback is unique", async () => {
    await page.evaluate(() => {
      const duplicate = document.createElement("button");
      duplicate.setAttribute("aria-label", "New chat");
      const fallback = document.createElement("button");
      fallback.textContent = "New chat";
      document.body.prepend(duplicate, fallback);
    });
    await expect(
      askChatGptDesktop(
        { prompt: "Synthetic fixture only", temporary: true },
        { port: 33105, autoLaunch: false },
      ),
    ).rejects.toThrow(/could not start a new chat/);
    expect(
      await page.locator("body").getAttribute("data-submissions"),
    ).toBeNull();
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("");
    expect((await readSurface(session)).temporary).toBe(false);
  });

  it("refuses a stale draft when the new-chat click leaves the composer populated", async () => {
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>(
        '[aria-label="New chat"]',
      )!.onclick = () => undefined;
      document.querySelector('[aria-label="Message ChatGPT"]')!.textContent =
        "Existing synthetic draft";
    });
    await expect(
      askChatGptDesktop(
        { prompt: "Synthetic fixture only", temporary: true },
        { port: 33105, autoLaunch: false },
      ),
    ).rejects.toThrow(/composer.*empty/);
    expect(
      await page.locator("body").getAttribute("data-submissions"),
    ).toBeNull();
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("Existing synthetic draft");
  });

  it("does not submit under the wrong model when a stale hidden historical row matches the request", async () => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<div hidden><div role="menuitem" aria-label="Model GPT-5.6 Sol">Model</div></div>',
      );
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="Select ChatGPT model"]',
      )!;
      trigger.onclick = () => {
        document.getElementById("mount")!.innerHTML =
          '<div role="menu" data-radix-menu-content><button aria-label="Show compact options">Compact</button><div role="menuitem" aria-label="Model GPT-5.5">Model</div><div role="menuitem" aria-label="Effort Instant">Effort</div></div>';
        document
          .querySelector<HTMLElement>('[aria-label="Show compact options"]')!
          .focus();
      };
    });
    const observedBefore = await readSelectedModel(session);
    await expect(
      askChatGptDesktop(
        {
          prompt: "Synthetic fixture only",
          model: "GPT-5.6 Sol",
          temporary: true,
        },
        { port: 33105, autoLaunch: false },
      ),
    ).rejects.toThrow(/model/);
    expect(observedBefore).toBe("GPT-5.5");
    expect(
      await page.locator("body").getAttribute("data-submissions"),
    ).toBeNull();
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("");
    expect((await readSurface(session)).temporary).toBe(false);
    expect(await readSelectedModel(session)).toBe("GPT-5.5");
  });

  it("submits only after the visible temporary control confirms ON despite a stale hidden ON copy", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "afterbegin",
        '<div hidden><button aria-label="Turn off temporary chat"></button></div>',
      );
    });
    await expect(
      askChatGptDesktop(
        { prompt: "Synthetic fixture only", temporary: true },
        { port: 33105, autoLaunch: false },
      ),
    ).resolves.toMatchObject({
      text: "Synthetic fixture answer",
      temporary: true,
    });
    expect(await page.locator("body").getAttribute("data-submissions")).toBe(
      "1",
    );
    expect(
      await page.locator("body").getAttribute("data-submitted-temporary"),
    ).toBe("true");
    expect((await readSurface(session)).temporary).toBe(false);
    expect(
      await page
        .locator("[data-markdown-text-style=assistant-message]")
        .count(),
    ).toBe(0);
  });

  it("refuses contradictory visible temporary controls before typing or submitting", async () => {
    await page.locator("body").evaluate((body) => {
      body.insertAdjacentHTML(
        "afterbegin",
        '<button aria-label="Turn off temporary chat"></button>',
      );
    });
    await expect(
      askChatGptDesktop(
        { prompt: "Synthetic fixture only", temporary: true },
        { port: 33105, autoLaunch: false },
      ),
    ).rejects.toThrow(/could not confirm temporary chat/);
    expect(
      await page.locator("body").getAttribute("data-submissions"),
    ).toBeNull();
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("");
  });
  it("cleans up a failed model selection and accepts the next request on the same surface", async () => {
    await expect(
      askChatGptDesktop(
        {
          prompt: "Synthetic fixture only",
          model: "Unavailable renamed model",
          temporary: true,
        },
        { port: 33105, autoLaunch: false },
      ),
    ).rejects.toThrow(/does not offer/);
    expect(
      await page.locator("body").getAttribute("data-submissions"),
    ).toBeNull();
    expect((await readSurface(session)).temporary).toBe(false);
    expect(await page.locator("[role=menu]").count()).toBe(0);
    expect(
      await page.locator('[aria-label="Message ChatGPT"]').textContent(),
    ).toBe("");
    await expect(
      askChatGptDesktop(
        {
          prompt: "Synthetic fixture only",
          model: "GPT-5.6 Sol",
          effort: "Instant",
          temporary: true,
        },
        { port: 33105, autoLaunch: false },
      ),
    ).resolves.toMatchObject({
      text: "Synthetic fixture answer",
      model: "GPT-5.6 Sol",
      effort: "Instant",
      temporary: true,
    });
    expect(await page.locator("body").getAttribute("data-submissions")).toBe(
      "1",
    );
    expect(
      await page.locator("body").getAttribute("data-submitted-temporary"),
    ).toBe("true");
    expect((await readSurface(session)).temporary).toBe(false);
    expect(
      await page
        .locator("[data-markdown-text-style=assistant-message]")
        .count(),
    ).toBe(0);
  }, 30_000);
});
