/* からだミッション：計算・ミッション生成エンジン（オフラインで動作） */
(function(){
  const E = {};

  /* ---------- 日付 ---------- */
  E.today = () => E.ymd(new Date());
  E.ymd = d => { const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; };
  E.addDays = (ymd, n) => { const d = new Date(ymd+'T12:00:00'); d.setDate(d.getDate()+n); return E.ymd(d); };
  E.daysBetween = (a, b) => Math.round((new Date(b+'T12:00:00') - new Date(a+'T12:00:00')) / 864e5);

  /* ---------- 乱数（日付＋食事＋変更回数で固定。同じ条件なら同じ提案） ---------- */
  E.rng = seedStr => { let h = 2166136261; for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ t>>>15, t|1); t ^= t + Math.imul(t ^ t>>>7, t|61); return ((t ^ t>>>14)>>>0) / 4294967296; }; };

  /* ---------- 目標の計算（無理のない減量ペース） ---------- */
  const ACT = { low:{f:1.2,label:'ほぼ座り仕事'}, mid:{f:1.375,label:'少し歩く'}, high:{f:1.55,label:'よく動く'}, vhigh:{f:1.725,label:'かなり動く'} };
  E.ACT = ACT;
  E.calcTargets = p => {
    const w = +p.weightKg, h = +p.heightCm, a = +p.age || 40;
    const male = p.sex !== 'female';
    const bmr = Math.round(10*w + 6.25*h - 5*a + (male ? 5 : -161));      // Mifflin-St Jeor
    const tdee = Math.round(bmr * (ACT[p.activity]?.f || 1.375));
    const toLose = Math.max(0, w - (+p.goalKg || w));
    const weeks = p.goalDate ? Math.max(1, E.daysBetween(E.today(), p.goalDate) / 7) : 12;
    const wanted = toLose / weeks;                                     // kg/週
    const safeMax = Math.min(0.75, w * 0.007);                          // 体重の0.7%/週 かつ 0.75kg/週 まで
    const pace = Math.min(wanted, safeMax);
    let deficit = Math.round(pace * 7200 / 7);
    deficit = Math.min(deficit, Math.round(tdee * 0.25), 750);
    const floor = male ? 1500 : 1200;
    let kcal = Math.max(tdee - deficit, bmr, floor);
    kcal = Math.round(kcal / 10) * 10;
    const realDeficit = tdee - kcal;
    const realPace = realDeficit * 7 / 7200;
    const weeksNeeded = realPace > 0 ? Math.ceil(toLose / realPace) : null;
    const suggestDate = weeksNeeded ? E.addDays(E.today(), weeksNeeded*7) : null;
    const protein = Math.max(60, Math.round(w * 1.2));
    const waterMl = Math.round(w * 30 / 100) * 100;
    return { bmr, tdee, kcal, deficit: realDeficit, pacePerWeek: +realPace.toFixed(2), wantedPace:+wanted.toFixed(2),
      tooFast: wanted > safeMax + 0.01, suggestDate, protein, waterMl, salt: male ? 7.5 : 6.5, stepsGoal: 8000 };
  };

  /* 予定に応じた1日の目標（運動日は食べる量を増やす。歩数ミッションは出さない） */
  E.dayTargets = (base, sched) => {
    const t = { ...base, extra:0, steps: true };
    if (!sched) return t;
    if (sched.type === 'golf') { t.extra = 450; t.steps = false; t.waterMl += 1000; }
    if (sched.type === 'softball') {
      const lv = sched.softball?.intensity || 'game';
      t.extra = lv === 'practice' ? 250 : 350; t.steps = false; t.waterMl += 700;
      if ((+sched.softball?.temp || 0) >= 28) t.waterMl += 500;
    }
    if (sched.type === 'travel') t.steps = true;
    t.kcal = base.kcal + t.extra;
    return t;
  };
  E.mealShare = { breakfast:0.25, lunch:0.35, dinner:0.30, snack:0.10 };
  E.MEAL_LABEL = { breakfast:'朝食', lunch:'昼食', dinner:'夕食', snack:'間食' };
  E.SCHED = { work:{label:'仕事',em:'💼'}, golf:{label:'ゴルフ',em:'⛳'}, softball:{label:'ソフトボール',em:'🥎'}, holiday:{label:'休日',em:'🏖'}, travel:{label:'出張・旅行',em:'🧳'} };

  /* ---------- 地域 ---------- */
  E.AREAS = ['北海道','東北','関東','甲信越','北陸','東海','近畿','中国','四国','九州','沖縄'];
  const AREA_ALIAS = { '近畿':['近畿','関西'], '中国':['中国','中四国','中国・四国','中国四国'], '四国':['四国','中四国','中国・四国','中国四国'] };
  E.regionOk = (region, area, pref) => {
    if (!region) return { ok:true, unknown:true };
    if (!area) return { ok:true };
    const names = [...(AREA_ALIAS[area] || [area]), pref].filter(Boolean);
    // かっこ内の除外（例：九州（宮崎県・鹿児島県除く）、全国(沖縄除く)）
    for (const m of region.matchAll(/[（(]([^）)]*)[）)]/g)) {
      if (/除/.test(m[1]) && names.some(n => m[1].includes(n))) return { ok:false };
    }
    const outer = region.replace(/[（(][^）)]*[）)]/g, '');
    if (/除/.test(outer)) {
      // 「〇〇を除く」：除外部分に自分の地域が含まれていたら対象外
      const exPart = outer.split(/除/)[0];
      return { ok: !names.some(n => exPart.includes(n)) };
    }
    if (/全国/.test(outer)) return { ok:true };
    return { ok: names.some(n => outer.includes(n)) };
  };

  /* ---------- 好き嫌い・アレルギー ----------
     商品名だけで「安全」とは判断しない。
     ・名前に該当語がある → 除外
     ・公式アレルゲン情報が確認済み（allergens.status=confirmed）で含まない → 使える
     ・アレルゲン未確認 → アレルギー登録がある人には出さない（設定で「表示してラベル確認」に変更可） */
  const ALLERGY_WORDS = {
    'えび':['えび','海老','エビ','シュリンプ'], 'かに':['かに','蟹','カニ','カニカマ'], '小麦':['パン','サンド','うどん','麺','パスタ','ブラン','ラーメン','焼そば','天','フライ','唐揚','から揚','チキン南蛮','ちゃんぽん','カツ'],
    '卵':['たまご','玉子','卵','タマゴ','エッグ','マヨ','親子'], '乳':['チーズ','ヨーグルト','乳','ミルク','ラテ','バター','クリーム'], 'そば':['そば','蕎麦'], '落花生':['ピーナッツ','落花生'],
    'さば':['さば','鯖','サバ'], 'さけ':['鮭','さけ','しゃけ','サーモン'], 'いか':['いか','イカ'], '大豆':['豆腐','納豆','大豆','枝豆','豆'], 'ごま':['ごま','胡麻','ゴマ'], '牛肉':['牛'], '豚肉':['豚','ハム','ベーコン','ソーセージ','ポーク'], '鶏肉':['鶏','チキン','とり','ささみ','親子'],
    'くるみ':['くるみ','クルミ','胡桃'], 'キウイ':['キウイ'], 'バナナ':['バナナ'], 'もも':['もも','桃','ピーチ'], 'りんご':['りんご','アップル'], 'ゼラチン':['ゼリー','ゼラチン']
  };
  E.ALLERGENS = Object.keys(ALLERGY_WORDS);
  E.blocked = (name, prof) => {
    const n = name || '';
    for (const a of (prof.allergies || [])) for (const w of (ALLERGY_WORDS[a] || [a])) if (n.includes(w)) return 'アレルギー:' + a;
    for (const d of (prof.dislikesList || [])) if (d && n.includes(d)) return '苦手:' + d;
    return null;
  };
  /* 'ok' | 'blocked' | 'unverified'（アレルギー登録なしなら常に ok） */
  E.allergyStatus = (item, prof) => {
    const al = prof.allergies || [];
    if (E.blocked(item.name, prof)) return 'blocked';
    if (!al.length) return 'ok';
    const A = item.allergens;
    if (A && A.status === 'confirmed') {
      const hit = al.some(a => (A.contains || []).includes(a) || (A.mayContain || []).includes(a));
      return hit ? 'blocked' : 'ok';
    }
    return 'unverified';
  };

  /* ---------- 商品の役割 ---------- */
  E.role = p => {
    const c = p.category, n = p.nutrition || {};
    if (c === '飲料') return 'drink';
    if (['おにぎり','弁当','麺類','サンドイッチ','パン'].includes(c)) return 'main';
    if (c === 'サラダ' && (n.kcal ?? 0) >= 280) return 'main';
    if (c === 'サラダ' || c === 'スープ') return 'veg';
    if (['肉料理','魚料理'].includes(c)) return 'protein';
    if (c === '惣菜') return (n.protein ?? 0) >= 7 ? 'protein' : 'veg';
    if (c === 'ヨーグルト' || c === '間食') return 'snack';
    return 'other';
  };
  const isDrinkWaterTea = p => /水|茶|ルイボス|炭酸水/.test(p.name) && !/ミルク|ラテ|果汁|レモン/.test(p.name);

  /* ---------- 候補の絞り込み ---------- */
  E.pool = (products, store, prof, opts={}) => products.filter(p => {
    if (p.store !== store || p.status === 'discontinued') return false;
    if (!E.regionOk(p.region, prof.area, prof.pref).ok) return false;
    if ((opts.exclude || []).includes(p.id) || (opts.soldout || []).includes(p.id)) return false;
    const a = E.allergyStatus(p, prof);
    if (a === 'blocked') return false;
    if (a === 'unverified' && !prof.allowUnverifiedAllergen) return false;
    return true;
  });
  E.poolStats = (products, store, prof) => {
    const all = products.filter(p => p.store === store && p.status !== 'discontinued' && E.regionOk(p.region, prof.area, prof.pref).ok);
    const unv = all.filter(p => E.allergyStatus(p, prof) === 'unverified').length;
    return { all: all.length, unverified: unv };
  };

  const sumN = items => {
    const s = { kcal:0, protein:0, fat:0, carbs:0, salt:0, price:0, unknown:0, unknownNames:[], priceUnknown:0 };
    for (const it of items) {
      const n = it.nutrition || {}; const q = it.qty || 1;
      const isWater = it.role === 'drink' && isDrinkWaterTea(it);
      if (!isWater && (n.kcal == null || n.protein == null)) { s.unknown++; s.unknownNames.push(it.name); }
      for (const k of ['kcal','protein','fat','carbs','salt']) s[k] += +(n[k] || 0) * q;
      if (it.priceYen == null) s.priceUnknown++; else s.price += +it.priceYen * q;
    }
    for (const k of ['kcal','protein','fat','carbs','salt']) s[k] = Math.round(s[k]*10)/10;
    s.complete = s.unknown === 0;
    return s;
  };
  E.sumN = sumN;
  /* 目標との比較。栄養不明があれば「達成」と断定しない */
  E.verdict = (sum, kcalT, protT) => {
    if (!sum) return '';
    if (!sum.complete) return `栄養成分が不明な商品（${sum.unknownNames.join('・')}）があるため、目標を満たしているかは判断できません。合計は確認できた分だけです。`;
    const k = sum.kcal, p = sum.protein; const msgs = [];
    if (kcalT) msgs.push(k < kcalT * 0.8 ? `目標${kcalT}kcalより少なめ` : k > kcalT * 1.2 ? `目標${kcalT}kcalより多め` : `目標${kcalT}kcal前後`);
    if (protT) msgs.push(p >= protT ? `たんぱく質は目標${protT}g以上` : `たんぱく質は目標${protT}gに${Math.round((protT - p)*10)/10}g不足`);
    return msgs.join('・') + '（公式表示の合計。水・無糖茶は計算に含めていません）';
  };
  E.shortStore = n => ({ 'セブン-イレブン':'セブン', 'ファミリーマート':'ファミマ' })[n] || n;
  const label = i => (i.flavor ? `${i.name}（${i.flavor}）` : i.name) + (i.size && !i.name.includes(i.size) ? `〔${i.size}〕` : '');
  E.convCmd = (storeName, items) => {
    const food = items.filter(i => i.role !== 'drink').map(i => `${label(i)}を${i.qty || 1}個`);
    const d = items.find(i => i.role === 'drink');
    return `${E.shortStore(storeName)}で、${food.join('、')}${d ? `、飲み物は${label(d)}を${d.qty || 1}本` : ''}買え！`;
  };

  /* ---------- 同じメニューの出しすぎ防止 ----------
     過去7日（＋今日のほかの食事）の履歴から、商品・同系統（サラダチキン、同じ店の同じ料理）・組み合わせを重み付けで減点。
     お気に入り（★）は減点を弱め、少し加点して「たまに出る」ようにする */
  E.family = (it, chainId) => {
    if (/サラダチキン/.test(it.name)) return 'fam:サラダチキン';
    if (chainId || it.chain) return 'fam:' + (chainId || it.chain) + ':' + it.name.replace(/[（(].*?[)）]/g, '').trim();
    if (it.category === 'おにぎり') return 'fam:おにぎり:' + it.name.replace(/^(手巻|直巻|大きな)?\s*(おにぎり|おむすび)?\s*/, '').slice(0, 6);
    return null;
  };
  E.comboKey = items => items.filter(i => i.role !== 'drink').map(i => i.id).sort().join('|');
  /* days: [{ago, items:[{id,name,category,role}], chain}] ago=0 は今日のほかの食事 */
  E.makeHistory = days => {
    const h = { item:{}, fam:{}, combo:{}, last:{} };
    const w = ago => ago <= 0 ? 1.6 : ago === 1 ? 1.3 : Math.max(0.45, 1.15 - ago * 0.1);
    for (const d of days) {
      const ww = w(d.ago);
      for (const it of d.items) {
        h.item[it.id] = (h.item[it.id] || 0) + ww;
        h.last[it.id] = Math.min(h.last[it.id] ?? 99, d.ago);
        const f = E.family(it, d.chain); if (f) h.fam[f] = (h.fam[f] || 0) + ww;
      }
      const ck = E.comboKey(d.items); if (ck) h.combo[ck] = (h.combo[ck] || 0) + ww;
    }
    return h;
  };
  E.histFromIds = ids => E.makeHistory([{ ago:2, items:(ids || []).map(id => ({ id, name:'' })) }]);
  E.repeatPenalty = (items, h, prof, chainId) => {
    if (!h) return 0;
    const fav = new Set(prof?.favItems || []);
    let p = 0;
    for (const it of items) {
      const k = fav.has(it.id) ? 0.35 : 1;
      p += (h.item[it.id] || 0) * 0.8 * k;
      if (h.last[it.id] != null && h.last[it.id] <= 1) p += 1.2 * k;          // 昨日・今日も出た
      const f = E.family(it, chainId); if (f && h.fam[f]) p += h.fam[f] * 0.35 * k;
      if (fav.has(it.id) && !(h.last[it.id] <= 2)) p -= 0.35;                  // お気に入りはたまに出す
    }
    const ck = E.comboKey(items.map(i => ({ ...i, role: i.role || 'x' })));
    if (h.combo[ck]) p += h.combo[ck] * 1.5;
    return p;
  };

  /* ---------- コンビニ食事ミッション（候補を複数作り、上位3案を返す） ---------- */
  E.convMission = (ctx) => {
    const { products, store, storeName, meal, target, prof, recentIds = [], seed, soldout = [], exclude = [], bigger = false, lighter = false } = ctx;
    const rnd = E.rng(seed);
    const pool = E.pool(products, store, prof, { soldout, exclude });
    const by = r => pool.filter(p => E.role(p) === r);
    const mains = by('main'), prots = by('protein'), vegs = by('veg'), drinks = by('drink').filter(isDrinkWaterTea);
    if (!mains.length && !prots.length) {
      const st = E.poolStats(products, store, prof);
      const why = st.unverified && (prof.allergies || []).length ? `アレルゲン情報が確認できていない商品（${st.unverified}品）は、安全と判断できないため除外しています。裏メニュー →「好き嫌い・アレルギー」で「未確認の商品も表示（自分でラベル確認）」を選ぶか、アレルゲン確認済みのデータを追加してください。` : 'この店舗・地域で条件に合う登録商品がありません。別の店舗を選ぶか、商品データを追加してください。';
      return { error: why };
    }
    let kcalT = Math.round(target.kcal * (E.mealShare[meal] || 0.3));
    if (bigger) kcalT = Math.round(kcalT * 1.25);
    if (lighter) kcalT = Math.round(kcalT * 0.8);
    const protT = Math.round(target.protein * (E.mealShare[meal] || 0.3));
    const budget = +prof.budget || 700;
    const pick = arr => arr.length ? arr[Math.floor(rnd()*arr.length)] : null;
    const seen = new Map();
    for (let i = 0; i < 600; i++) {
      const combo = [];
      const shape = rnd();
      const m = pick(mains); if (m) combo.push(m);
      if (shape < 0.85 || !m) { const pr = pick(prots); if (pr && !combo.includes(pr)) combo.push(pr); }
      if (shape < 0.6 || meal === 'lunch') { const v = pick(vegs); if (v && !combo.includes(v)) combo.push(v); }
      if (meal !== 'breakfast' && rnd() < 0.15) { const m2 = pick(mains.filter(x => x.category === 'おにぎり')); if (m2 && !combo.includes(m2)) combo.push(m2); }
      if (!combo.length) continue;
      const key = combo.map(c => c.id).sort().join('|'); if (seen.has(key)) continue;
      const s = sumN(combo);
      let score = 0;
      score += Math.abs(s.kcal - kcalT) / kcalT * 3;
      if (s.protein < protT) score += (protT - s.protein) / protT * 2.2;
      if (s.price > budget) score += (s.price - budget) / budget * 4;
      score += s.unknown * 0.8;
      score += E.repeatPenalty(combo, ctx.hist || E.histFromIds(recentIds), prof);
      score += s.salt > 4 ? (s.salt - 4) * 0.3 : 0;
      score += rnd() * 0.35;
      seen.set(key, { combo, score });
    }
    const ranked = [...seen.values()].sort((a, b) => a.score - b.score);
    if (!ranked.length) return { error: '組み合わせを作れませんでした。' };
    // 互いに違う案を3つまで（主食が同じ案は避ける）
    const plans = [];
    for (const r of ranked) {
      if (plans.length >= 3) break;
      const mainId = r.combo[0]?.id;
      if (plans.some(p => p.combo[0]?.id === mainId) && ranked.length > 6) continue;
      plans.push(r);
    }
    const build = (r, idx) => {
      const drink = drinks.length ? drinks[(Math.floor(rnd()*drinks.length) + idx) % drinks.length] : null;
      const items = r.combo.map(p => ({ ...p, role: E.role(p), qty:1 }));
      if (drink) items.push({ ...drink, role:'drink', qty:1 });
      const sum = sumN(items);
      return { items, sum, cmd: E.convCmd(storeName, items), verdict: E.verdict(sum, kcalT, protT) };
    };
    const built = plans.map(build);
    const main = built[0];
    const unverified = (prof.allergies || []).length && prof.allowUnverifiedAllergen ? main.items.filter(i => E.allergyStatus(i, prof) === 'unverified').map(i => i.name) : [];
    return { kind:'conv', store, storeName, meal, items: main.items, sum: main.sum, cmd: main.cmd, verdict: main.verdict, targetKcal:kcalT, targetProtein:protT,
      alternatives: built.slice(1), allergyCheck: unverified };
  };

  /* 売り切れ等：同じ役割の代替品を指定 */
  E.replaceItem = (mission, itemId, ctx) => {
    const it = mission.items.find(i => i.id === itemId); if (!it) return mission;
    const rnd = E.rng(ctx.seed);
    const pool = E.pool(ctx.products, mission.store, ctx.prof, { soldout: ctx.soldout, exclude: mission.items.map(i => i.id) })
      .filter(p => E.role(p) === it.role && (it.role !== 'drink' || isDrinkWaterTea(p)));
    if (!pool.length) return { ...mission, note: `「${it.name}」の代わりになる登録商品が見つかりません。そのまま無しで進めるか、別の店を選んでください。` };
    const tk = it.nutrition?.kcal ?? 200;
    pool.sort((a,b) => Math.abs((a.nutrition?.kcal ?? tk) - tk) - Math.abs((b.nutrition?.kcal ?? tk) - tk) + (rnd()-0.5)*40);
    const alt = { ...pool[0], role: it.role, qty: it.qty || 1 };
    const items = mission.items.map(i => i.id === itemId ? alt : i);
    const sum = sumN(items);
    return { ...mission, items, sum, cmd: E.convCmd(mission.storeName, items), verdict: E.verdict(sum, mission.targetKcal, mission.targetProtein), alternatives: [], note: `売り切れの「${it.name}」→「${alt.name}」に変更しました。` };
  };

  /* ---------- チェーン店・登録店ミッション ---------- */
  const SUSHI_LEAN = ['まぐろ（赤身）','えび','いか','たこ','ほたて','あじ','サーモン','かつお','はまち'];
  const SUSHI_SIDE = ['あおさの味噌汁','茶わん蒸し'];
  const GENRE_GUIDE = {
    '牛丼・定食': '「焼魚・焼肉の定食」を選び、ご飯は小盛または並。サラダかみそ汁を付けろ。丼なら小盛＋サラダ。',
    '中華・麺類': '麺は「並」まで。揚げ物トッピングは1つまで。スープは半分残せ（塩分対策）。野菜炒めや餃子少量で量を足せ。',
    'ファミレス・カレー': 'グリルチキンや焼魚のメイン＋サラダ。ライスは小。カレーはご飯少なめ＋サラダ。',
    'ファストフード・カフェ': 'セットにせず単品＋無糖ドリンク。ポテトは付けない（どうしても食べたい日はSサイズ）。',
    '居酒屋': '刺身・焼き鳥（塩）・枝豆・冷奴・サラダから。揚げ物と締めの炭水化物は控えろ。',
    '個人店': '焼く・煮る・蒸す料理の定食を選び、ご飯は少なめ。野菜の小鉢があれば追加。',
    '寿司': ''
  };
  const chainLabel = i => i.name + (i.size ? `（${i.size}）` : '');
  /* 外食の飲み物：無料の水・お茶が出る店はそれを優先。出ない店は登録メニューの無糖ドリンク */
  E.freeWater = chain => chain.freeWater ?? !['ファストフード・カフェ'].includes(chain.genre);
  E.chainDrinkLine = (chain, drinks) => {
    if (chain.sushi) return '無料のお茶（粉茶）か水';
    if (E.freeWater(chain)) return '無料のお水かお茶';
    if (drinks.length) return `「${chainLabel(drinks[0])}」`;
    return '水か無糖のお茶（無ければ一番小さいサイズの無糖ドリンク）';
  };
  E.chainMission = (ctx) => {
    const { chain, meal, target, prof, recentIds = [], seed, appetite = 'normal', soldout = [] } = ctx;
    const rnd = E.rng(seed);
    let kcalT = Math.round(target.kcal * (E.mealShare[meal] || 0.3));
    if (appetite === 'big') kcalT = Math.round(kcalT * 1.25);
    if (appetite === 'light') kcalT = Math.round(kcalT * 0.8);
    const protT = Math.round(target.protein * (E.mealShare[meal] || 0.3));
    const items = (chain.items || []).filter(i => i.status !== 'discontinued' && !soldout.includes(i.id));
    const usable = items.filter(i => { const a = E.allergyStatus(i, prof); return a === 'ok' || (a === 'unverified' && prof.allowUnverifiedAllergen); });
    if (chain.sushi && !usable.length) {
      const plates = appetite === 'big' ? 10 : appetite === 'light' ? 6 : 8;
      const neta = SUSHI_LEAN.filter(n => !E.blocked(n, prof) && !soldout.includes(n));
      const order = []; let left = plates;
      const sh = [...neta].sort(() => rnd() - 0.5);
      for (let i = 0; left > 0 && sh.length; i++) { const n = sh[i % sh.length]; const ex = order.find(o => o.name === n); if (ex) ex.qty++; else order.push({ name:n, qty:1 }); left--; }
      const side = SUSHI_SIDE.filter(s => !E.blocked(s, prof));
      const sidePick = side[Math.floor(rnd()*side.length)];
      const cmd = `${chain.name}で、` + order.map(o => `${o.name}${o.qty}皿`).join('、') + (sidePick ? `、${sidePick}1つ` : '') + 'を注文しろ！ 飲み物は無料のお茶で。';
      const allergyNote = (prof.allergies || []).length ? `アレルギー登録があります。この店のアレルゲン情報は未登録のため、注文前に店のアレルゲン表で必ず確認してください。` : '';
      return { kind:'sushi', chain: chain.id, storeName: chain.name, meal, order, side: sidePick, cmd, plates, drinkLine: E.chainDrinkLine(chain, []),
        caution: '皿数は目安です（この店のメニュー・栄養成分は未登録）。揚げ物・マヨ系・ラーメンは今回は見送り。ネタが無い時は「〇〇が無い」で入れ替え。' + allergyNote };
    }
    if (!usable.length) {
      const why = items.length && (prof.allergies || []).length ? 'アレルゲン情報が確認できるメニューが無いため、この店の登録メニューからは指定できません。' : '';
      return { kind:'guide', chain: chain.id, storeName: chain.name, meal, cmd: `${chain.name}では、メニュー表を撮影してAIに選ばせろ！`, guide: (why ? why + ' ' : '') + (GENRE_GUIDE[chain.genre] || GENRE_GUIDE['個人店']), needsPhoto:true, drinkLine: E.chainDrinkLine(chain, []) };
    }
    const mains = usable.filter(i => (i.role || i.category || 'main') === 'main');
    const sides = usable.filter(i => ['side'].includes(i.role || i.category));
    const drinks = usable.filter(i => (i.role || i.category) === 'drink' && /茶|水|ブラック|無糖/.test(i.name));
    const mainPool = mains.length ? mains : usable;
    const combos = [];
    for (const m of mainPool) {
      combos.push([m]);
      for (const sd of sides) combos.push([m, sd]);
    }
    const scored = combos.map(c => {
      const s = sumN(c.map(x => ({ ...x, qty:1 })));
      let sc = 0;
      if (s.complete) { sc += Math.abs(s.kcal - kcalT) / kcalT * 3; if (s.protein < protT) sc += (protT - s.protein) / protT * 1.5; }
      else sc += 1.2 + (c[0].nutrition?.kcal != null ? Math.abs(c[0].nutrition.kcal - kcalT) / kcalT : 0.5);
      if (s.price && s.price > (+prof.budget || 900) * 1.3) sc += 1;
      sc += E.repeatPenalty(c, ctx.hist || E.histFromIds(recentIds), prof, chain.id);
      if ((c[0].nutrition?.salt ?? 0) >= 5) sc += 0.3;
      sc += rnd() * 0.3;
      return { c, s, sc };
    }).sort((a, b) => a.sc - b.sc);
    const plans = [];
    for (const r of scored) { if (plans.length >= 3) break; if (plans.some(p => p.c[0].id === r.c[0].id) && scored.length > 4) continue; plans.push(r); }
    const build = r => {
      const order = r.c.map(x => ({ ...x, qty:1 }));
      const drinkLine = E.chainDrinkLine(chain, drinks);
      const cmd = `${chain.name}で` + order.map(x => `「${chainLabel(x)}」を${x.qty}つ`).join('、') + '注文しろ！ 飲み物は' + drinkLine + '。';
      let tip = '';
      if (/定食/.test(order[0].name)) tip = 'ご飯は小盛にできるなら小盛に。';
      if (order.some(x => (x.nutrition?.salt ?? 0) >= 4)) tip += 'みそ汁・タレ・スープは残して塩分カット。';
      return { items: order, sum: r.s, cmd, tip, drinkLine, verdict: E.verdict(r.s, kcalT, protT) };
    };
    const built = plans.map(build);
    const unverified = (prof.allergies || []).length ? built[0].items.filter(i => E.allergyStatus(i, prof) === 'unverified').map(i => i.name) : [];
    return { kind:'chain', chain: chain.id, storeName: chain.name, meal, ...built[0], targetKcal: kcalT, targetProtein: protT, alternatives: built.slice(1), allergyCheck: unverified };
  };

  /* ---------- お助け間食 ---------- */
  E.snackMission = (ctx) => {
    const { products, store, storeName, mood, prof, seed } = ctx;
    const rnd = E.rng(seed);
    const pool = E.pool(products, store, prof).filter(p => p.nutrition?.kcal != null && p.nutrition.kcal <= 230 && E.role(p) !== 'drink');
    const want = {
      sweet: p => /ヨーグルト|フルーツ|パイナップル|ブラン/.test(p.name) || p.category === 'ヨーグルト',
      salty: p => /枝豆|焼き鳥|やきとり|焼きとり|チーズ|カニカマ|豆腐スティック|ゆでたまご|サラダチキン|グリルチキン|ちくわ/.test(p.name),
      hungry: p => (p.nutrition?.protein ?? 0) >= 10 || p.category === 'おにぎり',
      light: p => (p.nutrition?.kcal ?? 999) <= 100
    }[mood] || (() => true);
    let c = pool.filter(want);
    if (!c.length) c = pool.filter(p => (p.nutrition?.protein ?? 0) >= 6);
    if (!c.length) return { error: 'この店で条件に合う登録商品がありません（アレルギー設定により除外されている場合もあります）。' };
    const p = c[Math.floor(rnd()*c.length)];
    const extra = mood === 'sweet' ? '甘いものが欲しい時は、まず無糖のお茶を一口。それでも欲しければ食べてOK。' : '';
    return { kind:'snack', store, storeName, items:[{ ...p, qty:1, role:'snack' }], sum: sumN([p]), cmd: `${E.shortStore(storeName)}で「${label(p)}」を1個買え！`, tip: extra + '我慢しすぎず、決めた量を楽しめ。' };
  };

  /* ---------- 場所 ---------- */
  E.PLACES = { home:{label:'自宅',em:'🏠'}, office:{label:'会社',em:'🏢'}, out:{label:'外出先',em:'🚶'}, golf:{label:'ゴルフ場',em:'⛳'}, other:{label:'その他',em:'📍'} };
  E.defaultPlace = type => ({ work:'office', golf:'golf', softball:'out', holiday:'home', travel:'out' })[type] || 'home';

  /* ---------- 飲み物ミッション ----------
     時刻の「枠」だけを作り、文言はその時の場所・食事・カフェイン量から決める。
     飲み物のためだけに買い物させない（手元の水・会社の自販機・食事と一緒に買う物を優先） */
  E.drinkSlots = (sched, prof) => {
    const wake = prof.wake || '07:00', sleep = prof.sleep || '23:30';
    const L = [];
    const add = (time, kind, ml = 200, extra = {}) => L.push({ id: 'd' + time.replace(':', '') + kind + L.length, time, kind, ml, done:false, v:3, ...extra });
    add(wake, 'wake');
    add(addMin(wake, 45), 'meal', 200, { meal:'breakfast' });
    if (sched?.type === 'golf') {
      const st = sched.golf?.start || '08:30';
      const hot = (+sched.golf?.temp || 0) >= 28;
      add(addMin(st, -30), 'pre');
      for (let h = 1; h <= 6; h++) add(addMin(st, h * 45), (h === 3 || (hot && h % 2 === 0)) ? 'salt' : 'round', 180, { hole: h * 3 });
      add(addMin(st, 150), 'meal', 250, { meal:'lunch' });
      add(addMin(st, 330), 'post', 400);
    } else if (sched?.type === 'softball') {
      const st = sched.softball?.start || '09:00', en = sched.softball?.end || addMin(st, 180);
      const hot = (+sched.softball?.temp || 0) >= 28;
      const dur = Math.max(60, (toMin(en) - toMin(st)));
      add(addMin(st, -30), 'pre');
      for (let m = 30; m < dur; m += 30) add(addMin(st, m), hot || m % 60 === 0 && sched.softball?.intensity !== 'practice' ? 'salt' : 'play', 180, { minute: m });
      add(addMin(en, 15), 'post', 400);
      add('12:30', 'meal', 200, { meal:'lunch' });
    } else {
      add(addMin(wake, 180), 'am', 250);
      add('12:30', 'meal', 200, { meal:'lunch' });
      add('15:00', 'pm', 250);
      add('17:30', 'eve', 200);
    }
    if (sched?.plan?.dinner === 'drinking') add('18:40', 'predrink', 250);
    add('19:30', 'meal', 200, { meal:'dinner' });
    add(addMin(sleep, -90), 'night', 100);
    return L.sort((a, b) => a.time.localeCompare(b.time));
  };
  E.drinkPlan = (sched, prof) => E.drinkSlots(sched, prof); // 互換
  function toMin(hhmm){ const [h, m] = (hhmm || '0:0').split(':').map(Number); return h * 60 + m; }
  E.toMin = toMin;
  const NON_CAF = /水|麦茶|ルイボス|炭酸水|コーン茶|十六茶|そば茶/;
  const isVendWaterTea = i => (/水|茶/.test(i.name) && !/ミルク|ラテ|紅茶花伝|ミルクティー/.test(i.name));

  /* 枠の文言。ctx = { place, vending:[{name,size,caffeineMg,place}], coffeeCount, caffeineMg, meals, sched, now } */
  E.drinkText = (slot, ctx) => {
    if (!slot.v) return { text: slot.text, src:'old' };
    const place = ctx.place || 'home';
    const cups = n => n >= 2 ? `${n}杯` : '1杯';
    const late = toMin(ctx.now || '12:00') >= toMin('16:00');
    const vend = (ctx.vending || []).filter(isVendWaterTea);
    const pickVend = () => {
      if (!vend.length) return null;
      const noCaf = vend.filter(i => NON_CAF.test(i.name) || i.caffeineMg === 0);
      const pool = (ctx.coffeeCount >= 2 || ctx.caffeineMg >= 250 || late) && noCaf.length ? noCaf : vend;
      return pool[(slot.time.charCodeAt(1) + slot.time.charCodeAt(4)) % pool.length];
    };
    const general = (half) => {
      if (place === 'office') {
        const v = pickVend();
        if (v) {
          const why = ctx.coffeeCount >= 2 ? `今日はコーヒーを${ctx.coffeeCount}本飲んでいるので、次は` : late ? '夕方以降はカフェイン控えめ。' : '';
          return { text: `${why}自販機の「${v.name}${v.size ? ' ' + v.size : ''}」を選べ！（手元に水があれば水でOK）`, src:'vending' };
        }
        return { text: ctx.coffeeCount >= 2 ? `今日はコーヒーを${ctx.coffeeCount}杯。次は水をコップ1杯飲め！（給水機・持参の水）` : '水をコップ1杯飲め！（給水機・持参の水）', src:'water' };
      }
      if (place === 'out') return { text: '手元の水かお茶を一口〜1杯飲め！ 手元に無ければ次の食事の時でOK（飲み物のためだけに買わない）', src:'hand' };
      if (place === 'golf') return { text: '茶店か手元の水・お茶を飲め！', src:'hand' };
      if (place === 'other') return { text: '手元の水を飲め！ 無ければ次の食事の時でOK', src:'hand' };
      return { text: half ? '水をコップ半分だけ飲め！（寝る前なので飲みすぎ注意）' : '水をコップ1杯飲め！', src:'water' };
    };
    switch (slot.kind) {
      case 'wake': return { text: '起きたら水をコップ1杯飲め！', src:'water' };
      case 'night': return general(true);
      case 'am': case 'pm': case 'eve': return general(false);
      case 'predrink': return { text: '飲み会の前に水をコップ1杯！ 乾杯後もお酒1杯ごとに水1杯を挟め', src:'water' };
      case 'pre': return { text: slot.time && ctx.sched?.type === 'golf' ? 'スタート30分前：水をコップ1杯飲め！' : '開始30分前：水をコップ1杯飲め！', src:'water' };
      case 'round': return { text: `${slot.hole}ホール目：水かお茶を150〜200ml飲め！（茶店・持参分）`, src:'hand' };
      case 'play': return { text: `${slot.minute}分経過：水を150〜200ml飲め！`, src:'hand' };
      case 'salt': return { text: `${slot.hole ? slot.hole + 'ホール目' : slot.minute + '分経過'}：スポーツドリンク150〜200mlで塩分も補給しろ！${ctx.sched?.golf?.temp >= 28 || ctx.sched?.softball?.temp >= 28 ? '（暑い日は特に）' : ''}`, src:'salt' };
      case 'post': return { text: '運動おつかれ！ 水を2杯に分けて飲め！', src:'water' };
      case 'meal': {
        const m = ctx.meals?.[slot.meal];
        const ms = m?.mission;
        const d = ms?.items?.find(i => i.role === 'drink');
        if (d) return { text: `${E.MEAL_LABEL[slot.meal]}と一緒に、買った「${d.name}」を飲め！`, src:'meal' };
        if (ms?.drinkLine) return { text: `${E.MEAL_LABEL[slot.meal]}の飲み物は${ms.drinkLine}にしろ！`, src:'meal' };
        if (ctx.sched?.plan?.[slot.meal] === 'drinking') return { text: '乾杯前に水1杯！ お酒1杯ごとに水1杯を挟め', src:'water' };
        if (place === 'office' && slot.meal !== 'breakfast') return general(false);
        if (m?.homeRecord) return { text: `${E.MEAL_LABEL[slot.meal]}と一緒に水をコップ1杯飲め！`, src:'water' };
        if (place === 'out' || place === 'golf') return { text: `${E.MEAL_LABEL[slot.meal]}と一緒に、手元の水かお店の無料の水・お茶を飲め！`, src:'free' };
        return { text: `${E.MEAL_LABEL[slot.meal]}と一緒に水をコップ1杯飲め！`, src:'water' };
      }
    }
    return general(false);
  };
  /* 旧形式（文言固定）の枠を新形式に移行。完了状態は時刻で引き継ぐ */
  E.migrateDrinks = (old, sched, prof) => {
    const fresh = E.drinkSlots(sched, prof);
    const doneTimes = (old || []).filter(d => d.done).map(d => d.time).sort();
    let k = 0;
    for (const f of fresh) if (k < doneTimes.length && f.time <= (doneTimes[doneTimes.length - 1] || '00:00')) { f.done = true; f.at = (old.find(d => d.done && d.time === doneTimes[k]) || {}).at || null; k++; }
    return fresh;
  };
  /* 予定変更：今より前の枠と完了済みは残し、これからの枠だけ作り直す */
  E.rebuildDrinks = (cur, sched, prof, now) => {
    const keep = (cur || []).filter(d => d.done || d.time < now);
    const fresh = E.drinkSlots(sched, prof).filter(d => d.time >= now && !keep.some(k => k.time === d.time && k.kind === d.kind));
    return [...keep, ...fresh].sort((a, b) => a.time.localeCompare(b.time));
  };
  function addMin(hhmm, m){ const [h, mi] = hhmm.split(':').map(Number); let t = h*60 + mi + m; t = (t + 1440) % 1440; return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`; }
  E.addMin = addMin;

  /* カフェイン概算：コーヒー浸出液 60mg/100ml（日本食品標準成分表の値）、緑茶 20mg/100ml、烏龍茶 20mg/100ml */
  E.caffeinePer100 = { coffee:60, greentea:20, oolong:20, black:30 };
  E.COFFEE_PRESETS = [ { label:'コーヒー マグ1杯', ml:200 }, { label:'缶コーヒー 185ml', ml:185 }, { label:'ボトルコーヒー 500ml', ml:500 }, { label:'エスプレッソ系 1杯', ml:60, mg:65 } ];
  E.caffeineEstimate = (kind, ml) => Math.round((E.caffeinePer100[kind] || 0) * ml / 100);
  E.caffeineAdvice = (totalMg, sleepTime) => {
    const now = new Date(); const [h, m] = (sleepTime || '23:30').split(':').map(Number);
    const sleep = new Date(); sleep.setHours(h, m, 0, 0); if (sleep < now) sleep.setDate(sleep.getDate() + 1);
    const hrs = (sleep - now) / 36e5;
    const msgs = [];
    if (totalMg >= 400) msgs.push('今日のカフェインは約' + totalMg + 'mg。目安の400mgに達しました。ここからは水か麦茶にしろ！');
    else if (totalMg >= 300) msgs.push('今日のカフェインは約' + totalMg + 'mg。あと1杯までにしておけ。');
    if (hrs < 6) msgs.push('就寝まで6時間を切っています。睡眠のためにカフェインは控えろ。');
    return msgs;
  };

  /* アルコール：純アルコール量(g) = ml × 度数% / 100 × 0.8 */
  E.alcoholG = (ml, abv) => Math.round(ml * abv / 100 * 0.8 * 10) / 10;
  E.DRINKS_ALC = [
    { name:'生ビール（中）', ml:435, abv:5 }, { name:'ハイボール', ml:350, abv:7 }, { name:'レモンサワー（無糖）', ml:350, abv:7 },
    { name:'ウーロンハイ', ml:350, abv:7 }, { name:'日本酒 1合', ml:180, abv:15 }, { name:'焼酎ロック', ml:100, abv:25 }, { name:'ワイン グラス', ml:120, abv:12 }
  ];
  E.IZAKAYA_FOOD = ['枝豆','冷奴','刺身盛り合わせ','焼き鳥（塩）','焼き魚','海藻サラダ','だし巻き玉子','もずく酢'];

  /* ---------- トレーニング ---------- */
  const EX = {
    home:   ['スクワット','膝つき腕立て伏せ','リバースランジ','プランク','ヒップリフト','もも上げ','カーフレイズ','バードドッグ'],
    office: ['椅子スクワット','壁腕立て伏せ','カーフレイズ','肩甲骨回し','座ったまま膝上げ','階段のぼり'],
    gym:    ['レッグプレス','チェストプレス','ラットプルダウン','シーテッドロー','トレッドミル早歩き','エアロバイク','プランク'],
    outdoor:['早歩き','ジョグ＆ウォーク','階段のぼり','公園の段差でステップアップ','ストレッチ']
  };
  E.trainingPlan = (place, minutes, goal, seed) => {
    const rnd = E.rng(seed);
    const list = [...(EX[place] || EX.home)].sort(() => rnd() - 0.5);
    const out = [];
    if (place === 'outdoor' || goal === 'cardio') {
      out.push({ name:'ウォームアップ（ゆっくり歩く）', detail:'5分' });
      out.push({ name: place === 'gym' ? 'トレッドミル早歩き（傾斜3〜5%）' : '早歩き', detail: `${Math.max(10, minutes-10)}分（会話できるペース）` });
      out.push({ name:'ストレッチ（ふくらはぎ・もも裏）', detail:'5分' });
      return out;
    }
    const n = minutes <= 10 ? 3 : minutes <= 20 ? 4 : 6;
    const sets = minutes <= 10 ? 2 : 3;
    const reps = goal === 'strength' ? '8〜12回' : '12〜15回';
    const rest = goal === 'strength' ? '休憩60〜90秒' : '休憩30〜45秒';
    out.push({ name:'ウォームアップ（その場足踏み・肩回し）', detail:'2〜3分' });
    for (const e of list.slice(0, n)) out.push({ name:e, detail: /プランク/.test(e) ? `20〜40秒 × ${sets}セット・${rest}` : /歩|バイク|階段/.test(e) ? '5〜8分' : `${reps} × ${sets}セット・${rest}` });
    out.push({ name:'クールダウン（ストレッチ）', detail:'2〜3分' });
    return out;
  };

  /* ---------- ゲーム ---------- */
  E.XP = { meal:30, homeMeal:20, drink:5, weight:20, steps:10, training:30, snackLog:10, bodyPhoto:10 };
  E.level = xp => { const lv = Math.floor(Math.sqrt(xp / 60)) + 1; const cur = 60*(lv-1)**2, next = 60*lv**2; return { lv, cur, next, pct: Math.round((xp-cur)/(next-cur)*100) }; };
  E.BADGES = [
    { id:'first', name:'初ミッション', em:'🎖', test: g => g.counts.meal >= 1 },
    { id:'water30', name:'水分マスター', em:'💧', test: g => g.counts.drink >= 30 },
    { id:'weigh7', name:'計測習慣（7回）', em:'⚖️', test: g => g.counts.weight >= 7 },
    { id:'train5', name:'トレーニング5回', em:'💪', test: g => g.counts.training >= 5 },
    { id:'days7', name:'活動7日', em:'🔥', test: g => (g.activeDays || []).length >= 7 },
    { id:'days30', name:'活動30日', em:'👑', test: g => (g.activeDays || []).length >= 30 },
    { id:'comeback', name:'おかえり！再開', em:'🌅', test: g => !!g.comeback }
  ];

  /* 7日移動平均 */
  E.movingAvg = (weights) => {
    const sorted = [...weights].sort((a,b) => a.date.localeCompare(b.date));
    return sorted.map(w => {
      const from = E.addDays(w.date, -6);
      const win = sorted.filter(x => x.date >= from && x.date <= w.date);
      return { date: w.date, kg: w.kg, avg: Math.round(win.reduce((s,x) => s + x.kg, 0) / win.length * 10) / 10 };
    });
  };

  window.E = E;
})();
