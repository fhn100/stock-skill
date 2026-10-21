/**
 * 业务逻辑层
 * 交易匹配与收益查询（数据同步由 opencli stock sync 负责，本目录不联网）
 */

import { withDb } from "./db.js";
import { TABLE, OP, INSERT_BATCH_SIZE } from "./constants.js";
import { GRID_PROFIT } from "./sql-profit.js";
import { LOAD_UNMATCHED_TRADES, MATCHED_COLUMNS } from "./sql-match.js";

/**
 * 批量插入匹配结果（分批拼接 VALUES，避免单条语句参数过多）
 * @param {object} db - DatabaseManager
 * @param {Array<Array>} rows - 行数据数组
 */
async function batchInsertMatched(db, rows) {
  const placeholders = MATCHED_COLUMNS.map(() => "?").join(",");
  const oneRow = `(${placeholders})`;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const sql = `INSERT INTO ${TABLE.TRADE_MATCHED} (${MATCHED_COLUMNS.join(",")}) VALUES ${
      new Array(batch.length).fill(oneRow).join(",")
    }`;
    await db.run(sql, batch.flat());
  }
}

// ============================ 交易匹配 ============================

/** 配对分组键：同账户 + 同代码 + 同数量才可互相配对（不做数量拆分） */
const groupKey = (t) => `${t.account_id}|${t.code}|${t.entry_count}`;

/**
 * 按 key 分组
 * @param {Array} list
 * @param {(item: any) => string} keyFn
 * @returns {Map<string, Array>}
 */
function groupBy(list, keyFn) {
  const groups = new Map();
  for (const item of list) {
    const key = keyFn(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** 时间升序，并列按 history_id 保证确定性 */
const byTime = (a, b) =>
  a.entry_ts.getTime() - b.entry_ts.getTime() || a.history_id.localeCompare(b.history_id);

/**
 * 单笔流水的净额（含佣金与过户费）
 * 过户费等于成交额时为接口脏数据（港股及部分账户快照），按 0 费用处理。
 * 买入为净成本（加费用），卖出为净所得（减费用）。
 * @param {object} t - 交易记录
 * @returns {number}
 */
export function netMoneyOf(t) {
  const fee = Number(t.entry_money) === Number(t.transfer_fee)
    ? 0
    : Number(t.transfer_fee);
  const total = Number(t.entry_money) + fee + Number(t.commission);
  return t.op === OP.BUY ? total : 2 * Number(t.entry_money) - total;
}

/**
 * 配对盈利判定口径
 * @param {object} t - 交易记录
 * @param {boolean} netFilter - true 用净额（与 profit 一致），false 用毛额
 * @returns {number}
 */
export function matchMoneyOf(t, netFilter) {
  return netFilter ? netMoneyOf(t) : Number(t.entry_money);
}

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
export function greedyMatch(buys, sells) {
  const buyGroups = groupBy(buys, groupKey);
  const pairs = [];

  for (const [key, gSells] of groupBy(sells, groupKey)) {
    const gBuys = buyGroups.get(key);
    if (!gBuys) continue;

    gBuys.sort(byTime);
    gSells.sort(byTime);

    const avail = [];
    let bi = 0;
    for (const sell of gSells) {
      while (bi < gBuys.length && byTime(gBuys[bi], sell) <= 0) avail.push(gBuys[bi++]);
      // 从可用买入里取时间最新（即 avail 尾部反向扫描）且盈利的买入
      for (let i = avail.length - 1; i >= 0; i--) {
        if (avail[i].matchMoney < sell.matchMoney) {
          pairs.push({ buy: avail.splice(i, 1)[0], sell });
          break;
        }
      }
    }
  }
  return pairs;
}

/** 未匹配原因分类统计（辅助诊断） */
function summarizeUnmatched(unBuys, unSells, allBuys, allSells) {
  const buyGroups = groupBy(allBuys, groupKey);
  const sellGroups = groupBy(allSells, groupKey);

  const countBy = (list, groups, otherOf, comparable) => {
    let noPeer = 0;
    let noProfit = 0;
    for (const item of list) {
      const peers = groups.get(groupKey(item)) || [];
      if (peers.length === 0) { noPeer++; continue; }
      if (!peers.some((p) => comparable(otherOf(item), p))) noProfit++;
    }
    return { noPeer, noProfit };
  };

  // 卖出：需要更早且更便宜的买入
  const sells = countBy(
    unSells, buyGroups, (s) => s,
    (sell, buy) => buy.entry_ts.getTime() <= sell.entry_ts.getTime()
      && buy.matchMoney < sell.matchMoney,
  );
  // 买入：需要更晚且更贵的卖出
  const buys = countBy(
    unBuys, sellGroups, (b) => b,
    (buy, sell) => sell.entry_ts.getTime() >= buy.entry_ts.getTime()
      && buy.matchMoney < sell.matchMoney,
  );

  return {
    sellNoBuy: sells.noPeer,
    sellNoProfit: sells.noProfit,
    buyNoSell: buys.noPeer,
    buyNoProfit: buys.noProfit,
  };
}

/**
 * 匹配交易记录（最短持有 / 时间差最小，单遍完成，无需迭代）
 * 对全库所有未匹配记录重算配对，不受调用方查询月份范围限制
 * @param {Object} [opts]
 * @param {boolean} [opts.netFilter=true] - 盈利判定用净额还是毛额
 *   true：买入净成本 < 卖出净所得（真实盈利，与 profit 一致）
 *   false：买入毛额 < 卖出毛额（覆盖更多对，但部分对 net profit 可能为负）
 */
export async function tradeMatch({ netFilter = true } = {}) {
  await withDb(async (db) => {
    const trades = (await db.all(LOAD_UNMATCHED_TRADES)).map((t) => ({
      ...t,
      // DuckDBTimestampValue {micros} → JS Date（epoch 毫秒）
      entry_ts: new Date(Number(t.entry_ts.micros / 1000n)),
      netMoney: netMoneyOf(t),
      matchMoney: matchMoneyOf(t, netFilter),
    }));
    const buys = trades.filter((t) => t.op === OP.BUY);
    const sells = trades.filter((t) => t.op === OP.SELL);

    const pairs = greedyMatch(buys, sells);

    const insertRows = pairs.map(({ buy, sell }) => [
      buy.account_id, buy.account_name,
      String(sell.entry_ts.getFullYear()),
      `${sell.entry_ts.getFullYear()}-${String(sell.entry_ts.getMonth() + 1).padStart(2, "0")}`,
      buy.code, buy.name || sell.name,
      sell.entry_price, buy.entry_price,
      sell.entry_count, buy.entry_count,
      sell.entry_money, buy.entry_money,
      sell.transfer_fee, buy.transfer_fee,
      sell.netMoney - buy.netMoney,
      fmtDateTime(sell.entry_ts), fmtDateTime(buy.entry_ts),
      sell.history_id, buy.history_id,
    ]);
    await batchInsertMatched(db, insertRows);

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

// ============================ 收益查询 ============================

/** 格式化 Date → 'YYYY-MM-DD HH:MM:SS'（DuckDB TIMESTAMP 绑定用） */
function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 查询网格收益（个股/月/年三层）
 * @param {string} startMonth - 开始月份 YYYY-MM
 * @param {string} endMonth - 结束月份 YYYY-MM
 * @returns {Promise<Array>} 结果行
 */
export async function gridProfit(startMonth, endMonth) {
  return await withDb(async (db) =>
    await db.all(GRID_PROFIT, [endMonth, startMonth, endMonth, startMonth.substring(0, 4)]),
  );
}
