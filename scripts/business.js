/**
 * 业务逻辑层
 * 交易匹配与收益查询（数据同步由 opencli stock sync 负责，本目录不再重复实现）
 */

import { withDb } from "./db.js";
import { TABLE, OP } from "./constants.js";
import {
  GRID_PROFIT
} from "./sql-profit.js";
import { LOAD_UNMATCHED_TRADES, MATCHED_COLUMNS } from "./sql-match.js";

/**
 * 批量插入匹配结果（分批拼接 VALUES，避免单条语句参数过多）
 * @param {object} conn - 数据库连接
 * @param {Array<Array>} rows - 行数据数组
 */
async function batchInsertMatched(conn, rows) {
  if (rows.length === 0) return;
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() =>
      `(${MATCHED_COLUMNS.map(() => "?").join(",")})`,
    ).join(",");
    const sql = `INSERT INTO ${TABLE.TRADE_MATCHED} (${MATCHED_COLUMNS.join(",")}) VALUES ${placeholders}`;
    await conn.run(sql, batch.flat());
  }
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
    const fee = (t) => (Number(t.entry_money) === Number(t.transfer_fee) ? 0 : Number(t.transfer_fee));
    for (const b of buys) {
      b.netMoney = b.entry_money + fee(b) + b.commission;
      b.matchMoney = netFilter ? b.netMoney : b.entry_money;
    }
    for (const s of sells) {
      s.netMoney = s.entry_money - fee(s) - s.commission;
      s.matchMoney = netFilter ? s.netMoney : s.entry_money;
    }

    const pairs = greedyMatch(buys, sells);

    const insertRows = pairs.map(({ buy, sell }) => {
      const profit = sell.netMoney - buy.netMoney;
      return [
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
      ];
    });
    await batchInsertMatched(conn, insertRows);

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
 * 查询网格收益（默认当年 1 月 ~ 12 月）
 * @param {string} [startMonth] - 开始月份 YYYY-MM，默认当年 01
 * @param {string} [endMonth] - 结束月份 YYYY-MM，默认当年 12
 */
export async function gridProfit(startMonth, endMonth) {
  const year = new Date().getFullYear();
  const start = startMonth || `${year}-01`;
  const end = endMonth || `${year}-12`;
  return await withDb(async (conn) => {
    return await conn.all(GRID_PROFIT, [end, start, end, start.substring(0, 4)]);
  });
}