import { withDb } from './db.js';

async function getYaoMingBi() {
  return await withDb(async (conn) => {
    const rows = await conn.all("SELECT * FROM t_trade_matched_record WHERE code = '02269' ORDER BY sell_time DESC LIMIT 1");
    return rows[0];
  });
}

getYaoMingBi().then(row => {
  if (!row) { console.log('No data'); return; }
  
  const sellTime = new Date(Number(row.sell_time.micros) / 1000);
  const sellPrice = parseFloat(row.sell_entry_price.toString());
  const buyPrice = parseFloat(row.buy_entry_price.toString());
  const count = parseInt(row.sell_entry_count);
  const profit = parseFloat(row.profit.toString());
  
  console.log('=== 药明生物 (02269) 最近一笔网格收益 ===');
  console.log('卖出时间:', row.sell_time, '(', sellTime.toLocaleTimeString(), ')');
  console.log('卖出价格:', sellPrice.toFixed(4), '元/股');
  console.log('买入价格:', buyPrice.toFixed(4), '元/股');
  console.log('交易数量:', count, '股');
  console.log('单股理论收益:', (sellPrice - buyPrice).toFixed(4), '元');
  console.log('理论总收益:', ((sellPrice - buyPrice) * count).toFixed(2), '元');
  console.log('✅ 实际网格收益:', profit.toFixed(2), '元（已扣除买卖手续费净额）');
}).catch(e => console.error(e));