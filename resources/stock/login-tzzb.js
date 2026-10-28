/**
 * opencli stock login-tzzb —— 自动登录同花顺账号中心（upass.10jqka.com.cn）
 *
 * 登录分两步：
 *   第 1 步 打开登录页 → 切到「密码登录」→ 点击用户名输入框触发浏览器
 *           （Chrome/Edge）自动填充记住的用户名与密码 → 点击「登录」
 *           （也可用 --user/--pass 显式覆盖；--wait-manual 等待人工填充）。
 *   第 2 步 服务端风控下发滑块验证（errorcode -10507 / -11400）：
 *           读取背景图与拼图块，按「亮度残差 × 拼图 alpha 掩码」定位缺口，
 *           再用 CDP 原生鼠标事件把滑块拖到缺口位置；通过后页面会带着
 *           captcha_ticket 自动重新提交登录。
 *
 * 说明：
 *   - 同花顺密码登录表单不是 <form>，登录按钮只有在两个输入框都有值时
 *     才带 enable_submit_btn 类，因此填值后需补发 input 事件。
 *   - 浏览器窗口必须可见：Chrome 会对隐藏/遮挡窗口拒绝可信输入（autofill、
 *     点击、拖动），所以默认前台运行。
 *   - 登录页脚本初始化较慢：过早切「密码登录」会被页面初始化重置回短信登录，
 *     因此必须等面板几何稳定；面板稳定后对 #uname 做一次真实点击，浏览器
 *     才会自动填充记住的账号（仅 JS focus 不触发）。
 *   - 滑块图片由 captcha.10jqka.com.cn 直接返回（Access-Control-Allow-Origin: *），
 *     检测在页面内用 canvas 完成，不上传图片、不依赖外部打码服务。
 */
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";

// ============================ 常量 ============================

const SITE = "stock";
const LOGIN_HOST = "upass.10jqka.com.cn";
const LOGIN_URL = `https://${LOGIN_HOST}/login`;

// 页面选择器（已在真实页面实测）
const SEL = {
  tab: "#to_account_login",
  panel: "#account_pannel",
  user: "#uname",
  pass: "#passwd",
  submit: "#account_pannel .submit_btn",
  submitReadyClass: "enable_submit_btn",
  captcha: "#captcha",
  slider: "#slider",
  sliderImg: "#slicaptcha-img",
  sliderBlock: "#slicaptcha-block",
  sliderText: "#slicaptcha-text",
  sliderWarn: "#slicaptcha-warn",
};

// 时间常量（毫秒；page.sleep 处换算为秒）
const LOGIN_PAGE_WAIT_MS = 20_000;      // 登录页表单就绪
const POST_SUBMIT_WAIT_MS = 90_000;     // 点击登录后的状态机总窗口（风控+滑块+二次提交）
const CAPTCHA_IMAGE_WAIT_MS = 12_000;   // 滑块图片/prehandle 就绪
const CAPTCHA_RESULT_WAIT_MS = 15_000;  // 单次拖动后等待服务端校验结果
const POLL_MS = 300;
const MAX_CAPTCHA_ROUNDS = 3;           // 服务端可能连续下发多轮风控

// 拖动参数：captcha 内部对 moveX 的限制是 moveX + 52 <= 309
const DRAG_MAX_X = 257;
const DRAG_STEPS = 26;
const DRAG_STEP_MIN_MS = 12;
const DRAG_STEP_JITTER_MS = 10;

// 密码错误 / 账号异常不会自愈，重试只会延长风控 —— 命中即终止。
const FATAL_ERROR_RE =
  /用户名或密码|密码错误|密码不正确|帐号.*锁定|账号.*锁定|存在异常|身份验证|拒绝登录|尝试次数过多|操作过于频繁|禁止登录/i;

// ============================ 页面状态 ============================

async function liveUrl(page) {
  try {
    return String((await page.evaluate("location.href")) || "");
  } catch {
    return "";
  }
}

function isLoginUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return u.hostname === LOGIN_HOST && u.pathname.replace(/\/+$/, "") === "/login";
  } catch {
    return false;
  }
}

/** Chrome 对隐藏/遮挡窗口拒绝可信输入；尝试恢复窗口，仍不可见则明确失败 */
async function ensureVisible(page, where) {
  // 标签页/窗口未激活时，自动填充下拉与键盘选择都不可用，先显式切到前台
  try {
    await page.cdp("Page.bringToFront");
  } catch {
    // 某些环境不支持，忽略
  }
  let vis = await page.evaluate("document.visibilityState").catch(() => "unknown");
  if (vis !== "visible") {
    try {
      const win = await page.cdp?.("Browser.getWindowForTarget");
      if (win?.windowId != null) {
        await page.cdp("Browser.setWindowBounds", {
          windowId: win.windowId,
          bounds: { windowState: "normal" },
        });
      }
      await page.sleep(0.5);
    } catch {
      // best-effort restore
    }
    vis = await page.evaluate("document.visibilityState").catch(() => "unknown");
  }
  if (vis !== "visible") {
    throw new CommandExecutionError(
      `浏览器页面不可见（${vis}，${where}）；Chrome 会拒绝隐藏窗口的可信输入。请保持 OpenCLI 浏览器窗口前台可见（命令默认前台运行）。`,
      "不要最小化/遮挡浏览器窗口，或加 --window foreground 重试",
    );
  }
}

/** 轮询直到 probe() 返回真值；超时返回 null */
async function waitUntil(page, timeoutMs, probe, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await probe();
      if (result) return result;
    } catch {
      // 页面导航/tear-down 期间 evaluate 可能失败，重试即可
    }
    if (Date.now() > deadline) return null;
    await page.sleep(intervalMs / 1000);
  }
}

async function isVisible(page, selector) {
  try {
    return Boolean(
      await page.evaluate(`(() => {
        const sel = ${JSON.stringify(selector)};
        return [...document.querySelectorAll(sel)].some((el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        });
      })()`),
    );
  } catch {
    return false;
  }
}

/** 登录表单结构快照：定位失败时输出，便于判断是改版、重定向还是被浮层拦截 */
async function probeLoginDom(page) {
  try {
    return await page.evaluate(`(() => {
      const info = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          found: true,
          visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
          cls: String(el.className || '').slice(0, 60),
          text: String(el.textContent || '').trim().slice(0, 40),
        };
      };
      return {
        url: location.href,
        title: document.title,
        tab: info(${JSON.stringify(SEL.tab)}),
        panel: info(${JSON.stringify(SEL.panel)}),
        uname: info(${JSON.stringify(SEL.user)}),
        frames: [...document.querySelectorAll('iframe')].map((f) => f.src).slice(0, 5),
      };
    })()`);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/** 浏览器自动填充「预览态」：DOM value 仍为空，但输入框已标 :autofill */
async function autofillPreview(page) {
  try {
    return Boolean(
      await page.evaluate(`(() => [${JSON.stringify(SEL.user)}, ${JSON.stringify(SEL.pass)}].some((s) => {
        const el = document.querySelector(s);
        return !!(el && (el.matches(':autofill') || el.matches(':-webkit-autofill')));
      }))()`),
    );
  } catch {
    return false;
  }
}

async function focusElement(page, selector) {
  try {
    await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.focus();
      return true;
    })()`);
  } catch {
    // ignore
  }
}

/** 凭据表单聚焦/填充快照：判断浏览器自动填充是否真的作用在当前输入框 */
async function probeCredentialForm(page) {
  try {
    return await page.evaluate(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        return {
          found: true,
          valueLen: String(el.value || '').length,
          autofill: el.matches(':autofill') || el.matches(':-webkit-autofill'),
          disabled: !!el.disabled,
          readOnly: !!el.readOnly,
        };
      };
      return {
        url: location.href,
        hasFocus: document.hasFocus(),
        visibility: document.visibilityState,
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '',
        user: pick(${JSON.stringify(SEL.user)}),
        pass: pick(${JSON.stringify(SEL.pass)}),
        submitReady: !!(document.querySelector(${JSON.stringify(SEL.submit)}) || {}).classList?.contains(${JSON.stringify(SEL.submitReadyClass)}),
      };
    })()`);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

async function readValue(page, selector) {
  try {
    const v = await page.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? String(el.value || '') : ''; })()`,
    );
    return String(v || "");
  } catch {
    return "";
  }
}

/** 登录页给按钮加 enable_submit_btn 类才允许提交；填值后补发 input 事件 */
async function isSubmitEnabled(page) {
  try {
    return Boolean(
      await page.evaluate(`(() => {
        const b = document.querySelector(${JSON.stringify(SEL.submit)});
        return !!(b && b.classList.contains(${JSON.stringify(SEL.submitReadyClass)}));
      })()`),
    );
  } catch {
    return false;
  }
}

async function nudgeInputs(page) {
  try {
    await page.evaluate(`(() => {
      for (const sel of [${JSON.stringify(SEL.user)}, ${JSON.stringify(SEL.pass)}]) {
        const el = document.querySelector(sel);
        if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
  } catch {
    // ignore
  }
}

/**
 * 可见错误/风控快照：
 *   toast  —— errorTip 用的 Toast（1.5s 后隐藏，轮询 300ms 可捕捉）
 *   alert  —— 账号异常等 AlertBox
 *   weak   —— 弱密码提示弹窗
 *   verify —— -10510 风险处置页（另一套验证码，需人工完成）
 */
const ERROR_SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const toast = document.getElementById('ths-upass-toast');
  const toastText = toast && toast.querySelector('.toast-title') ? toast.querySelector('.toast-title').textContent.trim() : '';
  const alertMain = document.querySelector('#ths-alertbox .alert-main');
  const weak = document.getElementById('weakPassword');
  const verify = document.querySelector('.verificationDOM_body');
  return {
    toast: visible(toast) ? toastText : '',
    alert: visible(alertMain) ? String(alertMain.textContent || '').trim() : '',
    weak: visible(weak) ? String(weak.innerText || '').trim().slice(0, 200) : '',
    verify: visible(verify) ? 'risk-verification' : '',
  };
})()`;

async function readErrorState(page) {
  try {
    return await page.evaluate(ERROR_SNAPSHOT_SCRIPT);
  } catch {
    return { toast: "", alert: "", weak: "", verify: "" };
  }
}

async function isCaptchaOpen(page) {
  try {
    return Boolean(
      await page.evaluate(`(() => {
        const c = document.querySelector(${JSON.stringify(SEL.captcha)});
        const s = document.querySelector(${JSON.stringify(SEL.slider)});
        if (!c || !s) return false;
        const r = c.getBoundingClientRect();
        const st = getComputedStyle(c);
        return r.width > 0 && r.height > 0 && st.display !== 'none';
      })()`),
    );
  } catch {
    return false;
  }
}

// ============================ 浏览器原语 ============================

/** 浏览器级原生鼠标点击（坐标来自元素几何），回退 JS click */
async function clickNative(page, selector) {
  try {
    const pos = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (pos?.x != null) {
      await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
      await page.sleep(0.08);
      await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
      await page.sleep(0.06);
      await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
      return;
    }
  } catch {
    // fall through to JS click
  }
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('元素不存在: ' + ${JSON.stringify(selector)});
    el.click();
    return true;
  })()`);
}

/**
 * 浏览器级原生按键。
 * 只传 key、不传 code/windowsVirtualKeyCode/nativeVirtualKeyCode：自动填充下拉
 * 由浏览器进程处理，显式传错误的 nativeVirtualKeyCode（如 40）会让它忽略按键。
 * 与 opencli page.pressKey 的 CDP 路径保持一致。
 */
async function pressKey(page, key) {
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key });
  await page.sleep(0.08);
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key });
}

/** 填值并回读校验；React/Angular 兼容的 native setter + input/change 事件 */
async function fillField(page, selector, text) {
  const expected = String(text);
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('元素不存在: ' + ${JSON.stringify(selector)});
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(expected)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const actual = await readValue(page, selector);
  if (actual !== expected) {
    throw new CommandExecutionError(
      `表单填写失败（${selector}）: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
}

// ============================ 第 1 步：凭据 ============================

/**
 * 等待「密码登录」面板真正稳定。
 * 登录页初始化较慢：过早点击密码登录后，页面初始化会把面板重置回短信登录，
 * 此时 #uname 尺寸为 0、点击不会聚焦，浏览器也不会自动填充。这里要求面板
 * 连续两次几何一致（约 0.8s 不动），期间被重置就补一次 JS 点击。
 */
async function waitPanelStable(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSig = "";
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(`(() => {
        const p = document.querySelector(${JSON.stringify(SEL.panel)});
        const u = document.querySelector(${JSON.stringify(SEL.user)});
        if (!p || !u) return null;
        const r = u.getBoundingClientRect();
        const s = getComputedStyle(p);
        return {
          current: String(p.className).includes('current_pannel'),
          display: s.display,
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
        };
      })()`)
      .catch(() => null);

    const ok = state && state.current && state.display !== "none" && state.w > 50 && state.h > 10;
    if (ok) {
      const sig = `${state.w}x${state.h}@${state.x},${state.y}`;
      if (sig === lastSig) return state;
      lastSig = sig;
    } else {
      lastSig = "";
      await page
        .evaluate(`(() => { const el = document.querySelector(${JSON.stringify(SEL.tab)}); if (el) el.click(); return true; })()`)
        .catch(() => {});
    }
    await page.sleep(0.4);
  }
  return null;
}

async function countRequests(page) {
  try {
    return Number(await page.evaluate("performance.getEntriesByType('resource').length")) || 0;
  } catch {
    return 0;
  }
}

async function readCredentials(page) {
  return {
    user: await readValue(page, SEL.user),
    pass: await readValue(page, SEL.pass),
  };
}

/**
 * 凭据来源优先级：--user/--pass > 浏览器记住的凭据。
 * 面板稳定后对用户名框做一次真实点击，浏览器会在 1~2 秒内自动填充；
 * 若只出现「预览」（:autofill 为真但 value 为空），按 ↓ 确认选中。
 */
async function ensureCredentials(page, { user, pass, manualWaitSec }) {
  if (user && pass) {
    log.info(`使用命令行凭据填写密码登录表单（用户：${user}）…`);
    await fillField(page, SEL.user, user);
    await fillField(page, SEL.pass, pass);
    await nudgeInputs(page);
    return { credentialSource: "manual", detectedUser: user };
  }

  // 实测：在几何稳定的密码面板上做一次真实点击（CDP），浏览器会在 1~2 秒内
  // 自动把记住的账号填进两个输入框；若浏览器只给出「预览」（:autofill 为真、
  // value 仍为空），按一次 ↓ 即可确认落值。过早点击（面板还在动画/被页面
  // 初始化重置）不会聚焦，也永远等不到自动填充，因此这里先保险地点一次，
  // 之后低频轻推，避免频繁点击把下拉关掉。
  log.info("点击用户名输入框，等待浏览器自动填充（最多 20 秒）…");
  await clickNative(page, SEL.user);
  await focusElement(page, SEL.user);

  const autofillDeadline = Date.now() + 20_000;
  let lastNudgeAt = Date.now();
  let lastArrowAt = 0;
  let arrowTries = 0;
  let creds = await readCredentials(page);

  while (!(creds.user && creds.pass) && Date.now() < autofillDeadline) {
    await page.sleep(0.5);
    creds = await readCredentials(page);
    if (creds.user && creds.pass) break;

    const now = Date.now();
    // 预览态：按一次 ↓ 确认选中（间隔 ≥2.5s，避免连续方向键滚动下拉）
    if (now - lastArrowAt >= 2_500 && (await autofillPreview(page))) {
      lastArrowAt = now;
      arrowTries += 1;
      if (arrowTries <= 2) log.info(`检测到自动填充预览，按 ↓ 选择记住的账号（第 ${arrowTries} 次）…`);
      await focusElement(page, SEL.user);
      await page.sleep(0.25);
      await pressKey(page, "ArrowDown");
      continue;
    }
    // 轻推：每 5 秒补一次真实点击，重新给出自动填充时机
    if (now - lastNudgeAt >= 5_000) {
      lastNudgeAt = now;
      await clickNative(page, SEL.user);
      await focusElement(page, SEL.user);
    }
  }

  let formState = creds.user && creds.pass ? null : await probeCredentialForm(page);
  if (formState) log.info(`自动填充未生效，表单状态：${JSON.stringify(formState)}`);

  // 密码管理器有时只填用户名或只填密码，补点另一个输入框
  if (!(creds.user && creds.pass) && (creds.user || creds.pass)) {
    if (creds.user) {
      await clickNative(page, SEL.pass);
      await focusElement(page, SEL.pass);
    } else {
      await clickNative(page, SEL.user);
      await focusElement(page, SEL.user);
    }
    await page.sleep(0.8);
    creds = await readCredentials(page);
  }

  if (creds.user && creds.pass) {
    await nudgeInputs(page);
    log.success(`浏览器记住的凭据已填充：${creds.user}`);
    return { credentialSource: "browser-saved", detectedUser: creds.user };
  }

  if (manualWaitSec > 0) {
    log.warn(
      `未能自动触发浏览器自动填充。请在浏览器窗口的登录表单里手动输入用户名/密码，` +
        `插件将在 ${manualWaitSec} 秒内自动继续…`,
    );
    const filled = await waitUntil(page, manualWaitSec * 1000, async () => {
      const c = await readCredentials(page);
      return c.user && c.pass ? c : null;
    });
    if (filled) {
      await nudgeInputs(page);
      log.success(`检测到表单已填充：${filled.user}`);
      return { credentialSource: "manual-wait", detectedUser: filled.user };
    }
    throw new CommandExecutionError(
      "等待人工填充超时（用户名/密码仍为空）",
      `请确认浏览器已保存 ${LOGIN_HOST} 的账号密码，或改用 --user/--pass 显式登录`,
    );
  }

  throw new AuthRequiredError(
    LOGIN_HOST,
    "未能获取同花顺登录用户名/密码（浏览器未自动填充）",
    "请确认 Chrome 已保存该站点的账号密码并勾选“自动登录”，或用 --user/--pass 传入；也可加 --wait-manual 30 手动输入",
  );
}

// ============================ 第 2 步：滑块验证 ============================

/**
 * 在页面内定位拼图缺口（该函数会被序列化后在浏览器执行，不能引用 Node 变量）。
 *
 * 原理：背景图里缺口是「半透明白色覆盖」，相对大半径模糊的亮度残差为正；
 * 拼图块 PNG 的 alpha 通道给出精确形状掩码。把残差按掩码求和，得分最高的
 * 位置就是缺口左上角。拼图块自然宽度 55、背景 340，按渲染宽度换算成拖动距离。
 */
async function detectGapInPage() {
  const img = document.getElementById("slicaptcha-img");
  const block = document.getElementById("slicaptcha-block");
  if (!img || !block || !img.naturalWidth || !block.naturalWidth) {
    return { ok: false, reason: "滑块图片尚未加载" };
  }
  const imgSrc = img.src;
  const load = async (src) => {
    const resp = await fetch(src, { credentials: "omit" });
    if (!resp.ok) throw new Error("图片请求失败: HTTP " + resp.status);
    return createImageBitmap(await resp.blob());
  };
  let bmpBg;
  let bmpPc;
  try {
    [bmpBg, bmpPc] = await Promise.all([load(img.src), load(block.src)]);
  } catch (e) {
    return { ok: false, reason: "滑块图片读取失败: " + (e && e.message ? e.message : e) };
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = bmpBg.width;
  canvas.height = bmpBg.height;
  ctx.drawImage(bmpBg, 0, 0);
  const bgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  canvas.width = bmpPc.width;
  canvas.height = bmpPc.height;
  ctx.drawImage(bmpPc, 0, 0);
  const pData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  const W = bmpBg.width;
  const H = bmpBg.height;
  const pw = bmpPc.width;
  const ph = bmpPc.height;

  // 拼图块的 alpha 包围盒（形状掩码）
  let minX = pw;
  let minY = ph;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < ph; y += 1) {
    for (let x = 0; x < pw; x += 1) {
      if (pData[(y * pw + x) * 4 + 3] > 127) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { ok: false, reason: "拼图块 alpha 为空" };
  const mw = maxX - minX + 1;
  const mh = maxY - minY + 1;

  // 灰度图 + 积分图（O(1) 盒式模糊）
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    gray[i] = 0.299 * bgData[i * 4] + 0.587 * bgData[i * 4 + 1] + 0.114 * bgData[i * 4 + 2];
  }
  const R = 12;
  const sum = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y += 1) {
    let row = 0;
    for (let x = 0; x < W; x += 1) {
      row += gray[y * W + x];
      sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row;
    }
  }
  const blur = (x, y) => {
    const x1 = Math.max(0, x - R);
    const x2 = Math.min(W - 1, x + R);
    const y1 = Math.max(0, y - R);
    const y2 = Math.min(H - 1, y + R);
    const s = sum[(y2 + 1) * (W + 1) + x2 + 1] - sum[y1 * (W + 1) + x2 + 1]
      - sum[(y2 + 1) * (W + 1) + x1] + sum[y1 * (W + 1) + x1];
    return s / ((x2 - x1 + 1) * (y2 - y1 + 1));
  };

  // 拼图块与背景的渲染偏移给出缺口 y（服务端 inity 与 block 顶边对齐）
  const bgRect = img.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const renderScale = bgRect.width / W;
  const expectedY = renderScale > 0
    ? Math.round((blockRect.y - bgRect.y) / renderScale)
    : Math.round(H / 2);
  const yCenter = Math.min(H - mh, Math.max(0, expectedY - minY));
  const yFrom = Math.max(0, yCenter - 2);
  const yTo = Math.min(H - mh, yCenter + 2);

  let best = { score: -Infinity, x: 0, y: 0 };
  for (let y = yFrom; y <= yTo; y += 1) {
    for (let x = 0; x <= W - mw; x += 1) {
      let score = 0;
      let n = 0;
      for (let yy = 0; yy < mh; yy += 1) {
        for (let xx = 0; xx < mw; xx += 1) {
          if (pData[((yy + minY) * pw + (xx + minX)) * 4 + 3] <= 127) continue;
          score += gray[(y + yy) * W + (x + xx)] - blur(x + xx, y + yy);
          n += 1;
        }
      }
      if (n === 0) continue;
      score /= n;
      if (score > best.score) best = { score, x, y };
    }
  }

  if (!Number.isFinite(best.score) || best.score <= 0) {
    return { ok: false, reason: "未找到缺口（匹配度 " + best.score + "）", imgSrc };
  }

  const moveCss = (best.x - minX) * renderScale;
  return {
    ok: true,
    holeX: best.x,
    holeY: best.y,
    score: best.score,
    moveCss,
    imgSrc,
    imageSize: W + "x" + H,
  };
}

const CAPTCHA_READY_SCRIPT = `(() => {
  const i = document.querySelector(${JSON.stringify(SEL.sliderImg)});
  const b = document.querySelector(${JSON.stringify(SEL.sliderBlock)});
  const t = document.querySelector(${JSON.stringify(SEL.sliderText)});
  if (!i || !b || !i.naturalWidth || !b.naturalWidth) return false;
  if (parseFloat(getComputedStyle(b).opacity || '0') < 0.9) return false;
  const txt = (t && t.textContent || '').trim();
  return !txt || txt.indexOf('向右拖动') >= 0 || txt.indexOf('加载中') < 0;
})()`;

const CAPTCHA_STATUS_SCRIPT = `(() => {
  const t = document.querySelector(${JSON.stringify(SEL.sliderText)});
  const w = document.querySelector(${JSON.stringify(SEL.sliderWarn)});
  const i = document.querySelector(${JSON.stringify(SEL.sliderImg)});
  return {
    text: (t && t.textContent || '').trim(),
    warn: !!(w && getComputedStyle(w).display !== 'none'),
    src: i ? i.src : '',
  };
})()`;

/** CDP 原生拖动滑块（带缓动与轻微抖动，总时长约 350ms） */
async function dragSlider(page, rect, distance) {
  const x0 = rect.x + rect.width / 2;
  const y0 = rect.y + rect.height / 2;
  const target = Math.min(DRAG_MAX_X, Math.max(0, distance));
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
  await page.sleep(0.05);
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1 });
  for (let i = 1; i <= DRAG_STEPS; i += 1) {
    const t = i / DRAG_STEPS;
    const eased = 1 - (1 - t) ** 3;
    const x = x0 + target * eased;
    const y = y0 + (i % 2 === 0 ? 0.6 : -0.6);
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await page.sleep((DRAG_STEP_MIN_MS + Math.random() * DRAG_STEP_JITTER_MS) / 1000);
  }
  await page.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: x0 + target, y: y0, button: "left", clickCount: 1,
  });
}

/** 等待校验失败后自动刷新的新图片 */
async function waitForRefreshedCaptcha(page, oldSrc, timeoutMs = 10_000) {
  await waitUntil(page, timeoutMs, async () => {
    const st = await page.evaluate(CAPTCHA_STATUS_SCRIPT).catch(() => null);
    if (!st) return null;
    if (st.warn) return { warn: true };
    return st.src && st.src !== oldSrc && st.text.indexOf("向右拖动") >= 0 ? st : null;
  }, 400);
}

/**
 * 完成滑块验证。成功返回 { attempts }；失败抛错。
 * 服务端每次下发的图片/缺口都不同，失败后会自动 refresh，必须重新检测。
 */
async function solveCaptcha(page, maxAttempts) {
  let lastReason = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ready = await waitUntil(page, CAPTCHA_IMAGE_WAIT_MS, () => page.evaluate(CAPTCHA_READY_SCRIPT), 400);
    if (!ready) {
      throw new CommandExecutionError(
        "滑块验证码图片加载超时",
        "请检查网络能否访问 captcha.10jqka.com.cn，或稍后重试",
      );
    }

    let geom;
    try {
      geom = await page.evaluate(`(${detectGapInPage.toString()})()`);
    } catch (e) {
      throw new CommandExecutionError(`滑块缺口检测失败: ${e?.message || e}`);
    }
    if (!geom?.ok) {
      throw new CommandExecutionError(
        `未能定位滑块拼图缺口: ${geom?.reason || "未知原因"}`,
        "登录页可能改版；可将该图片报给插件维护者",
      );
    }

    const rect = await page.evaluate(`(() => {
      const s = document.querySelector(${JSON.stringify(SEL.slider)});
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    if (!rect || rect.width <= 0) {
      throw new CommandExecutionError("未找到可见的滑块拖柄（#slider）");
    }

    log.info(
      `第 ${attempt}/${maxAttempts} 次拖动滑块：缺口 x=${geom.holeX}px，位移 ${geom.moveCss.toFixed(1)}px，匹配度 ${geom.score.toFixed(1)}`,
    );

    await ensureVisible(page, "拖动滑块验证");
    await dragSlider(page, rect, geom.moveCss);

    // 成功：验证码层关闭；失败：图片刷新（src 变化 + 文案恢复）
    const outcome = await waitUntil(page, CAPTCHA_RESULT_WAIT_MS, async () => {
      if (!(await isCaptchaOpen(page))) return { ok: true };
      const st = await page.evaluate(CAPTCHA_STATUS_SCRIPT).catch(() => null);
      if (!st) return null;
      if (st.warn) return { ok: false, fatal: true, reason: "验证尝试次数过多" };
      if (st.src && st.src !== geom.imgSrc && st.text.indexOf("向右拖动") >= 0) {
        return { ok: false, reason: "服务端判定未通过" };
      }
      return null;
    }, 300);

    if (outcome?.ok) {
      log.success(`滑块验证通过（第 ${attempt} 次）`);
      return { attempts: attempt };
    }
    if (outcome?.fatal) {
      throw new CommandExecutionError(
        "滑块验证尝试次数过多，已被同花顺暂时限制",
        "请在浏览器窗口中手动完成一次滑块，或等待片刻后重试；不要高频重跑以免触发风控",
      );
    }

    lastReason = outcome?.reason || "等待校验结果超时";
    if (attempt < maxAttempts) {
      log.warn(`滑块验证未通过（${lastReason}），等待新图片后重试…`);
      await waitForRefreshedCaptcha(page, geom.imgSrc);
    }
  }

  throw new CommandExecutionError(
    `滑块验证 ${maxAttempts} 次均未通过（最后原因: ${lastReason || "未知"}）`,
    "可在浏览器窗口手动完成滑块验证后重试；频繁失败会触发风控",
  );
}

// ============================ 登录流程 ============================

/** 点击登录后的状态机：成功跳转 / 滑块验证 / 错误提示 */
async function waitForLoginOutcome(page, { maxAttempts }) {
  const deadline = Date.now() + POST_SUBMIT_WAIT_MS;
  let captchaRounds = 0;
  let sliderAttempts = 0;
  let lastError = "";
  let lastDiagAt = Date.now();
  let lastDiag = null;
  let diagCount = 0;

  while (Date.now() < deadline) {
    // 超时排障：记录页面状态，前两次同时打印，之后只留最终快照
    if (Date.now() - lastDiagAt >= 6_000) {
      lastDiagAt = Date.now();
      const diag = await page
        .evaluate(`(() => {
          const box = (el) => {
            if (!el) return 'none';
            const r = el.getBoundingClientRect();
            return Math.round(r.width) + 'x' + Math.round(r.height) + '/' + getComputedStyle(el).display;
          };
          return {
            url: location.href,
            captcha: box(document.querySelector(${JSON.stringify(SEL.captcha)})),
            slider: box(document.querySelector(${JSON.stringify(SEL.slider)})),
            submit: String((document.querySelector(${JSON.stringify(SEL.submit)}) || {}).className || ''),
            userLen: String((document.querySelector(${JSON.stringify(SEL.user)}) || {}).value || '').length,
            passLen: String((document.querySelector(${JSON.stringify(SEL.pass)}) || {}).value || '').length,
          };
        })()`)
        .catch((e) => ({ error: String((e && e.message) || e) }));
      lastDiag = diag;
      diagCount += 1;
      if (diagCount <= 2) log.info(`等待登录结果：${JSON.stringify(diag)}`);
    }

    const url = await liveUrl(page);
    if (url && !isLoginUrl(url)) {
      log.success(`登录成功：${url}`);
      return { finalUrl: url, sliderAttempts };
    }

    if (await isCaptchaOpen(page)) {
      if (captchaRounds >= MAX_CAPTCHA_ROUNDS) {
        throw new CommandExecutionError(
          `已连续处理 ${MAX_CAPTCHA_ROUNDS} 轮滑块验证仍未登录成功`,
          "同花顺风控可能要求更换登录方式；请稍后再试或改用手机验证码登录",
        );
      }
      captchaRounds += 1;
      log.info(`检测到滑块安全验证（第 ${captchaRounds} 轮）`);
      const res = await solveCaptcha(page, maxAttempts);
      sliderAttempts += res.attempts;
      // 滑块通过后页面会带 captcha_ticket 自动重新提交登录，继续轮询
      continue;
    }

    const st = await readErrorState(page);
    if (st.verify) {
      throw new CommandExecutionError(
        "同花顺下发了风险处置页（另一套验证码），无法自动完成",
        "请在浏览器窗口手动完成验证后再同步；频繁触发建议稍后重试",
      );
    }
    const errText = st.toast || st.alert || st.weak;
    if (errText) {
      lastError = errText;
      if (FATAL_ERROR_RE.test(errText) || !st.weak) {
        throw new AuthRequiredError(
          LOGIN_HOST,
          `同花顺登录被服务器拒绝: ${errText}`,
          "请核对浏览器保存的用户名/密码，或用 --user/--pass 显式登录；错误重试只会加深风控，不要盲目重跑",
        );
      }
      throw new CommandExecutionError(
        `同花顺提示需要处理: ${errText}`,
        "请在浏览器窗口中按提示操作后再重试",
      );
    }

    await page.sleep(POLL_MS / 1000);
  }

  const finalUrl = await liveUrl(page);
  if (finalUrl && !isLoginUrl(finalUrl)) {
    return { finalUrl, sliderAttempts };
  }
  throw new CommandExecutionError(
    `登录未完成（等待跳转超时）; 页面: ${finalUrl.slice(0, 160)}; 状态: ${JSON.stringify(lastDiag)}`,
    lastError ? `最后原因: ${lastError}` : "点击登录后页面未跳转，可能是网络/风控异常，可稍后重试",
  );
}

// ============================ 命令注册 ============================

cli({
  site: SITE,
  name: "login-tzzb",
  description:
    "自动登录同花顺账号中心（upass.10jqka.com.cn）：切到密码登录，浏览器自动填充记住的用户名/密码后点击登录；出现滑块安全验证时自动识别拼图缺口并拖动通过",
  access: "write",
  example:
    "opencli stock login-tzzb                          # 浏览器记住的凭据 + 自动滑块\nopencli stock login-tzzb --user u --pass p        # 命令行凭据覆盖\nopencli stock login-tzzb --wait-manual 30         # 等待人工填写凭据后自动继续",
  domain: LOGIN_HOST,
  strategy: Strategy.UI,
  browser: true,
  // Chrome 对隐藏/遮挡窗口拒绝可信输入（autofill、点击、拖动），强制前台。
  defaultWindowMode: "foreground",
  // 持久会话：登录后保留 tab，同花顺 Cookie 供后续 sync 复用。
  siteSession: "persistent",
  args: [
    { name: "user", type: "string", default: "", help: "用户名；缺省使用浏览器记住的凭据" },
    { name: "pass", type: "string", default: "", help: "密码；缺省使用浏览器记住的凭据" },
    { name: "wait-manual", type: "int", default: 0, help: "浏览器未自动填充时等待人工输入凭据的秒数（默认 0=不等待）" },
    { name: "max-attempts", type: "int", default: 3, help: "单轮滑块验证的最大拖动次数（1-6）" },
    { name: "timeout", type: "int", default: 180, help: "整条命令超时秒数（登录跳转 + 滑块全程，默认 180）" },
  ],
  columns: ["status", "user", "credentialSource", "sliderAttempts", "finalUrl"],
  func: async (page, kwargs) => {
    const user = String(kwargs.user || "").trim();
    const pass = String(kwargs.pass || "");
    if ((user && !pass) || (!user && pass)) {
      throw new ArgumentError("user 与 pass 必须同时提供，或都省略以使用浏览器记住的凭据");
    }
    const manualWaitSec = Math.max(0, Math.min(600, Number(kwargs["wait-manual"]) || 0));
    const maxAttempts = Number(kwargs["max-attempts"]);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6) {
      throw new ArgumentError("max-attempts must be an integer between 1 and 6");
    }

    const result = (status, detectedUser, credentialSource, sliderAttempts, finalUrl) => [{
      status,
      user: detectedUser || user,
      credentialSource,
      sliderAttempts,
      finalUrl,
    }];

    log.info(`打开 ${LOGIN_URL}`);
    await page.goto(LOGIN_URL);
    // 复用持久会话时，上一次运行的标签页可能已被回收，首次 evaluate 会报
    // “stale page identity”；清掉缓存的活动页再导航一次即可恢复。
    try {
      await page.evaluate("location.href");
    } catch (e) {
      if (/stale page identity|Page not found/i.test(String((e && e.message) || e))) {
        log.warn("浏览器标签页已失效，重新打开登录页…");
        try { page.setActivePage?.(undefined); } catch { /* ignore */ }
        await page.goto(LOGIN_URL);
      }
    }

    const startUrl = await liveUrl(page);
    if (startUrl && !isLoginUrl(startUrl)) {
      log.success(`已在登录状态：${startUrl}`);
      return result("already_logged_in", "", "none", 0, startUrl);
    }

    // 等待登录页就绪（并确认未被重定向走）
    const ready = await waitUntil(page, LOGIN_PAGE_WAIT_MS, async () => {
      const url = await liveUrl(page);
      if (url && !isLoginUrl(url)) return { redirected: url };
      return (await isVisible(page, SEL.tab)) ? { ready: true } : null;
    }, 500);
    if (ready?.redirected) {
      log.success(`已在登录状态：${ready.redirected}`);
      return result("already_logged_in", "", "none", 0, ready.redirected);
    }
    if (!ready) {
      throw new CommandExecutionError(
        `未能定位同花顺登录页（${LOGIN_URL}），当前页面: ${(await liveUrl(page)).slice(0, 160) || "未知"}`,
        "请确认网络可访问 upass.10jqka.com.cn，且浏览器扩展/调试桥已连接",
      );
    }

    await ensureVisible(page, "切换到密码登录");

    // ---- 第 1 步：切到密码登录 + 凭据 ----
    log.info("切换到「密码登录」…");
    await clickNative(page, SEL.tab);
    const panel = await waitPanelStable(page);
    if (!panel) {
      const navigated = await liveUrl(page);
      if (navigated && !isLoginUrl(navigated)) {
        log.success(`点击切换后已跳离登录页（视为已登录）：${navigated}`);
        return result("already_logged_in", "", "none", 0, navigated);
      }
      const dom = await probeLoginDom(page);
      throw new CommandExecutionError(
        `密码登录面板未稳定出现（#uname 尺寸仍为 0）：${JSON.stringify(dom)}`,
        "登录页可能改版、被重定向，或切换标签被浮层拦截",
      );
    }

    const { credentialSource, detectedUser } = await ensureCredentials(page, {
      user, pass, manualWaitSec,
    });

    if (!(await isSubmitEnabled(page))) {
      await nudgeInputs(page);
      await page.sleep(0.3);
    }
    if (!(await isSubmitEnabled(page))) {
      throw new CommandExecutionError(
        "登录按钮未启用（用户名/密码可能未真正写入输入框）",
        "请确认浏览器自动填充的是本页面表单，或改用 --user/--pass 显式登录",
      );
    }

    // ---- 提交登录 ----
    await ensureVisible(page, "点击登录");
    log.info("点击登录…");
    const reqBefore = await countRequests(page);
    await clickNative(page, SEL.submit);
    await page.sleep(1.5);
    const reqAfter = await countRequests(page);
    if (reqAfter <= reqBefore) {
      // 该页把提交绑在 JS 事件上，CDP 点击偶尔不生效，补一次 JS click
      log.info("CDP 点击未触发登录请求，改用 JS 点击…");
      await page
        .evaluate(`(() => { const b = document.querySelector(${JSON.stringify(SEL.submit)}); if (b) b.click(); return true; })()`)
        .catch(() => {});
    }

    // ---- 第 2 步：滑块验证 / 登录结果 ----
    const { finalUrl, sliderAttempts } = await waitForLoginOutcome(page, { maxAttempts });
    return result("logged_in", detectedUser, credentialSource, sliderAttempts, finalUrl);
  },
});
