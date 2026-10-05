/* からだミッション：店舗・メニュー・商品のJSON一括取り込み
   流れ：読み込み → 検証 → 差分プレビュー（登録/更新/重複/エラー件数）→ 確認後に1回の書き込み
   書き込みは1トランザクションで行い、途中で失敗した場合は既存データを変更しない */
(function(){
  const I = {};
  const CONV = ['seven', 'lawson', 'famima'];
  const CONV_NAME = { seven:'セブン-イレブン', lawson:'ローソン', famima:'ファミリーマート' };
  const GENRES = ['牛丼・定食','寿司','中華・麺類','ファミレス・カレー','ファストフード・カフェ','居酒屋','個人店','その他'];
  const ITEM_CATS = ['main','side','drink','alcohol','dessert'];
  const PROD_CATS = ['おにぎり','弁当','パン','サンドイッチ','サラダ','肉料理','魚料理','惣菜','麺類','スープ','ヨーグルト','間食','飲料'];
  I.GENRES = GENRES;

  const isNum = v => v === null || v === undefined || (typeof v === 'number' && isFinite(v) && v >= 0);
  const okDate = v => v == null || /^\d{4}-\d{2}-\d{2}$/.test(v);
  const okUrl = v => v == null || v === '' || /^https?:\/\/\S+$/.test(v);
  const idOk = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 120 && !/[\s#?]/.test(v);
  const num = v => (v === '' || v === undefined) ? null : v;

  function normNut(n){
    n = n || {};
    return { kcal:num(n.kcal), protein:num(n.protein), fat:num(n.fat), carbs:num(n.carbs), salt:num(n.salt) };
  }
  function checkNut(n, where, errs){
    for (const k of ['kcal','protein','fat','carbs','salt']) if (!isNum(n[k])) errs.push(`${where}：栄養成分 ${k} は数値かnullにしてください`);
    if (n.kcal != null && n.kcal > 4000) errs.push(`${where}：kcal が大きすぎます（${n.kcal}）`);
    if (n.salt != null && n.salt > 30) errs.push(`${where}：食塩相当量 が大きすぎます（${n.salt}）`);
  }
  function normAllergens(a){
    if (!a || typeof a !== 'object') return { status:'unknown', contains:[] };
    const status = a.status === 'confirmed' ? 'confirmed' : 'unknown';
    return { status, contains: Array.isArray(a.contains) ? a.contains.map(String) : [], mayContain: Array.isArray(a.mayContain) ? a.mayContain.map(String) : [], source: a.source || null };
  }
  function normItem(x, store, errs, warn){
    const where = `${store.name}／${x?.name || x?.id || '(名称なし)'}`;
    if (!x || typeof x !== 'object') { errs.push(`${store.name}：料理データの形式が不正です`); return null; }
    const e0 = errs.length;
    if (!idOk(x.id)) errs.push(`${where}：id がありません（空白・#・?は使えません）`);
    if (!x.name || typeof x.name !== 'string') errs.push(`${where}：name（料理名）がありません`);
    const nut = normNut(x.nutrition); checkNut(nut, where, errs);
    if (!isNum(x.priceYen)) errs.push(`${where}：priceYen は数値かnullにしてください`);
    if (!okUrl(x.officialUrl)) errs.push(`${where}：officialUrl が不正です`);
    if (!okDate(x.verifiedAt)) errs.push(`${where}：verifiedAt は YYYY-MM-DD 形式にしてください`);
    if (errs.length > e0) return null;
    let cat = x.category; if (!ITEM_CATS.includes(cat)) { if (cat) warn.push(`${where}：category「${cat}」は main 扱いにしました`); cat = 'main'; }
    return {
      id: x.id.trim(), name: x.name.trim(), size: x.size || null, category: cat, role: cat === 'main' ? 'main' : cat,
      priceYen: num(x.priceYen), nutrition: nut, allergens: normAllergens(x.allergens), tags: Array.isArray(x.tags) ? x.tags : [],
      officialUrl: x.officialUrl || null, verifiedAt: x.verifiedAt || null, status: x.status === 'discontinued' ? 'discontinued' : 'active',
      limited: !!x.limited, storeOnly: x.storeOnly || null, note: x.note || null, source: 'import'
    };
  }
  function normStore(s, errs, warn){
    const where = `店舗「${s?.name || s?.id || '(名称なし)'}」`;
    if (!s || typeof s !== 'object') { errs.push('店舗データの形式が不正です'); return null; }
    const e0 = errs.length;
    if (!idOk(s.id)) errs.push(`${where}：id がありません（空白・#・?は使えません）`);
    if (!s.name || typeof s.name !== 'string') errs.push(`${where}：name（店名）がありません`);
    if (s.lat != null && !(typeof s.lat === 'number' && Math.abs(s.lat) <= 90)) errs.push(`${where}：lat が不正です`);
    if (s.lon != null && !(typeof s.lon === 'number' && Math.abs(s.lon) <= 180)) errs.push(`${where}：lon が不正です`);
    if (!okUrl(s.officialUrl)) errs.push(`${where}：officialUrl が不正です`);
    if (!okDate(s.verifiedAt)) errs.push(`${where}：verifiedAt は YYYY-MM-DD 形式にしてください`);
    if (errs.length > e0) return null;
    const type = s.type === 'local' ? 'local' : 'chain';
    let genre = s.genre; if (!GENRES.includes(genre)) { if (genre) warn.push(`${where}：genre「${genre}」は「${type === 'local' ? '個人店' : 'その他'}」にしました`); genre = type === 'local' ? '個人店' : 'その他'; }
    return {
      id: s.id.trim(), name: s.name.trim(), type, genre, aliases: Array.isArray(s.aliases) && s.aliases.length ? s.aliases.map(String) : [s.name.trim()],
      address: s.address || null, lat: s.lat ?? null, lon: s.lon ?? null, officialUrl: s.officialUrl || null, verifiedAt: s.verifiedAt || null,
      sushi: !!s.sushi, note: s.note || null, source: 'import', itemsIn: Array.isArray(s.items) ? s.items : []
    };
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const strip = o => { const { itemsIn, ...r } = o; return r; };

  /* 既存データ（同梱 chains.json＋取り込み済み）と比較して差分を作る */
  I.analyze = (json, current) => {
    const errs = [], warn = [];
    const plan = { stores:{ add:0, update:0, dup:0 }, items:{ add:0, update:0, dup:0 }, products:{ add:0, update:0, dup:0 }, errors:errs, warnings:warn, newStores:{}, newProducts:[] };
    if (!json || typeof json !== 'object') { errs.push('JSONの中身が空か、形式が違います'); return plan; }
    if (json.format && json.format !== 'karada-data') errs.push(`format が「karada-data」ではありません（${json.format}）`);
    const stores = Array.isArray(json.stores) ? json.stores : [];
    const products = Array.isArray(json.products) ? json.products : Array.isArray(json) ? json : [];
    if (!stores.length && !products.length) errs.push('stores も products も見つかりません');
    const seenStore = new Set();
    const custom = JSON.parse(JSON.stringify(current.customStores || {}));
    for (const raw of stores) {
      const s = normStore(raw, errs, warn); if (!s) continue;
      if (seenStore.has(s.id)) { errs.push(`店舗id「${s.id}」がファイル内で重複しています（2つ目以降は無視）`); continue; }
      seenStore.add(s.id);
      const builtIn = current.builtInStores[s.id];
      const prev = custom[s.id];
      const base = prev || (builtIn ? { ...builtIn, items:{} } : null);
      const meta = strip(s);
      if (!base) plan.stores.add++;
      else {
        const prevMeta = prev ? (({ items, ...r }) => r)(prev) : null;
        if (prevMeta && same(prevMeta, { ...prevMeta, ...meta })) plan.stores.dup++; else plan.stores.update++;
      }
      const target = { ...(base ? (({ items, ...r }) => r)(base) : {}), ...meta, items: { ...(prev?.items || {}) } };
      const seenItem = new Set();
      for (const rawItem of s.itemsIn) {
        const it = normItem(rawItem, s, errs, warn); if (!it) continue;
        if (seenItem.has(it.id)) { errs.push(`${s.name}：料理id「${it.id}」がファイル内で重複しています`); continue; }
        seenItem.add(it.id);
        const old = prev?.items?.[it.id] || builtIn?.itemsById?.[it.id];
        if (!old) plan.items.add++;
        else if (same({ ...old, source:'import' }, it) || same(old, it)) plan.items.dup++;
        else plan.items.update++;
        target.items[it.id] = it;
      }
      plan.newStores[s.id] = target;
    }
    const prodMap = new Map((current.customProducts || []).map(p => [p.id, p]));
    const seenP = new Set();
    for (const p of products) {
      const where = `商品「${p?.name || p?.id || '(名称なし)'}」`; const e0 = errs.length;
      if (!p || !idOk(p.id)) errs.push(`${where}：id がありません`);
      else if (!CONV.includes(p.store)) errs.push(`${where}：store は ${CONV.join(' / ')} のいずれか`);
      if (!p?.name) errs.push(`${where}：name がありません`);
      if (p?.category && !PROD_CATS.includes(p.category)) errs.push(`${where}：category「${p.category}」は使えません（${PROD_CATS.join('、')}）`);
      const nut = normNut(p?.nutrition); checkNut(nut, where, errs);
      if (!okUrl(p?.officialUrl)) errs.push(`${where}：officialUrl が不正です`);
      if (errs.length > e0) continue;
      if (seenP.has(p.id)) { errs.push(`${where}：id がファイル内で重複しています`); continue; }
      seenP.add(p.id);
      const rec = { id:p.id, store:p.store, storeName:CONV_NAME[p.store], name:p.name, flavor:p.flavor || null, size:p.size || null, category:p.category || '惣菜',
        priceYen:num(p.priceYen), nutrition:nut, allergens:normAllergens(p.allergens), caffeineMg:num(p.caffeineMg), region:p.region || null,
        status:p.status === 'discontinued' ? 'discontinued' : 'active', verifiedAt:p.verifiedAt || null, officialUrl:p.officialUrl || null, image:null, note:p.note || null, source:'import' };
      const old = prodMap.get(p.id) || current.builtInProducts[p.id];
      if (!old) plan.products.add++; else if (same(old, rec)) plan.products.dup++; else plan.products.update++;
      plan.newProducts.push(rec);
    }
    plan.validCount = Object.keys(plan.newStores).length + plan.newProducts.length;
    return plan;
  };

  /* 取り込み実行：1回の書き込み（失敗時は何も変わらない） */
  I.commit = async (plan, current) => {
    const stores = { ...(current.customStores || {}), ...plan.newStores };
    const pm = new Map((current.customProducts || []).map(p => [p.id, p]));
    for (const p of plan.newProducts) pm.set(p.id, p);
    const log = await DB.get('importLog', []);
    log.push({ at:E.localISO(), stores:plan.stores, items:plan.items, products:plan.products, errors:plan.errors.length });
    await DB.setMany({ customStores: stores, customProducts: [...pm.values()], importLog: log.slice(-30) });
  };

  I.SAMPLE = {
    format: 'karada-data', version: 1, generatedBy: 'ChatGPT', generatedAt: '2026-10-05',
    stores: [
      { id:'tenya', name:'天丼てんや', type:'chain', genre:'牛丼・定食', aliases:['天丼てんや','てんや','Tenya'], address:null, lat:null, lon:null,
        officialUrl:'https://（公式メニューページのURL）', verifiedAt:'2026-10-05',
        items:[
          { id:'tenya-yasai-tendon-nami', name:'野菜天丼', size:'並', category:'main', priceYen:null,
            nutrition:{ kcal:null, protein:null, fat:null, carbs:null, salt:null },
            allergens:{ status:'unknown', contains:[] }, officialUrl:null, verifiedAt:'2026-10-05', status:'active', limited:false,
            note:'例：公式で確認できない値は null のまま' }
        ] },
      { id:'local-ekimae-shokudo', name:'駅前食堂', type:'local', genre:'個人店', aliases:['駅前食堂'], address:'○○市○○町1-2-3', lat:35.0000, lon:139.0000,
        officialUrl:null, verifiedAt:'2026-10-05',
        items:[
          { id:'saba-teishoku', name:'さば塩焼き定食', size:null, category:'main', priceYen:900,
            nutrition:{ kcal:null, protein:null, fat:null, carbs:null, salt:null }, allergens:{ status:'unknown', contains:[] },
            officialUrl:null, verifiedAt:'2026-10-05', status:'active' }
        ] }
    ],
    products: []
  };

  I.PROMPT = `あなたは食事データの調査担当です。私が送る店名について、公式サイト（公式メニュー・公式の栄養成分表・公式アレルゲン表）だけを調べ、iPhoneアプリ「からだミッション」に読み込ませるJSONファイルを1つ作ってください。

【絶対ルール】
1. 公式情報で確認できない料理・価格・栄養成分・アレルゲンを作らない。推測・平均値・他サイトの値で埋めない。不明は null。
2. アレルゲンは公式のアレルゲン表で確認できた時だけ allergens.status を "confirmed" にし、contains に含まれる品目（例：小麦、卵、乳、えび、かに、そば、落花生、くるみ、大豆、さば、さけ、いか、ごま、牛肉、豚肉、鶏肉 など）を書く。確認できなければ "unknown"。
3. 価格は税込（店内）の円。地域・店舗で違う場合は代表的な値を入れ、note に「地域差あり」と書く。
4. サイズ違いは別の料理として登録（id を変える。例 gyudon-nami / gyudon-ohmori）。
5. id は半角英数字とハイフンのみ。店舗 id は店名のローマ字（例 tenya）。既存チェーンは次の id を使う：
   yoshinoya, sukiya, matsuya, yayoiken, ootoya, sushiro, kurasushi, hamasushi, kappasushi, ohsho, hidakaya, bamiyan, marugame, gusto, saizeriya, cocos, dennys, cocoichi, mcdonalds, mos, subway, starbucks
6. 同じ id のデータは上書き更新になる。前回と同じ料理は同じ id を使う。
7. verifiedAt には公式ページを確認した日（YYYY-MM-DD）。
8. category は main（主食・主菜）/ side（副菜・汁物・サラダ）/ drink（ソフトドリンク）/ alcohol / dessert のどれか。
9. genre は 牛丼・定食 / 寿司 / 中華・麺類 / ファミレス・カレー / ファストフード・カフェ / 居酒屋 / 個人店 / その他 のどれか。
10. 寿司チェーンは sushi: true を付け、ネタは1皿を1料理として登録。
11. 個人経営の店は type を "local" にし、住所が分かれば address、緯度経度が公式・地図で確認できれば lat/lon（分からなければ null）。
12. 出力は下の形式のJSONだけ。説明文やコメントは入れない。ファイル名は stores-（店のid）-（日付）.json にしてダウンロードできる形で出す。
13. 最後に別メッセージで、確認に使った公式URLの一覧と、null にした項目の数を教えて。

【形式】
{
  "format": "karada-data",
  "version": 1,
  "generatedBy": "ChatGPT",
  "generatedAt": "YYYY-MM-DD",
  "stores": [
    {
      "id": "tenya",
      "name": "天丼てんや",
      "type": "chain",
      "genre": "牛丼・定食",
      "aliases": ["天丼てんや", "てんや", "Tenya"],
      "address": null, "lat": null, "lon": null,
      "officialUrl": "https://...",
      "verifiedAt": "YYYY-MM-DD",
      "sushi": false,
      "items": [
        {
          "id": "tenya-yasai-tendon-nami",
          "name": "野菜天丼",
          "size": "並",
          "category": "main",
          "priceYen": 0,
          "nutrition": { "kcal": null, "protein": null, "fat": null, "carbs": null, "salt": null },
          "allergens": { "status": "unknown", "contains": [] },
          "officialUrl": "https://...",
          "verifiedAt": "YYYY-MM-DD",
          "status": "active",
          "limited": false,
          "note": null
        }
      ]
    }
  ],
  "products": []
}

コンビニ商品（セブン/ローソン/ファミマ）を追加する時は "stores" を空配列にし、"products" に次の形式で入れる：
{ "id":"seven-（公式の商品番号）", "store":"seven", "name":"正式名称", "flavor":null, "size":null, "category":"おにぎり", "priceYen":0,
  "nutrition":{"kcal":null,"protein":null,"fat":null,"carbs":null,"salt":null}, "allergens":{"status":"unknown","contains":[]},
  "region":"公式記載の販売地域", "officialUrl":"https://...", "verifiedAt":"YYYY-MM-DD", "status":"active" }
store は seven / lawson / famima、category は おにぎり・弁当・パン・サンドイッチ・サラダ・肉料理・魚料理・惣菜・麺類・スープ・ヨーグルト・間食・飲料 のどれか。

調べる店：`;

  window.I = I;
})();
