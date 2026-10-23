/**
 * opencli schwab login —— 自动登录嘉信理财（client.schwab.com）
 *
 * 登录分两步：
 *   第 1 步 用户名+密码：优先点击用户名输入框触发浏览器保存的凭据（autofill 下拉
 *            + 键盘选择）；也可 --user/--pass 显式传入；或 --wait-manual 等待人工
 *            在浏览器窗口手动点击选中保存的密码后自动继续。
 *   第 2 步 OTP 验证码：从 ~/.config/.otop（键 schwab）读取 base32 密钥生成 TOTP
 *            自动填入（纯本地 HMAC-SHA1 计算，不依赖外部服务）。
 *
 * 说明：Chromium 在 debugger/CDP 附加的自动化标签页中会抑制跨域 iframe 的密码
 * 自动填充下拉（安全行为）。若 autofill 未触发，请用 --user/--pass 或 --wait-manual。
 */
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================ 常量 ============================

const SITE = "schwab";
const LOGIN_URL = "https://client.schwab.com/Areas/Access/Login?lang=zh-cn";
const GATEWAY_HOST = "sws-gateway-nr.schwab.com";
const DEFAULT_OTOP_FILE = join(homedir(), ".config", ".otop");
const DEFAULT_OTP_KEY = "schwab";
const OTP_LEN = 6;
const OTP_PERIOD = 30;
const DEFAULT_MANUAL_WAIT = 90; // 秒，等待用户手动填充凭据

// 密码填错/账号被锁不会自我恢复，重试只会延长锁定 —— 命中即终止。
const FATAL_ERROR_RE =
  /密码不正确|用户名或密码|帐户?已锁|账号?已锁|锁定时段|多次尝试|too many|l?ock(ed)?|incorrect (user|password|credentials)|invalid (user|password|credentials)/i;

// 登录成功 = 主文档离开该登录页
const isLoginPage = (url) => /\/Areas\/Access\/Login/.test(String(url || ""));

// ============================ TOTP（纯 Node 实现） ============================

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret) {
  let bits = "";
  for (const ch of String(secret).toUpperCase().replace(/=+$/g, "")) {
    const v = BASE32_CHARS.indexOf(ch);
    if (v < 0) throw new Error(`无法解码 base32 密钥（非法字符 "${ch}"）`);
    bits += v.toString(2).padStart(5, "0");
  }
  bits = bits.slice(0, Math.floor(bits.length / 8) * 8);
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, { period = OTP_PERIOD, digits = OTP_LEN, periodsAhead = 0 } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / period) + (periodsAhead || 0);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** 解析 key=value 行格式的 .otop 配置文件，取指定 key 的 base32 密钥 */
function readOtopSecret(file, key) {
  if (!existsSync(file)) {
    throw new CommandExecutionError(
      `OTP 配置文件不存在: ${file}`,
      `请先写入一行 ${key}=<BASE32_SECRET>，或用 --secret 直接传入密钥`,
    );
  }
  const map = {};
  for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  const secret = map[key];
  if (!secret) {
    throw new CommandExecutionError(
      `OTP 配置文件中未找到键 ${JSON.stringify(key)}（文件: ${file}）`,
      `现有键: ${Object.keys(map).join(", ") || "（空）"}；可追加一行 ${key}=<BASE32_SECRET>`,
    );
  }
  return secret;
}

// ============================ 原生输入 / iframe 工具 ============================

const KEY_VK = { Enter: 13, ArrowDown: 40, ArrowUp: 38, Tab: 9, Escape: 27, Backspace: 8, " ": 32 };

/** 浏览器级原生鼠标点击（坐标来自元素几何，可作用于跨域 iframe 内元素） */
async function nativeClickAt(page, x, y) {
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.sleep(0.12);
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.sleep(0.08);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

/** 浏览器级原生按键（用于操作 Chrome autofill 下拉框） */
async function nativeKeyPress(page, key) {
  const vk = KEY_VK[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await page.sleep(0.08);
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

async function listFrames(page) {
  try {
    return await page.frames();
  } catch {
    return [];
  }
}

/** 找到嘉信登录 widget 所在的跨域 iframe 索引 */
function gatewayFrameIndex(frames) {
  for (let i = 0; i < frames.length; i += 1) {
    const url = String(frames[i]?.url || "");
    const name = String(frames[i]?.name || "");
    if (url.includes(GATEWAY_HOST) || name === "lmsIframe") return i;
  }
  return -1;
}

async function waitFrameSelector(page, index, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await page.evaluateInFrame(
        `(() => !!(document.querySelector(${JSON.stringify(selector)})))()`,
        index,
      )) return true;
    } catch { /* frame may be loading */ }
    if (Date.now() > deadline) return false;
    await page.sleep(0.4);
  }
}

function waitForCondition(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return async (probe) => {
    for (;;) {
      let ok = false;
      try { ok = Boolean(await probe()); } catch { /* retry */ }
      if (ok) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 800));
    }
  };
}

/** 元素中心点在「主文档视口」里的坐标（iframe rect + iframe 内 rect） */
async function elementViewportCenter(page, index, selector) {
  const inner = await page.evaluateInFrame(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, found: true };
    })()`,
    index,
  );
  if (!inner?.found) return null;
  const framePos = await page.evaluate(
    `(() => {
      const f = document.getElementById('lmsIframe');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y };
    })()`,
  ).catch(() => null);
  if (!framePos) return null;
  return { x: framePos.x + inner.x, y: framePos.y + inner.y };
}

/** 点击 iframe 内元素：优先原生坐标点击，失败回退 JS click */
async function clickInFrame(page, index, selector) {
  const pos = await elementViewportCenter(page, index, selector);
  if (pos) {
    try {
      await nativeClickAt(page, pos.x, pos.y);
      return;
    } catch { /* fall through to JS click */ }
  }
  await page.evaluateInFrame(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('元素不存在: ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`,
    index,
  );
}

/**
 * 向 iframe 内输入框输入文本（优先 CDP 原生 insertText；
 * 回退 Angular 兼容的 value setter + input 事件）。
 */
async function typeIntoFrame(page, index, selector, text) {
  await page.evaluateInFrame(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('输入框不存在: ' + ${JSON.stringify(selector)});
      el.focus();
      el.click();
      return true;
    })()`,
    index,
  );
  try {
    await page.cdp("Input.insertText", { text: String(text) });
  } catch {
    await page.evaluateInFrame(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(text))});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      index,
    );
  }
  const back = await readFrameValue(page, index, selector);
  return { ok: back === String(text), actual: back };
}

async function readFrameValue(page, index, selector) {
  try {
    return String(await page.evaluateInFrame(
      `(() => (document.querySelector(${JSON.stringify(selector)}) || {}).value || '')()`,
      index,
    ) || "");
  } catch {
    return "";
  }
}

async function readFrameCredentials(page, index) {
  try {
    const r = await page.evaluateInFrame(
      `(() => ({
        u: (document.querySelector('#loginIdInput') || {}).value || '',
        p: (document.querySelector('#passwordInput') || {}).value || '',
        active: (document.activeElement || {}).id || '',
      }))()`,
      index,
    );
    return { u: String(r?.u || ""), p: String(r?.p || ""), active: String(r?.active || "") };
  } catch {
    return { u: "", p: "", active: "" };
  }
}

// ============================ 页面状态 ============================

async function pageUrl(page) {
  try {
    return String(await page.evaluate("location.href").catch(() => "") || "");
  } catch {
    return "";
  }
}

async function ensurePageVisible(page) {
  const vis = await page.evaluate("document.visibilityState").catch(() => "unknown");
  if (vis === "visible") return;
  log.warn(`浏览器页面当前不可见（${vis}），尝试恢复窗口…`);
  try {
    const win = await page.cdp?.("Browser.getWindowForTarget").catch(() => null);
    if (win?.windowId != null) {
      await page.cdp("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: "normal" } });
    }
    await page.sleep(0.6);
  } catch { /* best-effort */ }
}

/** 从 iframe 页面抓取可见错误文本 */
async function readFormError(page, index) {
  try {
    const text = await page.evaluateInFrame(
      `(() => {
        const sels = ['.error', '[role="alert"]', '.sdps-form-element__error', '.access-code-wrapper .sdps-form-element__error', '[data-testid*="error" i]', '.infomsg-margin', 'lms-messenger', '#messenger', '.sdps-notification[type="error"]'];
        const out = [];
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            const t = (el.textContent || '').trim();
            if (t && out.indexOf(t) < 0) out.push(t);
          }
        }
        return out.join(' | ').slice(0, 400);
      })()`,
      index,
    );
    return String(text || "").trim();
  } catch {
    return "";
  }
}

// ============================ 登录流程 ============================

cli({
  site: SITE,
  name: "login",
  description:
    "自动登录嘉信理财（client.schwab.com，两步）：第 1 步点击用户名输入框调用浏览器保存的凭据（或 --user/--pass 显式凭据 / --wait-manual 人工点击后自动继续）；第 2 步用 ~/.config/.otop 中 schwab 密钥生成 TOTP 验证码自动填入",
  access: "write",
  example:
    "opencli schwab login                           # 浏览器保存凭据 + .otop TOTP\nopencli schwab login --user u --pass p            # 显式凭据（最可靠）\nopencli schwab login --wait-manual                # 人工在窗口点选保存的密码，自动继续\nopencli schwab login --secret BASE32 --otp-key schwab",
  domain: "client.schwab.com",
  strategy: Strategy.UI,
  browser: true,
  // 原生输入（autofill 下拉、点击）在窗口被遮挡/未聚焦时会被 Chrome 拒绝，强制前台。
  defaultWindowMode: "foreground",
  // 每次全新 tab，避免陈旧焦点窗口。
  siteSession: "ephemeral",
  args: [
    { name: "user", type: "string", default: "", help: "用户名；缺省时尝试浏览器保存的凭据（autofill）" },
    { name: "pass", type: "string", default: "", help: "密码；缺省时使用浏览器保存的凭据" },
    { name: "wait-manual", type: "int", default: 0, help: `autofill 失败后等待人工在浏览器窗口填充凭据的秒数（默认 0=不等待，>0 启用）` },
    { name: "otop", type: "string", default: DEFAULT_OTOP_FILE, help: `OTP 密钥配置文件（默认 ${DEFAULT_OTOP_FILE}）` },
    { name: "otp-key", type: "string", default: DEFAULT_OTP_KEY, help: `配置文件中的键名（默认 ${DEFAULT_OTP_KEY}）` },
    { name: "secret", type: "string", default: "", help: "直接传入 TOTP base32 密钥，覆盖配置文件" },
    { name: "max-attempts", type: "int", default: 3, help: "OTP 验证码提交的最大重试次数（1-6），每次自动生成新码" },
  ],
  columns: ["status", "user", "credentialSource", "otpAttempts", "finalUrl"],
  func: async (page, kwargs) => {
    const user = String(kwargs.user || "").trim();
    const pass = String(kwargs.pass || "");
    if ((user && !pass) || (!user && pass)) {
      throw new ArgumentError("user 与 pass 必须成对提供（或都省略使用浏览器保存的凭据）");
    }
    const useManual = Boolean(user && pass);
    const manualWait = Math.max(0, Math.min(600, Number(kwargs["wait-manual"]) || 0));
    const maxAttempts = Math.max(1, Math.min(6, Number(kwargs["max-attempts"]) || 3));
    const otpKey = String(kwargs["otp-key"] || DEFAULT_OTP_KEY).trim();
    const otpFile = String(kwargs.otop || DEFAULT_OTOP_FILE).trim();
    // 显式凭据时不需要 TOTP 密钥也先不报错；只在走到 OTP 步时按需读取。
    const explicitSecret = String(kwargs.secret || "").trim();
    let secretCache = null;
    const resolveSecret = () => {
      if (secretCache === null) {
        secretCache = explicitSecret || readOtopSecret(otpFile, otpKey);
      }
      return secretCache;
    };

    let detectedUser = user;
    const done = (status, credentialSource, otpAttempts, url, u = "") =>
      [{ status, user: u || user, credentialSource, otpAttempts, finalUrl: url }];

    log.info(`打开 ${LOGIN_URL}`);
    await page.goto(LOGIN_URL);

    const startUrl = await pageUrl(page);
    if (!isLoginPage(startUrl)) {
      log.success("已在登录状态（页面已离开登录页）");
      return done("already_logged_in", "none", 0, startUrl);
    }

    // 关 OneTrust cookie 弹层（可能遮挡点击）
    try {
      await page.evaluate(
        `(() => {
          const btns = ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler'];
          for (const s of btns) {
            const b = document.querySelector(s);
            if (b) { b.click(); return 'ok'; }
          }
          const pc = document.getElementById('onetrust-pc-sdk');
          const filter = document.querySelector('.onetrust-pc-dark-filter');
          if (pc) pc.style.display = 'none';
          if (filter) filter.style.display = 'none';
          return 'closed';
        })()`,
      );
    } catch { /* ignore */ }

    // 等待登录 widget iframe 与用户名输入框就绪
    let frameIndex = -1;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      frameIndex = gatewayFrameIndex(await listFrames(page));
      if (frameIndex >= 0 && await waitFrameSelector(page, frameIndex, "#loginIdInput", 2000)) break;
      await page.sleep(0.5);
    }
    if (frameIndex < 0 || !(await waitFrameSelector(page, frameIndex, "#loginIdInput", 3000))) {
      const cur = await pageUrl(page);
      if (!isLoginPage(cur)) return done("already_logged_in", "none", 0, cur);
      throw new CommandExecutionError(
        `未能定位嘉信登录输入框（iframe ${GATEWAY_HOST} / #loginIdInput）`,
        "请确认登录页可访问，以及浏览器扩展/调试桥已连接",
      );
    }

    await ensurePageVisible(page);

    // ---- 第 1 步：用户名 + 密码 ----
    let credentialSource = "";
    if (useManual) {
      log.info("使用显式凭据填写表单…");
      const r1 = await typeIntoFrame(page, frameIndex, "#loginIdInput", user);
      if (!r1.ok) throw new CommandExecutionError(`用户名填写失败（回读 ${JSON.stringify(r1.actual)}）`);
      const r2 = await typeIntoFrame(page, frameIndex, "#passwordInput", pass);
      if (!r2.ok) throw new CommandExecutionError(`密码填写失败（回读 ${JSON.stringify(r2.actual)}）`);
      credentialSource = "manual";
    } else {
      // 方案 A：原生点击用户名输入框 → 触发浏览器保存的凭据下拉 → 键盘选择
      log.info("点击用户名输入框，尝试调用浏览器保存的凭据…");
      const pos = await elementViewportCenter(page, frameIndex, "#loginIdInput");
      if (!pos) throw new CommandExecutionError("无法计算用户名输入框坐标");
      await nativeClickAt(page, pos.x, pos.y);
      await page.sleep(0.8);
      let creds = await readFrameCredentials(page, frameIndex);
      if (!creds.u || !creds.p) {
        // 尝试键盘选择下拉第一项（若下拉已弹出）
        await nativeKeyPress(page, "ArrowDown");
        await page.sleep(0.4);
        await nativeKeyPress(page, "Enter");
        await page.sleep(0.8);
        creds = await readFrameCredentials(page, frameIndex);
      }
      if (creds.u && creds.p) {
        detectedUser = creds.u;
        credentialSource = "browser-saved";
        log.success(`浏览器保存的凭据已填充：${creds.u}`);
      } else if (manualWait > 0) {
        // 方案 B：等用户人工在浏览器窗口点击选择保存的密码
        log.warn(
          `未能在自动化中触发 autofill（Chromium 对调试标签页会抑制密码下拉）。` +
            `请在浏览器窗口点击登录页「用户名」输入框选择保存的凭据，` +
            `插件将在 ${manualWait} 秒内自动继续…`,
        );
        const wait = waitForCondition(manualWait * 1000);
        const filled = await wait(async () => {
          const c = await readFrameCredentials(page, frameIndex);
          return Boolean(c.u && c.p);
        });
        if (filled) {
          const c = await readFrameCredentials(page, frameIndex);
          detectedUser = c.u;
          credentialSource = "manual-wait";
          log.success(`检测到表单已填充：${c.u}`);
        } else {
          throw new CommandExecutionError(
            "等待人工填充超时（用户名/密码仍为空）",
            `请用 --user/--pass 显式传入凭据（最可靠），或先在浏览器手动保存嘉信密码后再试`,
          );
        }
      } else {
        throw new CommandExecutionError(
          "浏览器保存的凭据未能自动填充（用户名/密码为空）",
          "Chromium 对调试标签页会抑制密码自动填充下拉；请改用 --user/--pass 显式登录，或加 --wait-manual N 在浏览器窗口手动点选保存的密码",
        );
      }
    }

    // ---- 提交登录（第 1 步表单） ----
    await ensurePageVisible(page);
    await clickInFrame(page, frameIndex, "#btnLogin");

    // 轮询结果：离开登录页=成功；进入 OTP=走第 2 步；出现错误=失败
    let finalUrl = await pageUrl(page);
    let otpAttempts = 0;
    for (let i = 0; i < 40; i += 1) {
      finalUrl = await pageUrl(page);
      const hasCode = await page.evaluateInFrame(
        `(() => !!(document.querySelector('#securityCode')))()`,
        frameIndex,
      ).catch(() => false);
      if (!isLoginPage(finalUrl)) {
        if (otpAttempts === 0) log.success(`登录成功（无需 OTP）：${finalUrl}`);
        return done("logged_in", credentialSource, otpAttempts, finalUrl, detectedUser || user);
      }
      if (hasCode) {
        // ---- 第 2 步：OTP 验证码 ----
        log.info("进入第二步：OTP 验证码");
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          await ensurePageVisible(page);
          // 若出现验证方式选择（多 target），先选第一个（通常是 Symantec/验证器 TOTP）
          const hasTargets = await page.evaluateInFrame(
            `(() => !!(document.querySelector('lms-otp-target-options input[type="radio"]')))()`,
            frameIndex,
          ).catch(() => false);
          if (hasTargets) {
            const picked = await page.evaluateInFrame(
              `(() => {
                const el = document.querySelector('lms-otp-target-options input[type="radio"]');
                if (el && !el.checked) el.click();
                return !!el;
              })()`,
              frameIndex,
            );
            if (picked) {
              await clickInFrame(page, frameIndex, "#continueButton");
              await page.sleep(0.8);
              if (!(await waitFrameSelector(page, frameIndex, "#securityCode", 8000))) {
                throw new CommandExecutionError("登录第二步未出现验证码输入框（#securityCode）");
              }
            }
          }
          // TOTP 码动态生成：若当前时间窗临近到期（<5s），直接用下一个周期的码，
          // 避免刚提交就过期被拒。
          const secondsLeft = OTP_PERIOD - (Math.floor(Date.now() / 1000) % OTP_PERIOD);
          const otpCode = totp(resolveSecret(), { periodsAhead: secondsLeft < 5 ? 1 : 0 });
          log.info(`提交 OTP（第 ${attempt}/${maxAttempts} 次）…`);
          const typed = await typeIntoFrame(page, frameIndex, "#securityCode", otpCode);
          if (!typed.ok) {
            throw new CommandExecutionError(`OTP 验证码填写失败（回读 ${JSON.stringify(typed.actual)}）`);
          }
          await clickInFrame(page, frameIndex, "#continueButton");
          await page.sleep(1.2);

          finalUrl = await pageUrl(page);
          if (!isLoginPage(finalUrl)) {
            otpAttempts = attempt;
            log.success(`登录成功：${finalUrl}`);
            return done("logged_in", credentialSource, otpAttempts, finalUrl, detectedUser || user);
          }
          const err = await readFormError(page, frameIndex);
          if (err && FATAL_ERROR_RE.test(err)) {
            throw new AuthRequiredError(
              "client.schwab.com",
              `嘉信登录被服务器拒绝: ${err}`,
              "请核对 .otop 中 schwab 密钥、浏览器保存的密码或用 --user/--pass；不要盲目重试以免锁定",
            );
          }
          if (attempt < maxAttempts) {
            log.warn(`OTP 未通过：${err || "页面仍停留"}，清空重试…`);
            await page.evaluateInFrame(
              `(() => {
                const el = document.querySelector('#securityCode');
                if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
              })()`,
              frameIndex,
            ).catch(() => {});
            await page.sleep(0.5);
          }
        }
        throw new CommandExecutionError(
          `OTP 验证码提交 ${maxAttempts} 次仍未成功；最后页面错误: ${(await readFormError(page, frameIndex)) || "无"}`,
          "TOTP 每 30 秒轮换，重试时插件会自动生成新码；请核对 .otop 中的 schwab 密钥",
        );
      }
      await page.sleep(0.75);
    }

    const errText = await readFormError(page, frameIndex);
    if (errText && FATAL_ERROR_RE.test(errText)) {
      throw new AuthRequiredError(
        "client.schwab.com",
        `嘉信登录被服务器拒绝: ${errText}`,
        "请核对浏览器保存的密码或用 --user/--pass 传入正确凭据；不要盲目重试以免锁定",
      );
    }
    throw new CommandExecutionError(
      `登录未完成（仍在登录页）; 页面错误: ${errText || "无可见错误"}`,
      "服务器响应异常或登录流程有变，可重试一次",
    );
  },
});