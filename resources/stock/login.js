/**
 * opencli schwab login —— 自动登录嘉信理财（client.schwab.com）
 *
 * 登录分两步：
 *   第 1 步 用户名+密码：从 ~/.duckdb/stock/stock.config 读取 SCHWAB_USERNAME /
 *            SCHWAB_PASSWORD 自动填写（也可 --user/--pass 覆盖，或 --wait-manual
 *            等待人工在浏览器窗口点选保存的密码后自动继续）。
 *   第 2 步 OTP 验证码：从同一配置文件读取 SCHWAB_SCRET（base32）生成 TOTP
 *            自动填入（纯本地 HMAC-SHA1 计算，不依赖外部服务）。
 *
 * 配置文件格式（一行一个）：
 *   SCHWAB_USERNAME=fhn100
 *   SCHWAB_PASSWORD=******
 *   SCHWAB_SCRET=ATZGYEQ7...（base32 TOTP 密钥）
 *
 * 说明：Chromium 在 debugger/CDP 附加的自动化标签页中会抑制跨域 iframe 的密码
 * 自动填充下拉（安全行为）。本插件默认直接用配置文件中的凭据，不依赖浏览器 autofill。
 */
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================ 常量 ============================

const SITE = "schwab";
const LOGIN_URL = "https://client.schwab.com/Areas/Access/Login?lang=zh-cn";
const GATEWAY_HOST = "sws-gateway-nr.schwab.com";
// 统一配置文件（用户名 / 密码 / TOTP 密钥）
const DEFAULT_CONFIG_FILE = join(homedir(), ".duckdb", "stock", "stock.config");
const CFG_KEY_USER = "SCHWAB_USERNAME";
const CFG_KEY_PASS = "SCHWAB_PASSWORD";
const CFG_KEY_SECRET = "SCHWAB_SCRET";
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

/** 解析 key=value 行格式配置文件，返回键值 map */
function readKeyValueConfig(file) {
  if (!existsSync(file)) {
    throw new CommandExecutionError(
      `配置文件不存在: ${file}`,
      `请创建并写入:\n${CFG_KEY_USER}=<用户名>\n${CFG_KEY_PASS}=<密码>\n${CFG_KEY_SECRET}=<BASE32 密钥>\n或用命令行参数 --user/--pass/--secret 覆盖`,
    );
  }
  const map = {};
  for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return map;
}

/** 从统一配置文件读指定键；缺失时给出清晰报错 */
function readConfigValue(configMap, key, file) {
  const v = configMap[key];
  if (!v) {
    throw new CommandExecutionError(
      `配置文件中未找到键 ${JSON.stringify(key)}（文件: ${file}）`,
      `现有键: ${Object.keys(configMap).join(", ") || "（空）"}；请补齐 ${key}=<value>`,
    );
  }
  return v;
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

// ============================ 验证码页定位（OTP） ============================

// 验证码输入框多种形态（chunk 分析 + 实测确认）：
//   otp 模块        → #securityCode（Angular otp 页）
//   placeholder 页  → #placeholderCode（页面整体跳到 sws-gateway #/placeholder，
//                     容器 lms-placeholder-container ；点击登入后浏览器自动跳转到的
//                     “确认您的身份”验证码页即此形态）
const SECURITY_CODE_ID = "#securityCode, #placeholderCode";
const SECURITY_CODE_EL =
  'lms-totp input, lms-totp-container input, lms-totp-presenter input, lms-otp-security-code input, lms-placeholder-code input, lms-placeholder-container input';
const SECURITY_CODE_PROBE = `(() => {
  if (document.querySelector('${SECURITY_CODE_ID}')) return 'id';
  if (document.querySelector('${SECURITY_CODE_EL}')) return 'el';
  return '';
})()`;

const DOM_SNAPSHOT = `(() => {
  const out = [];
  const visit = (doc, label, depth) => {
    if (depth > 2 || out.length > 24) return;
    const parts = [];
    const seen = new Set();
    const push = (e) => {
      if (seen.has(e) || parts.length >= 40) return;
      seen.add(e);
      const tag = e.tagName.toLowerCase();
      const id = e.id ? '#' + e.id : '';
      const ty = e.getAttribute && e.getAttribute('type');
      const ph = e.getAttribute && e.getAttribute('placeholder');
      const cls = e.className && typeof e.className === 'string'
        ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      parts.push(tag + id + cls + (ty ? '[type=' + ty + ']' : '') + (ph ? '[ph=' + ph + ']' : ''));
    };
    doc.querySelectorAll('input, button, select, [role="button"], iframe').forEach(push);
    doc.querySelectorAll('*').forEach((h) => {
      if (h.shadowRoot) { push(h); visit(h.shadowRoot, label + '/shadow', depth + 1); }
    });
    out.push(label + ' ⇒ ' + (parts.join(', ').slice(0, 1200) || '（无关键元素）'));
    doc.querySelectorAll('iframe').forEach((f, i) => {
      try { if (f.contentDocument) visit(f.contentDocument, label + '>iframe#' + i + '(' + (f.id || f.name || '') + ')', depth + 1); }
      catch (e) { out.push(label + '>iframe#' + i + ' 跨域不可入'); }
    });
  };
  visit(document, 'self', 0);
  return out.join('\\n').slice(0, 4000);
})()`;

/** 一次性诊断：点击登入后仍未定位验证码框时，打印页面/frame/DOM 实况 */
async function dumpLoginTransition(page, frameIndex) {
  try {
    const fr = await listFrames(page);
    log.info(`[诊断] 主文档: ${await pageUrl(page)}`);
    log.info(`[诊断] 跨域 frames: ${fr.map((f) => `${f.index}:${String(f.url).slice(0, 110)}`).join("\n              ") || "（无）"}`);
    log.info(`[诊断] 主文档 DOM:\n${await page.evaluate(DOM_SNAPSHOT).catch(() => "(主文档评估失败)")}`);
    for (const f of fr) {
      log.info(`[诊断] frame[${f.index}] DOM:\n${await page.evaluateInFrame(DOM_SNAPSHOT, f.index).catch((e) => `(评估失败: ${String(e.message).slice(0, 120)})`)}`);
    }
    if (frameIndex >= 0) log.info(`[诊断] 旧登录 iframe 索引: ${frameIndex}（现有 ${fr.length} 个跨域 frame）`);
  } catch (e) {
    log.warn(`[诊断] 采集失败: ${String(e.message).slice(0, 160)}`);
  }
}

/**
 * 定位验证码输入框所在上下文。返回 { kind: 'page' | 'frame', index, mode: 'id' | 'el' }
 * 或 null。点击登入后浏览器会自动跳转，主文档可能直接切到 sws-gateway（不再有 lmsIframe），
 * 因此依次探测：指定 gateway frame → 主文档 → 全部跨域 frames。
 */
async function locateSecurityCode(page, preferredFrame) {
  // 注意：page.evaluate(string) 不接受第二个参数（SDK 对 args.length>0 直接抛错），
  // 因此一律包装成单参函数，避免把 undefined 当 args 传入。
  const probe = async (run) => {
    try {
      return String(await run(SECURITY_CODE_PROBE)) || "";
    } catch {
      return "";
    }
  };
  // 1) 指定 gateway frame
  if (preferredFrame >= 0) {
    const m = await probe((code) => page.evaluateInFrame(code, preferredFrame));
    if (m) return { kind: "frame", index: preferredFrame, mode: m };
  }
  // 2) 主文档（页面可能整体跳转到 sws-gateway host）
  {
    const m = await probe((code) => page.evaluate(code));
    if (m) return { kind: "page", index: -1, mode: m };
  }
  // 3) 全部跨域 frames 兜底
  try {
    const frames = await listFrames(page);
    for (let i = 0; i < frames.length; i += 1) {
      if (preferredFrame >= 0 && i === preferredFrame) continue;
      const m = await probe((code) => page.evaluateInFrame(code, i));
      if (m) return { kind: "frame", index: i, mode: m };
    }
  } catch { /* ignore */ }
  return null;
}

function securityCodeSelector(ctx) {
  return ctx.mode === "id" ? SECURITY_CODE_ID : SECURITY_CODE_EL;
}

/** 在指定上下文（page 或 frame）执行 evaluateWithArgs 风格代码 */
async function evalIn(page, ctx, code) {
  if (ctx.kind === "frame") return page.evaluateInFrame(code, ctx.index);
  return page.evaluate(code);
}

/** 在指定上下文向元素输入文本（优先 CDP native insertText，回退 Angular 兼容 setter） */
async function typeIntoSelector(page, ctx, selector, text) {
  const sel = JSON.stringify(selector);
  await evalIn(
    page,
    ctx,
    `(() => {
      const el = document.querySelector(${sel});
      if (!el) throw new Error('元素不存在: ' + ${sel});
      el.focus();
      el.click();
      return true;
    })()`,
  );
  try {
    await page.cdp("Input.insertText", { text: String(text) });
  } catch {
    await evalIn(
      page,
      ctx,
      `(() => {
        const el = document.querySelector(${sel});
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(text))});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
  }
  let back = "";
  try {
    back = String(await evalIn(page, ctx, `(() => (document.querySelector(${sel}) || {}).value || '')()`)) || "";
  } catch { /* ignore */ }
  return { ok: back === String(text), actual: back };
}

/** 在指定上下文点击元素（优先原生坐标点击，回退 JS click） */
async function clickInSelector(page, ctx, selector) {
  const sel = JSON.stringify(selector);
  // 原生坐标点击（iframe 内元素需叠加 iframe 偏移；主文档直接用视口坐标）
  try {
    if (ctx.kind === "frame") {
      const pos = await elementViewportCenter(page, ctx.index, selector);
      if (pos) {
        await nativeClickAt(page, pos.x, pos.y);
        return;
      }
    } else {
      const pos = await page.evaluate(
        `(() => {
          const el = document.querySelector(${sel});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
      );
      if (pos?.x != null) {
        await nativeClickAt(page, pos.x, pos.y);
        return;
      }
    }
  } catch { /* fall through to JS click */ }
  await evalIn(
    page,
    ctx,
    `(() => {
      const el = document.querySelector(${sel});
      if (!el) throw new Error('元素不存在: ' + ${sel});
      el.click();
      return true;
    })()`,
  );
}

/** 最终登录成功 = 已到达客户主站（client.schwab.com / www.schwab.com 非登录路径） */
function isFinalLoggedInUrl(url) {
  const u = String(url || "");
  if (isLoginPage(u)) return false;
  // 仍在中转域（sws-gateway）或中转路由 → 未完成
  if (/sws-gateway/i.test(u)) return false;
  return /client\.schwab\.com|www\.schwab\.com/i.test(u);
}

/** 在验证码所在上下文读取错误文案 */
async function readFormErrorAnywhere(page, ctx) {
  const base = readFormError(page, ctx.index);
  if (ctx.kind === "page" || ctx.index < 0) {
    try {
      const t = await page.evaluate(
        `(() => {
          const sels = ['.error', '[role="alert"]', '.sdps-form-element__error', '.access-code-wrapper .sdps-form-element__error', 'lms-messenger', '#messenger', '.sdps-notification[type="error"]', 'sdps-form-element__error'];
          const out = [];
          for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
              const t = (el.textContent || '').trim();
              if (t && out.indexOf(t) < 0) out.push(t);
            }
          }
          return out.join(' | ').slice(0, 400);
        })()`,
      );
      const s = String(t || "").trim();
      if (s) return s;
    } catch { /* ignore */ }
  }
  return base;
}

/**
 * 填写 TOTP 验证码并提交（处理可能的验证方式选择页），循环重试 maxAttempts 次。
 * 成功（主站 / 页面离开验证码页）返回 true；全部失败返回 false。
 */
async function submitSecurityCodes(page, ctx, maxAttempts, resolveSecret, hooks = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await ensurePageVisible(page);
    // 验证方式选择页（多 target）：选第一个（通常是 Symantec/验证器 TOTP）
    try {
      const hasTargets = await evalIn(
        page,
        ctx,
        `(() => !!(document.querySelector('lms-otp-target-options input[type="radio"]')))()`,
      );
      if (hasTargets) {
        await evalIn(
          page,
          ctx,
          `(() => {
            const el = document.querySelector('lms-otp-target-options input[type="radio"]');
            if (el && !el.checked) el.click();
            return !!el;
          })()`,
        );
        // 目标选择页的“继续”按钮：continueButton / Continue 按钮
        try {
          await clickInSelector(page, ctx, "#continueButton");
        } catch {
          await clickInSelector(page, ctx, 'button[type="submit"], button[class*="primary"]');
        }
        await page.sleep(0.8);
      }
    } catch { /* 无 target 选择页 */ }

    // 若页面已离开验证码页（跳转成功/报错跳回），交给外层轮询判断
    const stillThere = await locateSecurityCode(page, ctx.kind === "frame" ? ctx.index : undefined);
    if (!stillThere) {
      const u = await pageUrl(page);
      return isFinalLoggedInUrl(u);
    }
    const codeCtx = stillThere;
    const sel = securityCodeSelector(codeCtx);

    // TOTP 码：时间窗临近到期（<5s）直接用下一周期码
    const secondsLeft = OTP_PERIOD - (Math.floor(Date.now() / 1000) % OTP_PERIOD);
    const otpCode = totp(resolveSecret(), { periodsAhead: secondsLeft < 5 ? 1 : 0 });
    hooks.onAttempt?.(attempt);
    const typed = await typeIntoSelector(page, codeCtx, sel, otpCode);
    if (!typed.ok) {
      throw new CommandExecutionError(`OTP 验证码填写失败（回读 ${JSON.stringify(typed.actual)}）`);
    }
    // 提交验证码：优先 Continue / 登入按钮，回退任意主要按钮
    try {
      await clickInSelector(page, codeCtx, "#continueButton");
    } catch {
      await clickInSelector(page, codeCtx, 'button[type="submit"], button[class*="primary"], #btnLogin');
    }
    // 提交后自适应等待服务器响应：嘉信校验往返可能 >1s，固定短等待会把
    // 「还在处理中」误判成「未通过」，白白消耗重试次数。
    let errText = "";
    for (let waited = 0; waited < 10_000; waited += 400) {
      await page.sleep(0.4);
      const u = await pageUrl(page);
      if (isFinalLoggedInUrl(u)) return true;
      errText = await readFormErrorAnywhere(page, codeCtx);
      if (errText) break;
      const still = await locateSecurityCode(page, codeCtx.kind === "frame" ? codeCtx.index : -1);
      if (!still) break; // 已离开验证码页（跳转/换形态中），交由后续流程判断
    }
    if (attempt < maxAttempts) {
      hooks.onRetry?.(errText || "页面仍停留");
      // 清空旧码以便填入新码
      try {
        await evalIn(
          page,
          codeCtx,
          `(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
          })()`,
        );
      } catch { /* ignore */ }
      await page.sleep(0.6);
    } else {
      hooks.onExhausted?.(errText || "无可见错误");
    }
  }
  return false;
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
    "自动登录嘉信理财（client.schwab.com，两步）：凭据/密钥统一从 ~/.duckdb/stock/stock.config 读取（SCHWAB_USERNAME / SCHWAB_PASSWORD / SCHWAB_SCRET），也可 --user/--pass/--secret 覆盖；TOTP 验证码自动填入",
  access: "write",
  example:
    "opencli schwab login                           # 配置文件凭据 + TOTP 自动登录\nopencli schwab login --user u --pass p            # 命令行凭据覆盖配置\nopencli schwab login --wait-manual                # 人工在窗口点选保存的密码，自动继续\nopencli schwab login --config /path/to/stock.config",
  domain: "client.schwab.com",
  strategy: Strategy.UI,
  browser: true,
  // 原生输入（autofill 下拉、点击）在窗口被遮挡/未聚焦时会被 Chrome 拒绝，强制前台。
  defaultWindowMode: "foreground",
  // 持久站点会话：成功后保留已登录标签页（ephemeral 会在命令结束时关闭 tab，
  // 表现为跳转成功后只剩空白窗口），后续 schwab 命令可直接复用该会话。
  siteSession: "persistent",
  args: [
    { name: "user", type: "string", default: "", help: `用户名；缺省读配置文件 ${CFG_KEY_USER}` },
    { name: "pass", type: "string", default: "", help: `密码；缺省读配置文件 ${CFG_KEY_PASS}` },
    { name: "config", type: "string", default: DEFAULT_CONFIG_FILE, help: `配置文件路径（默认 ${DEFAULT_CONFIG_FILE}）` },
    { name: "wait-manual", type: "int", default: 0, help: `凭据不可用时等待人工在浏览器窗口填充的秒数（默认 0=不等待，>0 启用）` },
    { name: "secret", type: "string", default: "", help: `TOTP base32 密钥；缺省读配置文件 ${CFG_KEY_SECRET}` },
    { name: "max-attempts", type: "int", default: 3, help: "OTP 验证码提交的最大重试次数（1-6），每次自动生成新码" },
    // 声明 timeout 参数后 opencli 框架按此值下发整条命令的 deadline；
    // 缺省值必须覆盖「点击登入 → 嘉信慢跳转（实测可达 90s）→ OTP 页渲染 → 提交重试」全程
    // （框架默认 60s 会在跳转中途杀进程，表现为浏览器停在验证码页但脚本不再填码）。
    { name: "timeout", type: "int", default: 240, help: "整条命令超时秒数（嘉信跳转+OTP 全程，默认 240）" },
  ],
  columns: ["status", "user", "credentialSource", "otpAttempts", "finalUrl"],
  func: async (page, kwargs) => {
    const manualWait = Math.max(0, Math.min(600, Number(kwargs["wait-manual"]) || 0));
    const maxAttempts = Math.max(1, Math.min(6, Number(kwargs["max-attempts"]) || 3));
    const configFile = String(kwargs.config || DEFAULT_CONFIG_FILE).trim();

    // 统一配置：命令行参数 > 配置文件（用户名/密码/密钥）
    const config = readKeyValueConfig(configFile);
    const user = String(kwargs.user || "").trim() || readConfigValue(config, CFG_KEY_USER, configFile);
    const pass = String(kwargs.pass || "")
      || readConfigValue(config, CFG_KEY_PASS, configFile);
    const explicitSecret = String(kwargs.secret || "").trim();
    let secretCache = null;
    const resolveSecret = () => {
      if (secretCache === null) {
        secretCache = explicitSecret || readConfigValue(config, CFG_KEY_SECRET, configFile);
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
    // 配置已提供凭据 → 直接填写（最可靠，不依赖浏览器 autofill）。
    // 若凭据为空（理论上不会走到这，因 readConfigValue 已强制），才退化到
    // 浏览器保存凭据 / 人工等待。
    let credentialSource = "config";
    if (user && pass) {
      log.info(`使用配置文件/命令行凭据填写表单（用户：${user}）…`);
      const r1 = await typeIntoFrame(page, frameIndex, "#loginIdInput", user);
      if (!r1.ok) throw new CommandExecutionError(`用户名填写失败（回读 ${JSON.stringify(r1.actual)}）`);
      const r2 = await typeIntoFrame(page, frameIndex, "#passwordInput", pass);
      if (!r2.ok) throw new CommandExecutionError(`密码填写失败（回读 ${JSON.stringify(r2.actual)}）`);
    } else {
      // 兜底：原生点击用户名输入框 → 触发浏览器保存的凭据下拉 → 键盘选择
      log.info("点击用户名输入框，尝试调用浏览器保存的凭据…");
      const pos = await elementViewportCenter(page, frameIndex, "#loginIdInput");
      if (!pos) throw new CommandExecutionError("无法计算用户名输入框坐标");
      await nativeClickAt(page, pos.x, pos.y);
      await page.sleep(0.8);
      let creds = await readFrameCredentials(page, frameIndex);
      if (!creds.u || !creds.p) {
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
            `请检查配置文件 ${configFile} 的 ${CFG_KEY_USER}/${CFG_KEY_PASS}，或改用 --user/--pass`,
          );
        }
      } else {
        throw new CommandExecutionError(
          "浏览器保存的凭据未能自动填充（用户名/密码为空）",
          `请检查配置文件 ${configFile} 的 ${CFG_KEY_USER}/${CFG_KEY_PASS}，或用 --user/--pass 显式登录`,
        );
      }
    }

    // ---- 提交登录（第 1 步表单） ----
    await ensurePageVisible(page);
    log.info("点击登入，等待浏览器跳转…");
    await clickInFrame(page, frameIndex, "#btnLogin");

    // 提交后浏览器自动跳转：登录页 → sws-gateway 中转 → （可能）验证码页 → 客户主站。
    // 状态机：
    //   登录页/中转页  → 等待跳转
    //   出现 #securityCode  → 填 TOTP 并提交
    //   到达 client.schwab.com 非登录页 → 成功
    let otpAttempts = 0;
    let loginDone = false;
    let lastError = "";
    let diagnosed = false;
    let otpHostSince = 0;
    let pollIter = 0;
    const pollStart = Date.now();
    // 实测嘉信点击登入后到 #/placeholder 出现可能耗时 60-90s，输入框渲染更晚；
    // 轮询窗口必须覆盖「慢跳转 + OTP 页渲染 + 多次提交重试」全程。
    const TOTAL_WAIT_MS = 150 * 1000;

    while (!loginDone && Date.now() - pollStart < TOTAL_WAIT_MS) {
      // 1) 是否已到达客户主站
      const curUrl = await pageUrl(page);
      if (isFinalLoggedInUrl(curUrl)) {
        loginDone = true;
        log.success(`登录成功：${curUrl}`);
        return done("logged_in", credentialSource, otpAttempts, curUrl, detectedUser || user);
      }
      // 2) 验证码页检测。安全码有时效（TOTP 30s 窗口），跳转一完成就要立即填码：
      //    快路径 = 单次 exec 只探主文档（实测 placeholder 页输入框在主文档，且是整页跳转）；
      //    慢路径 = 每 4 轮做一次全 frame 扫描（兼容验证码在 iframe 内的形态）。
      let codeCtx = null;
      try {
        const m = String(await page.evaluate(SECURITY_CODE_PROBE) || "");
        if (m) codeCtx = { kind: "page", index: -1, mode: m };
      } catch { /* 导航切换中，上下文暂不可用 */ }
      let liveFrame = -1;
      if (!codeCtx && pollIter % 4 === 1) {
        liveFrame = gatewayFrameIndex(await listFrames(page));
        codeCtx = await locateSecurityCode(page, liveFrame);
      }
      pollIter += 1;
      if (codeCtx) {
        log.info(`检测到验证码输入框（${codeCtx.kind === "page" ? "主文档" : `iframe[${codeCtx.index}]`}）`);
        const ok = await submitSecurityCodes(page, codeCtx, maxAttempts, resolveSecret, {
          onAttempt: () => {
            otpAttempts += 1;
            log.info(`提交 OTP（第 ${otpAttempts}/${maxAttempts} 次）…`);
          },
          onRetry: (reason) => log.warn(`OTP 未通过：${reason || "页面仍停留"}，清空重试…`),
          onExhausted: (reason) => { lastError = reason || "OTP 提交失败"; },
        });
        if (ok) {
          loginDone = true;
          const u = await pageUrl(page);
          log.success(`登录成功：${u}`);
          return done("logged_in", credentialSource, otpAttempts, u, detectedUser || user);
        }
      }
      // 停在 placeholder/验证页 15s 仍找不到输入框 → 打印一次实况诊断（勿高频，拖慢轮询）
      if (/#\/placeholder|challenge|otp|verify|securitycode/i.test(curUrl)) {
        if (!otpHostSince) otpHostSince = Date.now();
        if (!diagnosed && !codeCtx && Date.now() - otpHostSince > 15000) {
          diagnosed = true;
          log.info("[诊断] 验证码页迟迟未出现输入框，采集 DOM 实况…");
          await dumpLoginTransition(page, liveFrame);
        }
      }
      // 3) 登录页出现错误 → 终止
      const errText = await readFormError(page, frameIndex);
      if (errText) {
        lastError = errText;
        if (FATAL_ERROR_RE.test(errText)) {
          throw new AuthRequiredError(
            "client.schwab.com",
            `嘉信登录被服务器拒绝: ${errText}`,
            "请核对配置文件中 SCHWAB_PASSWORD 密码、SCHWAB_SCRET 密钥；不要盲目重试以免锁定",
          );
        }
      }
      // 快路径每轮仅 1-2 次轻量 exec，短间隔以尽早捕捉输入框渲染（TOTP 时效敏感）
      await page.sleep(0.3);
    }

    if (!loginDone) {
      const finalUrl = await pageUrl(page);
      if (isFinalLoggedInUrl(finalUrl)) {
        return done("logged_in", credentialSource, otpAttempts, finalUrl, detectedUser || user);
      }
      throw new CommandExecutionError(
        `登录未完成（${Date.now() - pollStart < TOTAL_WAIT_MS ? "状态异常" : "等待跳转超时"}）; 页面: ${finalUrl.slice(0, 120)}`,
        lastError
          ? `最后原因: ${lastError}`
          : "点击登入后浏览器未跳转，可能是网络/服务器异常，可重试一次",
      );
    }
  },
});
