/* からだミッション：食費ログ（食事・飲み物・お菓子の支出だけを記録する簡易家計簿）
   ・「買った」と「食べた／飲んだ」は別に記録する。購入しただけでは摂取カロリーに加算しない
   ・購入記録は月ごとに端末内（IndexedDB の kv）へ保存：キー buy:YYYY-MM → 購入の配列
     → 既存のバックアップ／復元にそのまま含まれる
   ・店舗・商品・価格は buyCatalog に学習して、次回は候補から1タップで入力
   データ構造（購入1回＝1件）
   { v:1, id, date:'YYYY-MM-DD', hm:'HH:MM', ts, tz, at:ローカルISO,
     where:'conv|super|drug|restaurant|vending|bakery|other', store:'店舗名',
     items:[{ iid, name, qty, unitPrice|null, total|null, cat:'meal|drink|snack', mealSlot|null,
              productRef:{id,name,store,kcal,protein,url,verifiedAt}|null,
              consumed:[{ cid, qty, date, at, ts, kind:'meal|drink|snack|mission|food', slot }], closed }],
     itemsTotal, paid, paidEdited, priceUnknown, source:'manual|receipt-ai|mission|snack|food', photoId, mealDate, mealSlot, note }
   将来の拡張（月の目標・店舗別・商品別・外食費など）は、この配列を集計するだけで追加できる */
(function(){
  const L = {};
  L.VERSION = 1;
  L.WHERE = [['conv','コンビニ','🏪'],['super','スーパー','🛒'],['drug','ドラッグストア','💊'],['restaurant','飲食店','🍽'],['vending','自販機','🥤'],['bakery','パン屋','🥐'],['other','その他','🛍']];
  L.WHERE_SHORT = { conv:'コンビニ', super:'スーパー', drug:'薬局', restaurant:'外食', vending:'自販機', bakery:'パン屋', other:'その他' };
  L.CATS = [['meal','食事','🍱'],['drink','飲み物','🥤'],['snack','お菓子','🍪']];
  L.CAT_LABEL = { meal:'食事', drink:'飲み物', snack:'お菓子・間食' };
  const norm = s => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  L.norm = norm;
  const rid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  L.rid = rid;
  L.monthKey = date => 'buy:' + date.slice(0, 7);
  L.yen = v => '¥' + Math.round(v || 0).toLocaleString();

  /* ---------- 商品データとの紐付け（登録済みの公式データ） ---------- */
  const PCAT = { '飲料':'drink', '間食':'snack', 'ヨーグルト':'snack' };
  const CCAT = { drink:'drink', alcohol:'drink', dessert:'snack' };
  L.matchProduct = (name, data, store) => {
    const n = norm(name); if (n.length < 2 || !data) return null;
    const sn = norm(store);
    const pool = [
      ...(data.products || []).map(p => ({ id:p.id, name:p.name + (p.flavor && !p.name.includes(p.flavor) ? ' ' + p.flavor : ''), store:p.storeName, kcal:p.nutrition?.kcal ?? null, protein:p.nutrition?.protein ?? null, priceYen:p.priceYen, cat:PCAT[p.category] || 'meal', url:p.officialUrl || null, verifiedAt:p.verifiedAt || null, caffeineMg:p.caffeineMg ?? null })),
      ...(data.chains || []).flatMap(c => (c.items || []).map(i => ({ id:i.id, name:i.name + (i.size ? `（${i.size}）` : ''), store:c.name, kcal:i.source === 'favorite' || i.source === 'menu-photo' ? null : (i.nutrition?.kcal ?? null), protein:i.nutrition?.protein ?? null, priceYen:i.priceYen, cat:CCAT[i.category || i.role] || 'meal', url:i.officialUrl || null, verifiedAt:i.verifiedAt || null })))
    ];
    const sameStore = p => sn && (norm(p.store).includes(sn) || sn.includes(norm(p.store)));
    const exact = pool.filter(p => norm(p.name) === n);
    // 名前が完全に一致した時だけ紐付ける（似た名前の別商品の栄養値を使わない）
    const hit = exact.find(sameStore) || exact[0];
    return hit || null;
  };

  /* カテゴリの推定（ユーザーがいつでも変更できる初期値） */
  const DRINK_RE = /水|ウォーター|お茶|緑茶|麦茶|ほうじ茶|烏龍|ウーロン|紅茶|コーヒー|珈琲|カフェラテ|ラテ|ジュース|ドリンク|サイダー|コーラ|炭酸|牛乳|豆乳|飲料|スポーツ|ビール|ハイボール|サワー|酎|ワイン|スムージー|\d+\s*(ml|ｍｌ|l)\b|ボトル|ペット/i;
  const SNACK_RE = /チョコ|グミ|ガム|飴|キャンディ|ポテチ|ポテトチップ|スナック|クッキー|ビスケット|せんべい|煎餅|あられ|アイス|プリン|ゼリー|ケーキ|シュー|大福|団子|ドーナツ|菓子|おやつ|ナッツ|ヨーグルト|プロテインバー|バー$|まん$/;
  L.guessCat = (name, ref) => {
    if (ref?.cat) return ref.cat;
    const s = name || '';
    if (SNACK_RE.test(s)) return 'snack';
    if (DRINK_RE.test(s)) return 'drink';
    return 'meal';
  };
  L.isPlainDrink = name => /水|ウォーター|お茶|緑茶|麦茶|ほうじ茶|烏龍|ウーロン|無糖|ブラック|炭酸水/.test(name || '') && !/ラテ|ミルク|加糖|微糖|ジュース|スポーツ/.test(name || '');
  L.isCoffee = name => /コーヒー|珈琲|ブラック|カフェラテ|エスプレッソ|BOSS|ジョージア|ワンダ|ルーツ/i.test(name || '');

  /* ---------- 正規化（合計・支払額） ---------- */
  L.normalize = rec => {
    const r = { v:L.VERSION, ...rec };
    r.items = (r.items || []).filter(i => (i.name || '').trim()).map(i => {
      const qty = Math.max(0.5, +i.qty || 1);
      const up = i.unitPrice === '' || i.unitPrice == null || isNaN(+i.unitPrice) ? null : Math.round(+i.unitPrice);
      const used = (i.consumed || []).reduce((a, c) => a + (+c.qty || 0), 0);
      return { iid: i.iid || rid('i'), name: i.name.trim(), qty, unitPrice: up, total: up == null ? null : Math.round(up * qty), cat: i.cat || 'meal', mealSlot: i.mealSlot || null,
        productRef: i.productRef || null, consumed: i.consumed || [], closed: !!i.closed };
    });
    r.itemsTotal = r.items.reduce((a, i) => a + (i.total || 0), 0);
    r.priceUnknown = r.items.filter(i => i.total == null).length;
    r.paid = r.paidEdited && r.paid !== '' && r.paid != null && !isNaN(+r.paid) ? Math.round(+r.paid) : r.itemsTotal;
    if (!r.paidEdited) r.paidEdited = false;
    r.id = r.id || rid('p');
    if (!r.date) { const st = E.stamp(); Object.assign(r, { date:st.date, hm:st.hm, ts:st.ts, tz:st.tz, at:st.iso }); }
    else { const d = new Date(`${r.date}T${r.hm || '12:00'}:00`); r.hm = r.hm || '12:00'; r.ts = d.getTime(); r.tz = E.tzOffset(d); r.at = E.localISO(d); }
    return r;
  };

  /* 支払額を商品ごとに配分（値引き・税の端数があっても合計は支払額と一致させる） */
  L.itemSpend = rec => {
    const items = rec.items || [];
    if (!items.length) return [];
    const base = rec.itemsTotal || 0;
    if (base > 0) return items.map(i => (i.total || 0) * (rec.paid || 0) / base);
    const known = items.length; return items.map(() => (rec.paid || 0) / known);
  };
  L.remaining = it => Math.max(0, (+it.qty || 0) - (it.consumed || []).reduce((a, c) => a + (+c.qty || 0), 0));

  /* ---------- 保存・読み込み ---------- */
  L.loadMonth = async ym => await DB.get('buy:' + ym, []);
  L.monthsBetween = (from, to) => { const out = []; let y = +from.slice(0, 4), m = +from.slice(5, 7); const ey = +to.slice(0, 4), em = +to.slice(5, 7);
    while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } } return out; };
  L.list = async (from, to) => {
    const out = [];
    for (const ym of L.monthsBetween(from, to)) for (const r of await L.loadMonth(ym)) if (r.date >= from && r.date <= to) out.push(r);
    return out.sort((a, b) => b.ts - a.ts);
  };
  L.allMonths = async () => (await DB.keys()).filter(k => /^buy:\d{4}-\d{2}$/.test(k)).map(k => k.slice(4)).sort();
  L.get = async id => {
    for (const ym of (await L.allMonths()).reverse()) { const r = (await L.loadMonth(ym)).find(x => x.id === id); if (r) return r; }
    return null;
  };
  L.save = async (rec, opts = {}) => {
    const r = L.normalize(rec);
    const old = await L.get(r.id);
    const writes = {};
    if (old && L.monthKey(old.date) !== L.monthKey(r.date)) writes[L.monthKey(old.date)] = (await DB.get(L.monthKey(old.date), [])).filter(x => x.id !== r.id);
    const key = L.monthKey(r.date);
    const arr = (writes[key] || await DB.get(key, [])).filter(x => x.id !== r.id);
    arr.push(r); arr.sort((a, b) => a.ts - b.ts); writes[key] = arr;
    if (DB.setMany) await DB.setMany(writes); else for (const [k, v] of Object.entries(writes)) await DB.set(k, v);
    if (opts.learn !== false) await L.learn(r);
    return r;
  };
  L.remove = async id => {
    const r = await L.get(id); if (!r) return false;
    await DB.set(L.monthKey(r.date), (await DB.get(L.monthKey(r.date), [])).filter(x => x.id !== id));
    return r;
  };

  /* ---------- 候補（店舗・商品・価格）の学習 ---------- */
  L.catalog = async () => await DB.get('buyCatalog', { stores:[], items:[] });
  L.learn = async r => {
    const c = await L.catalog();
    if (r.store) {
      const k = norm(r.store); let s = c.stores.find(x => x.key === k);
      if (!s) c.stores.push(s = { key:k, name:r.store, where:r.where, count:0 });
      s.name = r.store; s.where = r.where || s.where; s.count++; s.lastAt = r.ts;
    }
    for (const i of r.items) {
      const k = norm(i.name) + '|' + norm(r.store); let x = c.items.find(y => y.key === k);
      if (!x) c.items.push(x = { key:k, name:i.name, store:r.store || '', count:0 });
      x.name = i.name; x.where = r.where; x.cat = i.cat; x.count++; x.lastAt = r.ts; x.productId = i.productRef?.id || x.productId || null;
      if (i.unitPrice != null) x.price = i.unitPrice;
    }
    c.stores.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)); c.items.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    c.stores = c.stores.slice(0, 80); c.items = c.items.slice(0, 600);
    await DB.set('buyCatalog', c);
  };
  /* よく使う店（最近使った順＋回数）。購入場所を選んでいればその種類を優先 */
  L.recentStores = (c, where) => {
    const sc = s => (s.count || 0) + (s.lastAt || 0) / 864e5 / 30;
    const list = [...c.stores].sort((a, b) => sc(b) - sc(a));
    return (where ? [...list.filter(s => s.where === where), ...list.filter(s => s.where !== where)] : list).slice(0, 8);
  };
  /* 前に買った商品（その店の物を先に。同じ名前は1つにまとめる） */
  L.quickItems = (c, store, limit = 12) => {
    const sn = norm(store), seen = new Set(), out = [];
    const sc = x => (x.count || 0) * 2 + (x.lastAt || 0) / 864e5 / 30;
    const mine = c.items.filter(x => sn && norm(x.store) === sn).sort((a, b) => sc(b) - sc(a));
    const rest = c.items.filter(x => !sn || norm(x.store) !== sn).sort((a, b) => sc(b) - sc(a));
    for (const x of [...mine, ...rest]) { const k = norm(x.name); if (seen.has(k)) continue; seen.add(k); out.push(x); if (out.length >= limit) break; }
    return out;
  };
  L.lastPrice = (c, name, store) => {
    const n = norm(name), s = norm(store);
    const x = c.items.find(y => norm(y.name) === n && norm(y.store) === s) || c.items.find(y => norm(y.name) === n);
    return x?.price ?? null;
  };

  /* ---------- 食べた／飲んだ ---------- */
  L.consume = (rec, iid, qty, info) => {
    const it = rec.items.find(i => i.iid === iid); if (!it) return null;
    const q = Math.min(L.remaining(it), Math.max(0.5, +qty || 1)); if (q <= 0) return null;
    const st = E.stamp();
    const c = { cid: rid('c'), qty: q, date: st.date, at: st.hm, ts: st.ts, ...info };
    it.consumed = [...(it.consumed || []), c];
    return c;
  };

  /* ---------- 期間 ---------- */
  L.ranges = (today = E.today()) => {
    const d = new Date(today + 'T12:00:00');
    const dow = (d.getDay() + 6) % 7;            // 月曜はじまり
    const ym = today.slice(0, 7);
    const pm = new Date(+today.slice(0, 4), +today.slice(5, 7) - 2, 1);
    const pym = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`;
    const pLast = new Date(pm.getFullYear(), pm.getMonth() + 1, 0).getDate();
    const sameDay = Math.min(+today.slice(8, 10), pLast);
    return {
      today: [today, today], week: [E.addDays(today, -dow), today], month: [ym + '-01', today],
      prevMonthSame: [pym + '-01', `${pym}-${String(sameDay).padStart(2, '0')}`], prevMonth: [pym + '-01', `${pym}-${String(pLast).padStart(2, '0')}`]
    };
  };

  /* ---------- 集計 ---------- */
  L.aggregate = recs => {
    const a = { total:0, n:recs.length, byCat:{ meal:0, drink:0, snack:0 }, byWhere:{}, byDay:{}, byItem:{}, priceUnknown:0, visits:{} };
    for (const r of recs) {
      a.total += r.paid || 0;
      a.byWhere[r.where || 'other'] = (a.byWhere[r.where || 'other'] || 0) + (r.paid || 0);
      a.visits[r.where || 'other'] = (a.visits[r.where || 'other'] || 0) + 1;
      a.byDay[r.date] = (a.byDay[r.date] || 0) + (r.paid || 0);
      a.priceUnknown += r.priceUnknown || 0;
      const sp = L.itemSpend(r);
      r.items.forEach((i, k) => {
        a.byCat[i.cat] = (a.byCat[i.cat] || 0) + sp[k];
        const key = norm(i.name);
        const x = a.byItem[key] || (a.byItem[key] = { name:i.name, spend:0, qty:0, times:0, cat:i.cat, where:{} });
        x.spend += sp[k]; x.qty += +i.qty || 0; x.times++; x.where[r.where] = (x.where[r.where] || 0) + sp[k];
      });
    }
    return a;
  };
  /* 場所×カテゴリの金額（例：コンビニの飲み物） */
  L.spendWhereCat = (recs, where, cat) => recs.reduce((s, r) => r.where !== where ? s : s + L.itemSpend(r).reduce((t, v, k) => t + (r.items[k].cat === cat ? v : 0), 0), 0);
  L.countWith = (recs, pred) => recs.filter(r => r.items.some(pred)).length;

  /* ---------- お金 × 食生活の分析（責めない表現だけ） ---------- */
  L.insights = ({ month, prevSame, week }) => {
    const am = L.aggregate(month), ap = L.aggregate(prevSame);
    const hl = [];
    const convDrink = L.spendWhereCat(month, 'conv', 'drink');
    if (convDrink > 0) hl.push({ em:'🏪', label:'コンビニの飲み物', v:convDrink });
    const top = Object.values(am.byItem).filter(x => x.times >= 2).sort((a, b) => b.spend - a.spend)[0];
    if (top) hl.push({ em:top.cat === 'drink' ? '🥤' : top.cat === 'snack' ? '🍪' : '🍱', label:`${top.name}（${Math.round(top.qty)}${top.cat === 'drink' ? '本' : '個'}）`, v:top.spend });
    if (am.byCat.snack > 0) hl.push({ em:'🍪', label:'お菓子・間食', v:am.byCat.snack });
    if (am.byWhere.restaurant > 0) hl.push({ em:'🍽', label:'外食', v:am.byWhere.restaurant });
    const cm = [];
    const dd = Math.round(am.byCat.drink - ap.byCat.drink);
    if (ap.n && Math.abs(dd) >= 300) cm.push(`今月は飲み物に先月の同じ時期より${Math.abs(dd).toLocaleString()}円${dd > 0 ? '多く' : '少なく'}使っています`);
    const sd = Math.round(am.byCat.snack - ap.byCat.snack);
    if (ap.n && Math.abs(sd) >= 300) cm.push(`お菓子は先月の同じ時期より${Math.abs(sd).toLocaleString()}円${sd > 0 ? '多め' : '少なめ'}です`);
    const snackW = L.countWith(week, i => i.cat === 'snack');
    if (snackW) cm.push(`お菓子の購入は今週${snackW}回`);
    if (am.visits.conv) cm.push(`コンビニ利用は今月${am.visits.conv}回`);
    const mission = month.filter(r => r.source === 'mission').length;
    if (mission) cm.push(`指令どおりの買い物は今月${mission}回（${L.yen(month.filter(r => r.source === 'mission').reduce((s, r) => s + r.paid, 0))}）`);
    const coffee = Object.values(am.byItem).filter(x => L.isCoffee(x.name));
    const cq = coffee.reduce((s, x) => s + x.qty, 0);
    if (cq >= 3) cm.push(`買ったコーヒーは今月${Math.round(cq)}本（${L.yen(coffee.reduce((s, x) => s + x.spend, 0))}）`);
    return { highlights: hl.slice(0, 4), comments: cm.slice(0, 4) };
  };

  /* 買い置き（まだ食べ切っていない物）。指令で買った物は食事として記録済みなので出さない。食事（弁当など）は2日以内の物だけ */
  L.stock = (recs, today = E.today(), days = 21) => {
    const from = E.addDays(today, -days), out = [];
    for (const r of recs) { if (r.date < from || r.source === 'mission' || r.source === 'food') continue;
      for (const i of r.items) if (!i.closed && L.remaining(i) > 0 && (i.cat !== 'meal' || r.date >= E.addDays(today, -2))) out.push({ rec:r, item:i }); }
    return out;
  };

  /* ---------- レシートAIの読み取り結果 → 確認用の下書き（自動確定しない） ---------- */
  L.fromReceipt = (r, data) => {
    const items = [], excluded = [];
    for (const x of (r.items || [])) {
      if (!x || !x.name) continue;
      const qty = Math.max(1, Math.round(+x.qty || 1));
      let up = x.unitPrice != null && !isNaN(+x.unitPrice) ? +x.unitPrice : (x.total != null && !isNaN(+x.total) ? +x.total / qty : null);
      if (x.isFood === false) { excluded.push({ name:x.name, total:x.total ?? (up != null ? up * qty : null) }); continue; }
      const ref = L.matchProduct(x.name, data, r.store);
      items.push({ iid: rid('i'), name: String(x.name).slice(0, 60), qty, unitPrice: up == null ? null : Math.round(up), cat: ['meal','drink','snack'].includes(x.category) ? x.category : L.guessCat(x.name, ref), productRef: ref ? L.refOf(ref) : null, consumed: [] });
    }
    let date = null, hm = null;
    const m = String(r.datetime || '').match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2}))?/);
    if (m) { date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; if (m[4]) hm = `${m[4].padStart(2, '0')}:${m[5]}`; }
    const foodTotal = items.reduce((s, i) => s + (i.unitPrice || 0) * i.qty, 0);
    return { store: r.store || '', where: r.where && L.WHERE.some(w => w[0] === r.where) ? r.where : null, date, hm, items, excluded, receiptTotal: r.total ?? null, paid: excluded.length ? foodTotal : (r.total ?? foodTotal), paidEdited: !excluded.length && r.total != null && Math.round(r.total) !== Math.round(foodTotal) };
  };
  L.refOf = p => p ? { id:p.id, name:p.name, store:p.store, kcal:p.kcal ?? null, protein:p.protein ?? null, url:p.url || null, verifiedAt:p.verifiedAt || null } : null;
  L.whereOfStore = (name, data) => {
    const s = norm(name);
    if ((data?.convenience || []).some(c => c.aliases.some(a => s.includes(norm(a)))) || /ローソン|ファミマ|ファミリーマート|セブン|ミニストップ|デイリー|セイコーマート|ポプラ|newdays/i.test(name)) return 'conv';
    if (/マツモトキヨシ|マツキヨ|ウエルシア|ツルハ|スギ薬局|サンドラッグ|ココカラ|コスモス|クリエイト|カワチ|ドラッグ|薬局/.test(name)) return 'drug';
    if (/イオン|イトーヨーカドー|西友|ライフ|マルエツ|サミット|ヤオコー|オーケー|業務スーパー|まいばすけっと|成城石井|スーパー|ベルク|ヨークマート|東急ストア|コープ|生協/.test(name)) return 'super';
    if (/ベーカリー|パン|ブーランジェリー|boulangerie|bakery/i.test(name)) return 'bakery';
    if ((data?.chains || []).some(c => (c.aliases || [c.name]).some(a => s.includes(norm(a))))) return 'restaurant';
    return null;
  };

  window.L = L;
})();
