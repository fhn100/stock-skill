/**
 * opencli stock login-schwab —— 自动登录嘉信理财（client.schwab.com）
 *
 * 登录分两步：
 *   第 1 步 用户名+密码：从 ~/.duckdb/stock/stock.config 读取 SCHWAB_USERNAME /
 *            SCHWAB_PASSWORD 自动填写（也可 --user/--pass 覆盖，或 --wait-manual
 *            等待人工在浏览器窗口点选保存的密码后自动继续）。
 *   第 2 步 OTP 验证码：从同一配置文件读取 SCHWAB_SECRET（base32；历史拼写错误键
 *            SCHWAB_SCRET 仍兼容）生成 TOTP 自动填入（纯本地 HMAC-SHA1 计算，
 *            不依赖外部服务）。
 *
 * 配置文件格式（一行一个）：
 *   SCHWAB_USERNAME=fhn100
 *   SCHWAB_PASSWORD=******
 *   SCHWAB_SECRET=ATZGYEQ7...（base32 TOTP 密钥）
 *
 * 说明：Chromium 在 debugger/CDP 附加的自动化标签页中会抑制跨域 iframe 的密码
 * 自动填充下拉（安全行为）。本插件默认直接用配置文件中的凭据，不依赖浏览器 autofill。
 *
 * 点击口径（2026-10-31 起）：提交类按钮（登入 / 验证码 Continue / 验证方式继续）一律
 * DOM click（见 clickInSelector）。CDP 坐标点击在嘉信登录页会被静默丢弃（坐标算对、无遮挡、
 * 页面可见也不落地），旧实现优先坐标点击导致「点了没反应 → 等满 150s 超时」。仅浏览器 UI
 * （autofill 下拉、方向键选择）仍用原生坐标点击/按键，存在于 fillFirstStep 的兜底分支。
 *
 * 结构：常量 → ctx 化浏览器原语（type/click/eval 同时作用于主文档与跨域 iframe）
 *       → 验证码定位/提交 → 流程步骤（waitForLoginFrame / fillFirstStep /
 *       runPostLoginPoll）→ cli() 注册。
 */
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================ 常量 ============================

const SITE = "stock";
const LOGIN_URL = "https://client.schwab.com/Areas/Access/Login?lang=zh-cn";
const GATEWAY_HOST = "sws-gateway-nr.schwab.com";
// 登录 widget iframe 的 id / name（两处匹配共用同一常量）
const FRAME_NAME = "lmsIframe";
// 统一配置文件（用户名 / 密码 / TOTP 密钥）
const DEFAULT_CONFIG_FILE = join(homedir(), ".duckdb", "stock", "stock.config");
const CFG_KEY_USER = "SCHWAB_USERNAME";
const CFG_KEY_PASS = "SCHWAB_PASSWORD";
const CFG_KEY_SECRET = "SCHWAB_SECRET";
// 历史拼写错误键（缺 S），配置文件仍兼容
const CFG_KEY_SECRET_LEGACY = "SCHWAB_SCRET";
const OTP_LEN = 6;
const OTP_PERIOD = 30;

// 登录 widget 元素选择器
const LOGIN_USER_SEL = "#loginIdInput";
const LOGIN_PASS_SEL = "#passwordInput";
const LOGIN_SUBMIT_SEL = "#btnLogin";

// 时间常量（毫秒；page.sleep 处换算为秒）
const LOGIN_FRAME_WAIT_MS = 30_000;      // 等待 iframe + 用户名输入框就绪总窗口
const FRAME_PROBE_FAST_MS = 2_000;       // 外层轮询内每轮的输入框探测窗口
const FRAME_PROBE_FINAL_MS = 3_000;      // 外层窗口耗尽后的最后一次确认
const POST_LOGIN_WAIT_MS = 150_000;      // 点击登入后状态机轮询总窗口（实测嘉信慢跳转可达 90s）
const OTP_SERVER_WAIT_MS = 10_000;       // 单次 OTP 提交后等待服务器响应窗口
const OTP_SERVER_POLL_MS = 400;
const CHALLENGE_DIAGNOSTIC_MS = 15_000;  // 停在验证页这么久仍无输入框 → 打印一次实况诊断
const FULL_SCAN_EVERY = 4;               // OTP 页检测每 N 轮做一次全 frame 扫描（慢路径）
const SUBMIT_CONFIRM_MS = 8_000;         // DOM 点击「登入」后的确认窗口：仅用于诊断，不再二次点击

// 密码填错/账号被锁不会自我恢复，重试只会延长锁定 —— 命中即终止。
// 「代号/密码无效」是嘉信中文站的实测拒绝文案（span.msg-error），旧正则会漏判成「未跳转」，
// 导致超时 + 盲目重试加深风控，必须一并覆盖。
const FATAL_ERROR_RE =
  /密码不正确|用户名或密码|帐户?已锁|账号?已锁|锁定时段|多次尝试|too many|l?ock(ed)?|(代号|用户名|密码|帐号|账号|凭据)[^。]{0,8}无效|incorrect (user|password|credentials)|invalid (user|password|credentials|login|id)/i;

// 登录成功 = 主文档离开该登录页
const isLoginPage = (url) => /\/Areas\/Access\/Login/.test(String(url || ""));

/** 最终登录成功 = 已到达客户主站（client.schwab.com / www.schwab.com 非登录路径） */
function isFinalLoggedInUrl(url) {
  const u = String(url || "");
  if (isLoginPage(u)) return false;
  // 仍在中转域（sws-gateway）或中转路由 → 未完成
  if (/sws-gateway/i.test(u)) return false;
  return /client\.schwab\.com|www\.schwab\.com/i.test(u);
}

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

/**
 * TOTP（RFC 6238）：HMAC-SHA1，默认 30s 窗口 / 6 位。
 * timestamp/periodsAhead 可注入，便于按标准向量自测。
 */
function totp(secret, { period = OTP_PERIOD, digits = OTP_LEN, periodsAhead = 0, timestamp = Date.now() } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / period) + (periodsAhead || 0);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

// ============================ 配置文件解析 ============================

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

/**
 * 从配置 map 读取键值；keys 为键名数组时靠前者优先（用于新旧键兼容）。
 * 全部缺失时给出清晰报错。
 */
function readConfigValue(configMap, keys, file) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    const v = configMap[key];
    if (v) return v;
  }
  throw new CommandExecutionError(
    `配置文件中未找到键 ${list.join(" / ")}（文件: ${file}）`,
    `现有键: ${Object.keys(configMap).join(", ") || "（空）"}；请补齐 ${list[0]}=<value>`,
  );
}

/** 配置文件存明文凭据：属组/其他用户可读时告警 */
function warnIfConfigPermsLoose(file) {
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) log.warn(`配置文件 ${file} 权限过宽（${mode.toString(8)}），建议 chmod 600`);
  } catch { /* 文件不存在时由 readKeyValueConfig 报清晰错误 */ }
}

// ============================ 执行上下文与浏览器原语 ============================

// 同一套输入/点击/取文本操作需同时作用于主文档与跨域 iframe，用 ctx 统一：
//   { kind: 'page',  index: -1 }          —— 主文档
//   { kind: 'frame', index: <frameIdx> }  —— 跨域 iframe
const frameCtx = (index) => ({ kind: "frame", index });

/** 在 ctx 对应上下文（page 或 frame）执行 evaluate 代码 */
async function evalIn(page, ctx, code) {
  if (ctx.kind === "frame") return page.evaluateInFrame(code, ctx.index);
  return page.evaluate(code);
}

const KEY_VK = { Enter: 13, ArrowDown: 40 };

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
    if (url.includes(GATEWAY_HOST) || name === FRAME_NAME) return i;
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

/** 生成轮询探测器：probe() 返回真值即成功，超时返回 false */
function waitForCondition(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return async (probe) => {
    for (;;) {
      let ok = false;
      try { ok = Boolean(await probe()); } catch { /* retry */ }
      if (ok) return true;
      if (Date.now() > deadline) return false;
      await page.sleep(0.8);
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
      const f = document.getElementById(${JSON.stringify(FRAME_NAME)});
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y };
    })()`,
  ).catch(() => null);
  if (!framePos) return null;
  return { x: framePos.x + inner.x, y: framePos.y + inner.y };
}

/**
 * 向 ctx 内输入框输入文本（先清空残留，再优先 CDP 原生 insertText；
 * 回退 Angular/React 兼容的 value setter + input/change 事件），并回读校验。
 * 修复：原实现不清空残留，insertText 追加导致 12 位码误判为填写失败。
 */
async function typeIntoSelector(page, ctx, selector, text) {
  const sel = JSON.stringify(selector);
  const textS = String(text);
  const protoExpr = "(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype)";
  const buildSetScript = (valueJson) => `(() => {
    const el = document.querySelector(${sel});
    if (!el) throw new Error('元素不存在: ' + ${sel});
    el.focus();
    Object.getOwnPropertyDescriptor(${protoExpr}, 'value').set.call(el, ${valueJson});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  const readScript = `(() => { const el = document.querySelector(${sel}); return el ? String(el.value || '') : null; })()`;
  // 1) 聚焦 + 清空残留（native setter 对受控组件有效）
  await evalIn(page, ctx, buildSetScript("''"));
  let cur = null;
  try { cur = await evalIn(page, ctx, readScript); } catch { cur = null; }
  if (cur === "") {
    // 确认已清空：优先 CDP 原生 insertText
    try {
      await page.cdp("Input.insertText", { text: textS });
    } catch {
      await evalIn(page, ctx, buildSetScript(JSON.stringify(textS)));
    }
  } else {
    // 残留未清掉（受控组件复原）或读不回：native setter 整值覆写
    await evalIn(page, ctx, buildSetScript(JSON.stringify(textS)));
  }
  let back = "";
  try {
    const r = await evalIn(page, ctx, `(() => (document.querySelector(${sel}) || {}).value || '')()`);
    back = String(r ?? "");
  } catch { /* ignore */ }
  return { ok: back === textS, actual: back };
}

/**
 * 在 ctx 内点击元素：一律 DOM click（el.click()）。
 * 旧实现优先「坐标 + Input.dispatchMouseEvent」，实测在嘉信登录页会被静默丢弃：
 * 按同款算法算出的按钮点位 (612,420) 上 `elementFromPoint` 命中的就是 lmsIframe，
 * dpr=1 / visualViewport.scale=1 / scrollY=0 / 无遮挡 / visibilityState=visible 全正常，
 * 事件却不落地，表现为「点了没反应 → 等满 150s 超时」，而同一个元素 el.click() 立即跳转。
 * 2026-10-31 起去掉坐标路径。需要操作浏览器 UI（autofill 下拉、方向键选择）的原生点击
 * 仍保留在 fillFirstStep 的兜底分支里直接用 nativeClickAt/nativeKeyPress，不受影响。
 * 元素不存在时抛错，供调用方 try/catch 换下一个选择器。
 */
async function clickInSelector(page, ctx, selector) {
  const sel = JSON.stringify(selector);
  await evalIn(
    page,
    ctx,
    `(() => {
      const el = document.querySelector(${sel});
      if (!el) throw new Error('元素不存在: ' + ${sel});
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
      return true;
    })()`,
  );
}

/**
 * iframe（SPA）内部的当前 URL —— 登录 widget 在 #/login-one-step ↔ #/placeholder 间切换，
 * 主文档 URL 不变时它才是「提交已被受理」的可靠信号。
 */
async function frameHref(page, index) {
  if (index < 0) return "";
  try {
    return String((await page.evaluateInFrame("location.href", index)) || "");
  } catch {
    return "";
  }
}

/**
 * DOM 点击「登入」后的确认窗口：出现下列任一信号即视为已提交
 *   navigated = 主文档离开登录页   otp = 出现验证码输入框
 *   frame:*   = iframe 内部路由变化（SPA 受理）  error:* = 服务器已回错误文本
 * 返回 "" 表示毫无反应（DOM 结构漂移 / 按钮换了实现），由调用方采集实况诊断，
 * 不做第二次点击——重复提交会白烧嘉信的登录尝试。
 */
async function waitSubmitReaction(page, frameIndex, timeoutMs = SUBMIT_CONFIRM_MS) {
  const baseHref = await frameHref(page, frameIndex);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await pageUrl(page);
    if (url && !isLoginPage(url)) return "navigated";
    try {
      if (await page.evaluate(SECURITY_CODE_PROBE)) return "otp";
    } catch { /* 导航切换中 */ }
    const inner = await frameHref(page, frameIndex);
    if (inner && baseHref && inner !== baseHref) return `frame:${inner.slice(0, 120)}`;
    const errText = await readFormError(page, frameCtx(frameIndex));
    if (errText) return `error:${errText.slice(0, 200)}`;
    await page.sleep(0.6);
  }
  return "";
}

async function readFrameCredentials(page, index) {
  try {
    const r = await page.evaluateInFrame(
      `(() => ({
        u: (document.querySelector(${JSON.stringify(LOGIN_USER_SEL)}) || {}).value || '',
        p: (document.querySelector(${JSON.stringify(LOGIN_PASS_SEL)}) || {}).value || '',
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

// 可见错误文本选择器：主文档与登录 iframe 的 DOM 实测不同，各保留一套。
// .msg-error = 嘉信登录 widget（sws-gateway #/login-one-step）实测的服务器错误容器，
// 既不是 [role=alert] 也不是 data-testid，旧列表抓不到它 → 密码被拒时表现为「静默超时」。
const PAGE_ERROR_SELECTORS = [
  ".error", "[role=\"alert\"]", ".sdps-form-element__error",
  ".access-code-wrapper .sdps-form-element__error",
  "lms-messenger", "#messenger", ".sdps-notification[type=\"error\"]", "sdps-form-element__error",
  ".msg-error",
];
const FRAME_ERROR_SELECTORS = [
  ".error", "[role=\"alert\"]", ".sdps-form-element__error",
  ".access-code-wrapper .sdps-form-element__error", "[data-testid*=\"error\" i]", ".infomsg-margin",
  "lms-messenger", "#messenger", ".sdps-notification[type=\"error\"]",
  ".msg-error",
];

const ctxErrorSelectors = (ctx) => (ctx.kind === "page" ? PAGE_ERROR_SELECTORS : FRAME_ERROR_SELECTORS);

/** 生成「收集可见错误文本」的内联 JS 片段（写入 varName 数组，消费方自行 join 截断） */
function errorCollectSnippet(varName, selectors) {
  return `const ${varName} = [];
    for (const sel of ${JSON.stringify(selectors)}) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.textContent || '').trim();
        if (t && ${varName}.indexOf(t) < 0) ${varName}.push(t);
      }
    }`;
}

/** 抓取 ctx 页面可见错误文本 */
async function readFormError(page, ctx) {
  try {
    const text = await evalIn(
      page,
      ctx,
      `(() => {
        ${errorCollectSnippet("out", ctxErrorSelectors(ctx))}
        return out.join(' | ').slice(0, 400);
      })()`,
    );
    return String(text || "").trim();
  } catch {
    return "";
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

/** OTP 提交后单轮快照：错误文本 + 验证码框是否仍在（与 URL 探测合计每轮仅 2 次 eval） */
function postSubmitProbeScript(ctx) {
  return `(() => {
    ${errorCollectSnippet("errs", ctxErrorSelectors(ctx))}
    return { err: errs.join(' | ').slice(0, 400), code: ${SECURITY_CODE_PROBE} };
  })()`;
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
    const stillThere = await locateSecurityCode(page, ctx.kind === "frame" ? ctx.index : -1);
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
    // 提交验证码：优先 Continue / 登入按钮，回退任意主要按钮（clickInSelector 已是 DOM 点击）。
    for (const s of ["#continueButton", 'button[type="submit"], button[class*="primary"], #btnLogin']) {
      try {
        await clickInSelector(page, codeCtx, s);
        break;
      } catch { /* 该选择器不存在，换下一个 */ }
    }
    // 提交后自适应等待服务器响应：嘉信校验往返可能 >1s，固定短等待会把
    // 「还在处理中」误判成「未通过」，白白消耗重试次数。
    // 每轮 = pageUrl（1 次 eval）+ 表单上下文 {错误文本, 输入框存在} 快照（1 次 eval）。
    let errText = "";
    const probeScript = postSubmitProbeScript(codeCtx);
    for (let waited = 0; waited < OTP_SERVER_WAIT_MS; waited += OTP_SERVER_POLL_MS) {
      await page.sleep(OTP_SERVER_POLL_MS / 1000);
      const u = await pageUrl(page);
      if (isFinalLoggedInUrl(u)) return true;
      let snap = null;
      try { snap = await evalIn(page, codeCtx, probeScript); } catch { /* 导航切换中 */ }
      if (!snap) continue;
      errText = String(snap.err || "").trim();
      if (errText) break;
      // 输入框已消失（跳转/换形态中），交由外层轮询重新定位
      if (!String(snap.code || "")) break;
    }
    // 一整轮既无错误文本、也没跳转 → 打印一次页面实况，便于判断按钮/输入框选择器是否已漂移
    if (!errText && attempt === 1 && !isFinalLoggedInUrl(await pageUrl(page))) {
      log.info("[诊断] OTP 提交后无可见错误，采集页面实况…");
      await dumpLoginTransition(page, codeCtx.kind === "frame" ? codeCtx.index : -1);
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

// ============================ 登录流程步骤 ============================

/** 关 OneTrust cookie 弹层（可能遮挡点击） */
async function dismissCookieBanner(page) {
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
}

/** 等待登录 widget iframe 与用户名输入框就绪 */
async function waitForLoginFrame(page) {
  const deadline = Date.now() + LOGIN_FRAME_WAIT_MS;
  let frameIndex = -1;
  while (Date.now() < deadline) {
    frameIndex = gatewayFrameIndex(await listFrames(page));
    if (frameIndex >= 0 && (await waitFrameSelector(page, frameIndex, LOGIN_USER_SEL, FRAME_PROBE_FAST_MS))) {
      return { frameIndex, ready: true };
    }
    await page.sleep(0.5);
  }
  frameIndex = gatewayFrameIndex(await listFrames(page));
  const ready = frameIndex >= 0 && (await waitFrameSelector(page, frameIndex, LOGIN_USER_SEL, FRAME_PROBE_FINAL_MS));
  return { frameIndex, ready };
}

/**
 * 第 1 步凭据填写。配置/命令行已提供凭据 → 直接填写（最可靠，不依赖 autofill）。
 * 兜底分支（浏览器保存凭据 / 人工等待）仅在未提供凭据时触发——常规路径下
 * readConfigValue 已强制用户名/密码存在，理论不可达，保留为显式覆盖场景。
 */
async function fillFirstStep(page, frameIndex, { user, pass, manualWait, configFile }) {
  if (user && pass) {
    log.info(`使用配置文件/命令行凭据填写表单（用户：${user}）…`);
    const fctx = frameCtx(frameIndex);
    const r1 = await typeIntoSelector(page, fctx, LOGIN_USER_SEL, user);
    if (!r1.ok) throw new CommandExecutionError(`用户名填写失败（回读 ${JSON.stringify(r1.actual)}）`);
    const r2 = await typeIntoSelector(page, fctx, LOGIN_PASS_SEL, pass);
    if (!r2.ok) throw new CommandExecutionError(`密码填写失败（回读 ${JSON.stringify(r2.actual)}）`);
    return { credentialSource: "config", detectedUser: "" };
  }
  // 兜底：原生点击用户名输入框 → 触发浏览器保存的凭据下拉 → 键盘选择
  log.info("点击用户名输入框，尝试调用浏览器保存的凭据…");
  const pos = await elementViewportCenter(page, frameIndex, LOGIN_USER_SEL);
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
    log.success(`浏览器保存的凭据已填充：${creds.u}`);
    return { credentialSource: "browser-saved", detectedUser: creds.u };
  }
  if (manualWait > 0) {
    log.warn(
      `未能在自动化中触发 autofill（Chromium 对调试标签页会抑制密码下拉）。` +
        `请在浏览器窗口点击登录页「用户名」输入框选择保存的凭据，` +
        `插件将在 ${manualWait} 秒内自动继续…`,
    );
    const wait = waitForCondition(page, manualWait * 1000);
    const filled = await wait(async () => {
      const c = await readFrameCredentials(page, frameIndex);
      return Boolean(c.u && c.p);
    });
    if (filled) {
      const c = await readFrameCredentials(page, frameIndex);
      log.success(`检测到表单已填充：${c.u}`);
      return { credentialSource: "manual-wait", detectedUser: c.u };
    }
    throw new CommandExecutionError(
      "等待人工填充超时（用户名/密码仍为空）",
      `请检查配置文件 ${configFile} 的 ${CFG_KEY_USER}/${CFG_KEY_PASS}，或改用 --user/--pass`,
    );
  }
  throw new CommandExecutionError(
    "浏览器保存的凭据未能自动填充（用户名/密码为空）",
    `请检查配置文件 ${configFile} 的 ${CFG_KEY_USER}/${CFG_KEY_PASS}，或用 --user/--pass 显式登录`,
  );
}

/**
 * 点击登入后的状态机轮询（登录页 → sws-gateway 中转 → 验证码页 → 客户主站）：
 *   到达客户主站             → 成功，返回 { finalUrl, otpAttempts }
 *   出现验证码输入框         → submitSecurityCodes 内部循环提交 TOTP
 *   登录 iframe 出现致命错误 → 抛 AuthRequiredError
 *   窗口耗尽                 → 抛 CommandExecutionError
 * 安全码有时效（TOTP 30s 窗口），跳转一完成就要立即填码：
 *   快路径 = 每轮单次 eval 只探主文档（实测 placeholder 页输入框在主文档，且是整页跳转）；
 *   慢路径 = 每 FULL_SCAN_EVERY 轮做一次全 frame 扫描（兼容验证码在 iframe 内的形态）。
 */
async function runPostLoginPoll(page, frameIndex, { maxAttempts, resolveSecret }) {
  let otpAttempts = 0;
  let lastError = "";
  let diagnosed = false;
  let otpHostSince = 0;
  let pollIter = 0;
  const pollStart = Date.now();

  while (Date.now() - pollStart < POST_LOGIN_WAIT_MS) {
    // 1) 是否已到达客户主站
    const curUrl = await pageUrl(page);
    if (isFinalLoggedInUrl(curUrl)) {
      log.success(`登录成功：${curUrl}`);
      return { finalUrl: curUrl, otpAttempts };
    }
    // 2) 验证码页检测
    let codeCtx = null;
    try {
      const m = String(await page.evaluate(SECURITY_CODE_PROBE) || "");
      if (m) codeCtx = { kind: "page", index: -1, mode: m };
    } catch { /* 导航切换中，上下文暂不可用 */ }
    let liveFrame = -1;
    if (!codeCtx && pollIter % FULL_SCAN_EVERY === 1) {
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
        const u = await pageUrl(page);
        log.success(`登录成功：${u}`);
        return { finalUrl: u, otpAttempts };
      }
    }
    // 停在 placeholder/验证页 CHALLENGE_DIAGNOSTIC_MS 仍找不到输入框 → 打印一次实况诊断（勿高频，拖慢轮询）
    if (/#\/placeholder|challenge|otp|verify|securitycode/i.test(curUrl)) {
      if (!otpHostSince) otpHostSince = Date.now();
      if (!diagnosed && !codeCtx && Date.now() - otpHostSince > CHALLENGE_DIAGNOSTIC_MS) {
        diagnosed = true;
        log.info("[诊断] 验证码页迟迟未出现输入框，采集 DOM 实况…");
        await dumpLoginTransition(page, liveFrame);
      }
    }
    // 3) 登录页出现错误 → 终止
    const errText = await readFormError(page, frameCtx(frameIndex));
    if (errText) {
      lastError = errText;
      if (FATAL_ERROR_RE.test(errText)) {
        throw new AuthRequiredError(
          "client.schwab.com",
          `嘉信登录被服务器拒绝: ${errText}`,
          `请核对配置文件中 ${CFG_KEY_PASS} 密码、${CFG_KEY_SECRET} 密钥；不要盲目重试以免锁定`,
        );
      }
    }
    // 快路径每轮仅 1-2 次轻量 exec，短间隔以尽早捕捉输入框渲染（TOTP 时效敏感）
    await page.sleep(0.3);
  }

  const finalUrl = await pageUrl(page);
  if (isFinalLoggedInUrl(finalUrl)) {
    return { finalUrl, otpAttempts };
  }
  throw new CommandExecutionError(
    `登录未完成（等待跳转超时）; 页面: ${finalUrl.slice(0, 120)}`,
    lastError
      ? `最后原因: ${lastError}`
      : "点击登入后浏览器未跳转，可能是网络/服务器异常，可重试一次",
  );
}

// ============================ 命令注册 ============================

cli({
  site: SITE,
  name: "login-schwab",
  description:
    "自动登录嘉信理财（client.schwab.com，两步）：凭据/密钥统一从 ~/.duckdb/stock/stock.config 读取（SCHWAB_USERNAME / SCHWAB_PASSWORD / SCHWAB_SECRET，兼容旧键 SCHWAB_SCRET），也可 --user/--pass/--secret 覆盖；TOTP 验证码自动填入",
  access: "write",
  example:
    "opencli stock login-schwab                               # 配置文件凭据 + TOTP 自动登录\nopencli stock login-schwab --user u --pass p              # 命令行凭据覆盖配置\nopencli stock login-schwab --wait-manual                  # 人工在窗口点选保存的密码，自动继续\nopencli stock login-schwab --config /path/to/stock.config",
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
    { name: "secret", type: "string", default: "", help: `TOTP base32 密钥；缺省读配置文件 ${CFG_KEY_SECRET}（兼容旧键 ${CFG_KEY_SECRET_LEGACY}）` },
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
    warnIfConfigPermsLoose(configFile);
    const config = readKeyValueConfig(configFile);
    const user = String(kwargs.user || "").trim() || readConfigValue(config, [CFG_KEY_USER], configFile);
    const pass = String(kwargs.pass || "") || readConfigValue(config, [CFG_KEY_PASS], configFile);
    const explicitSecret = String(kwargs.secret || "").trim();
    let secretCache = null;
    const resolveSecret = () => {
      if (secretCache === null) {
        secretCache = explicitSecret || readConfigValue(config, [CFG_KEY_SECRET, CFG_KEY_SECRET_LEGACY], configFile);
      }
      return secretCache;
    };

    const done = (status, credentialSource, otpAttempts, url, u = "") =>
      [{ status, user: u || user, credentialSource, otpAttempts, finalUrl: url }];

    log.info(`打开 ${LOGIN_URL}`);
    await page.goto(LOGIN_URL);

    const startUrl = await pageUrl(page);
    if (!isLoginPage(startUrl)) {
      log.success("已在登录状态（页面已离开登录页）");
      return done("already_logged_in", "none", 0, startUrl);
    }

    await dismissCookieBanner(page);

    const { frameIndex, ready } = await waitForLoginFrame(page);
    if (!ready) {
      const cur = await pageUrl(page);
      if (!isLoginPage(cur)) return done("already_logged_in", "none", 0, cur);
      throw new CommandExecutionError(
        `未能定位嘉信登录输入框（iframe ${GATEWAY_HOST} / ${LOGIN_USER_SEL}）`,
        "请确认登录页可访问，以及浏览器扩展/调试桥已连接",
      );
    }

    await ensurePageVisible(page);

    // ---- 第 1 步：用户名 + 密码 ----
    const { credentialSource, detectedUser } = await fillFirstStep(page, frameIndex, {
      user, pass, manualWait, configFile,
    });

    // ---- 提交登录（第 1 步表单）：DOM 点击，不走坐标命中测试 ----
    await ensurePageVisible(page);
    log.info("点击登入（DOM 点击），等待浏览器跳转…");
    await clickInSelector(page, frameCtx(frameIndex), LOGIN_SUBMIT_SEL);

    // 8s 内没有任何受理信号 → 只采集页面实况诊断，绝不二次点击（重复提交会白烧登录尝试）。
    const reaction = await waitSubmitReaction(page, frameIndex);
    if (!reaction) {
      log.warn("点击登入后无反应（未跳转、无验证码框、无错误提示），采集页面实况诊断…");
      await dumpLoginTransition(page, frameIndex);
    } else if (reaction.startsWith("error:")) {
      log.warn(`服务器已回错误提示: ${reaction.slice(6)}`);
    } else {
      log.info(`提交已受理（${reaction}）`);
    }

    // ---- 第 2 步：跳转 / OTP / 成功判定（状态机） ----
    const { finalUrl, otpAttempts } = await runPostLoginPoll(page, frameIndex, {
      maxAttempts, resolveSecret,
    });
    return done("logged_in", credentialSource, otpAttempts, finalUrl, detectedUser || user);
  },
});
