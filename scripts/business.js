/**
 * 业务逻辑层
 * 包含交易同步、匹配、收益查询等核心业务逻辑
 */

import { withDb } from "./db.js";
import { TABLE, OP, PAGE_SIZE, API_BASE, API_PATH, HTTP_HEADERS, API_DEFAULTS, DICT_TYPE, SYNC_CONCURRENCY } from "./constants.js";
import { getCookie, getUserId, checkCookieValid } from "./utils.js";
import {
  GRID_PROFIT
} from "./sql-profit.js";
import {
  CREATE_DICT, CREATE_TRADE_RECORD, CREATE_TRADE_MATCHED
} from "./sql-schema.js";
import { INSERT_ACCOUNT, INSERT_TRADE } from "./sql-sync.js";
import { LOAD_UNMATCHED_TRADES, INSERT_MATCHED } from "./sql-match.js";

// ============================ HTTP 请求工具 ============================

/**
 * 发起 POST 请求（同花顺财神平台 API）
 * @param {string} url - 请求 URL
 * @param {Object} params - 表单参数
 * @param {string} cookie - Cookie
 * @returns {Promise<Object>} JSON 响应
 */
async function postForm(url, params, cookie) {
  const formData = new URLSearchParams(params);
  const headers = {
    ...HTTP_HEADERS,
    cookie,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

// ============================ 数据库初始化 ============================

/** 初始化数据库表结构 */
export async function initDb() {
  await withDb(async (conn) => {
    for (const [name, sql] of Object.entries({
      "字典表": CREATE_DICT,
      "交易记录表": CREATE_TRADE_RECORD,
      "交易匹配表": CREATE_TRADE_MATCHED,
    })) {
      await conn.run(sql);
      console.log(`${name}初始化成功`);
    }
  });
}

// ============================ 账户同步 ============================

/** 同步账户信息到字典表 */
export async function initAccount() {
  checkCookieValid();
  const cookie = getCookie();
  const userId = getUserId();

  // 调用 API 获取账户列表
  const url = `${API_BASE}${API_PATH.ACCOUNT_LIST}`;
  const params = {
    userid: userId,
    user_id: userId,
    terminal: API_DEFAULTS.TERMINAL,
    version: API_DEFAULTS.VERSION,
  };

  const data = await postForm(url, params, cookie);

  // 解析响应并插入数据库
  const common = data?.ex_data?.common || [];
  await withDb(async (conn) => {
    for (const item of common) {
      const fundKey = item.fund_key;
      const manualName = item.manualname;
      if (fundKey) {
        await conn.run(INSERT_ACCOUNT, [fundKey, manualName]);
      }
    }
  });

  console.log("同步账户成功, 共同步", common.length, "条记录");
}

// ============================ 交易记录同步 ============================

/**
 * 按基金KEY同步交易记录（自动分页，带重试）
 * @param {string} fundKey - 基金KEY
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [page=1] - 页码
 * @param {number} [retryCount=3] - 剩余重试次数
 * @returns {Promise<number>} 同步的记录数
 */
async function syncTradeByFundKey(fundKey, startDate, endDate, page = 1, retryCount = 3) {
  try {
    checkCookieValid();
    const cookie = getCookie();
    const userId = getUserId();

    // 调用 API 获取交易记录
    const url = `${API_BASE}${API_PATH.SYNC_TRADE}`;
    const params = {
      userid: userId,
      user_id: userId,
      fund_key: fundKey,
      stock_code: '',
      stock_account: '',
      start_date: startDate,
      end_date: endDate,
      page: page.toString(),
      count: PAGE_SIZE.toString(),
      sort_type: '',
      sort_order: '1',
    };

    const data = await postForm(url, params, cookie);
    const exData = data?.ex_data || {};
    const maxPage = exData.max_page || 1;
    const list = exData.list || [];

    // 获取账户名称
    let accountName = '';
    await withDb(async (conn) => {
      const rows = await conn.all(
        `SELECT value FROM ${TABLE.DICT} WHERE key = ? AND type = '${DICT_TYPE.FUND_KEY}'`,
        [fundKey]
      );
      accountName = rows[0]?.value || '';
    });

    // 解析响应并批量插入数据库
    const rows = list.map(item => {
      const entryDateTime = `${item.entry_date} ${item.entry_time}`;
      const entryEpoch = Math.floor(new Date(entryDateTime).getTime() / 1000);
      const historyId = `${item.account_id}${entryEpoch}${item.code}${item.op}${item.entry_count}`;

      return [
        item.account_id,
        accountName,
        item.account_type,
        item.code,
        parseFloat(item.commission) || 0,
        parseFloat(item.entry_cost) || 0,
        item.entry_count,
        item.entry_date,
        parseFloat(item.entry_money) || 0,
        parseFloat(item.entry_price) || 0,
        item.entry_time,
        entryDateTime,
        parseFloat(item.fee_total) || 0,
        historyId,
        item.manual_id,
        item.market_code,
        item.name,
        parseInt(item.oid) || 0,
        item.op,
        item.op_name,
        parseFloat(item.transfer_fee) || 0,
      ];
    });

    await withDb(async (conn) => {
      for (const row of rows) {
        await conn.run(INSERT_TRADE, row);
      }
    });

    const n = list.length;
    console.log(`同步交易记录成功, 账户: ${fundKey}, 页: ${page}/${maxPage}, 记录数: ${n}`);

    if (page < maxPage) {
      await syncTradeByFundKey(fundKey, startDate, endDate, page + 1, retryCount);
    }

    return n;
  } catch (error) {
    if (retryCount > 1) {
      console.warn(`同步交易记录失败, 账户: ${fundKey}, 页: ${page}, 重试中... (${retryCount - 1}/${3})`);
      await new Promise(r => setTimeout(r, 1000));
      return await syncTradeByFundKey(fundKey, startDate, endDate, page, retryCount - 1);
    }
    throw error;
  }
}

/**
 * 同步单个账户（带错误捕获）
 */
async function syncSingleAccount(fundKey, startDate, endDate) {
  try {
    await syncTradeByFundKey(fundKey, startDate, endDate);
    return { fundKey, success: true };
  } catch (error) {
    console.error(`账户 ${fundKey} 同步失败:`, error.message);
    return { fundKey, success: false, error: error.message };
  }
}

/**
 * 同步一批账户（并行处理）
 */
async function syncBatch(fundKeys, startDate, endDate) {
  const results = await Promise.all(
    fundKeys.map((fk) => syncSingleAccount(fk, startDate, endDate))
  );

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  if (failCount > 0) {
    console.warn(`本批次 ${fundKeys.length} 个账户: ${successCount} 成功, ${failCount} 失败`);
  }

  return { successCount, failCount };
}

/**
 * 同步所有账户的交易记录（并行分批处理）
 * 账户从 t_dict 表读取（type=fund_key），不再依赖 gtja-api.js / t_dict_account
 * @param {string} startDate - 开始日期 YYYYMMDD
 * @param {string} endDate - 结束日期 YYYYMMDD
 * @param {number} [concurrency=3] - 并发数
 */
export async function syncTrade(startDate, endDate, concurrency = SYNC_CONCURRENCY) {
  await withDb(async (conn) => {
    await conn.run(CREATE_DICT);
    await conn.run(CREATE_TRADE_RECORD);
    await conn.run(CREATE_TRADE_MATCHED);
  });

  const fundKeys = await withDb(async (conn) => {
    const rows = await conn.all(`SELECT key FROM ${TABLE.DICT} WHERE type = '${DICT_TYPE.FUND_KEY}'`);
    return rows.map((row) => row.key);
  });

  console.log(`开始同步 ${fundKeys.length} 个账户，并发数: ${concurrency}`);

  for (let i = 0; i < fundKeys.length; i += concurrency) {
    await syncBatch(fundKeys.slice(i, i + concurrency), startDate, endDate);
  }

  console.log("所有账户交易记录同步完成");
}

// ============================ 交易匹配 ============================

/**
 * 最短持有匹配（时间差最小优先，LIFO）
 * 每组 (account_id, code, entry_count) 内独立匹配：
 * 卖出按时间升序处理，可用买入 = 未匹配且 time <= 卖出时间的买入；
 * 每次配对取买入时间最新（卖出时间 - 买入时间差最小）且盈利
 * （matchMoney < 卖出 matchMoney）的买入。
 *
 * @param {Array} buys - 未匹配买入记录
 * @param {Array} sells - 未匹配卖出记录
 * @returns {Array<{buy: Object, sell: Object}>} 匹配对
 */
function greedyMatch(buys, sells) {
  // 按 (account_id, code, entry_count) 分组
  const groups = new Map();
  for (const b of buys) {
    const key = `${b.account_id}|${b.code}|${b.entry_count}`;
    if (!groups.has(key)) groups.set(key, { buys: [], sells: [] });
    groups.get(key).buys.push(b);
  }
  for (const s of sells) {
    const key = `${s.account_id}|${s.code}|${s.entry_count}`;
    if (!groups.has(key)) groups.set(key, { buys: [], sells: [] });
    groups.get(key).sells.push(s);
  }

  const pairs = [];
  for (const { buys: gBuys, sells: gSells } of groups.values()) {
    if (gBuys.length === 0 || gSells.length === 0) continue;

    // 按时间升序，并列按 history_id 保证确定性
    gBuys.sort((a, b) => a.entry_ts.getTime() - b.entry_ts.getTime() || a.history_id.localeCompare(b.history_id));
    gSells.sort((a, b) => a.entry_ts.getTime() - b.entry_ts.getTime() || a.history_id.localeCompare(b.history_id));

    const avail = [];
    let bi = 0;
    for (const sell of gSells) {
      while (bi < gBuys.length && gBuys[bi].entry_ts.getTime() <= sell.entry_ts.getTime()) {
        avail.push(gBuys[bi]);
        bi++;
      }
      // 找买入时间最新（时间差最小）且盈利的买入
      let best = -1;
      let bestTime = -Infinity;
      for (let i = 0; i < avail.length; i++) {
        if (avail[i].matchMoney < sell.matchMoney && avail[i].entry_ts.getTime() > bestTime) {
          best = i;
          bestTime = avail[i].entry_ts.getTime();
        }
      }
      if (best >= 0) {
        pairs.push({ buy: avail.splice(best, 1)[0], sell });
      }
    }
  }
  return pairs;
}

/** 格式化 Date → 'YYYY-MM-DD HH:MM:SS'（DuckDB TIMESTAMP 绑定用） */
function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 匹配交易记录（最短持有 / 时间差最小，单遍完成，无需迭代）
 * 净额 = entry_money ∓ (commission + transfer_fee)
 * @param {Object} [opts]
 * @param {boolean} [opts.netFilter=true] - 盈利判定用净额还是毛额
 *   true：买入净成本 < 卖出净所得（真实盈利，与 profit 一致）
 *   false：买入毛额 < 卖出毛额（覆盖更多对，但部分对 net profit 可能为负）
 */
export async function tradeMatch({ netFilter = true } = {}) {
  await withDb(async (conn) => {
    const trades = (await conn.all(LOAD_UNMATCHED_TRADES)).map((t) => ({
      ...t,
      // DuckDBTimestampValue {micros} → JS Date（epoch 毫秒）
      entry_ts: new Date(Number(t.entry_ts.micros / 1000n)),
    }));
    const buys = trades.filter((t) => t.op === OP.BUY);
    const sells = trades.filter((t) => t.op === OP.SELL);

    // 净额：买入成本含费，卖出所得扣费（profit 恒用净额）
    // 港股（market_code=15）API 的 transfer_fee 字段等于成交额，非真实费用，跳过
    const fee = (t) => (t.entry_money === t.transfer_fee ? 0 : t.transfer_fee);
    for (const b of buys) {
      b.netMoney = b.entry_money + fee(b) + b.commission;
      b.matchMoney = netFilter ? b.netMoney : b.entry_money;
    }
    for (const s of sells) {
      s.netMoney = s.entry_money - fee(s) - s.commission;
      s.matchMoney = netFilter ? s.netMoney : s.entry_money;
    }

    const pairs = greedyMatch(buys, sells);

    for (const { buy, sell } of pairs) {
      const profit = sell.netMoney - buy.netMoney;
      await conn.run(INSERT_MATCHED, [
        buy.account_id, buy.account_name,
        String(sell.entry_ts.getFullYear()),
        `${sell.entry_ts.getFullYear()}-${String(sell.entry_ts.getMonth() + 1).padStart(2, "0")}`,
        buy.code, buy.name || sell.name,
        sell.entry_price, buy.entry_price,
        sell.entry_count, buy.entry_count,
        sell.entry_money, buy.entry_money,
        sell.transfer_fee, buy.transfer_fee,
        profit,
        fmtDateTime(sell.entry_ts), fmtDateTime(buy.entry_ts),
        sell.history_id, buy.history_id,
      ]);
    }

    const usedSell = new Set(pairs.map((p) => p.sell.history_id));
    const usedBuy = new Set(pairs.map((p) => p.buy.history_id));
    const unBuys = buys.filter((b) => !usedBuy.has(b.history_id));
    const unSells = sells.filter((s) => !usedSell.has(s.history_id));

    console.log(`匹配完成：新增 ${pairs.length} 对`);
    console.log(`未匹配买入：${unBuys.length}，未匹配卖出：${unSells.length}`);
    const summary = summarizeUnmatched(unBuys, unSells, buys, sells);
    if (summary.sellNoBuy > 0) console.log(`  卖出无同数量买入可配：${summary.sellNoBuy}（可能需数量拆分）`);
    if (summary.sellNoProfit > 0) console.log(`  卖出无盈利买入可配：${summary.sellNoProfit}`);
    if (summary.buyNoSell > 0) console.log(`  买入无同数量卖出可配：${summary.buyNoSell}`);
    if (summary.buyNoProfit > 0) console.log(`  买入无盈利卖出可配：${summary.buyNoProfit}`);
  });
}

/** 未匹配原因分类统计（辅助诊断） */
function summarizeUnmatched(unBuys, unSells, allBuys, allSells) {
  const buyGroups = new Map();
  for (const b of allBuys) {
    const key = `${b.account_id}|${b.code}|${b.entry_count}`;
    if (!buyGroups.has(key)) buyGroups.set(key, []);
    buyGroups.get(key).push(b);
  }
  const sellGroups = new Map();
  for (const s of allSells) {
    const key = `${s.account_id}|${s.code}|${s.entry_count}`;
    if (!sellGroups.has(key)) sellGroups.set(key, []);
    sellGroups.get(key).push(s);
  }

  let sellNoBuy = 0;
  let sellNoProfit = 0;
  for (const s of unSells) {
    const key = `${s.account_id}|${s.code}|${s.entry_count}`;
    const gb = buyGroups.get(key) || [];
    if (gb.length === 0) { sellNoBuy++; continue; }
    const has = gb.some((b) => b.entry_ts.getTime() <= s.entry_ts.getTime() && b.matchMoney < s.matchMoney);
    if (!has) sellNoProfit++;
  }

  let buyNoSell = 0;
  let buyNoProfit = 0;
  for (const b of unBuys) {
    const key = `${b.account_id}|${b.code}|${b.entry_count}`;
    const gs = sellGroups.get(key) || [];
    if (gs.length === 0) { buyNoSell++; continue; }
    const has = gs.some((s) => s.entry_ts.getTime() >= b.entry_ts.getTime() && b.matchMoney < s.matchMoney);
    if (!has) buyNoProfit++;
  }

  return { sellNoBuy, sellNoProfit, buyNoSell, buyNoProfit };
}

// ============================ 收益查询 ============================

/**
 * 查询网格收益
 * @param {string} startMonth - 开始月份 YYYY-MM
 * @param {string} endMonth - 结束月份 YYYY-MM
 */
export async function gridProfit(startMonth = '2026-01', endMonth = '2026-12') {
  return await withDb(async (conn) => {
    return await conn.all(GRID_PROFIT, [endMonth, startMonth, endMonth, startMonth.substring(0, 4)]);
  });
}
