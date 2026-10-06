/* からだミッション：食事の詳細記録（写真だけで分からない食品の量・規格・トッピング）
   ・公式の栄養情報（登録済みの商品データ）が見つかれば「公式値」を優先
   ・見つからなければ、規格・量・トッピングから「推定」の幅（〜）を出す
   ・推定値は必ず estimated:true として保存し、画面でも「推定」と表示。公式値と混ぜて表示しない
   推定の元データ：日本食品標準成分表（八訂）の100gあたりエネルギー × 一般的な重さ・量。値は目安であり公式値ではない */
(function(){
  const F = {};
  const r5 = v => Math.round(v / 5) * 5;
  // [最小g, 最大g] × kcal/100g → [最小kcal, 最大kcal]
  const byG = (g, per100) => [Math.round(g[0] * per100 / 100), Math.round(g[1] * per100 / 100)];

  F.WHERE = [['home','家にあった'],['conv','コンビニ'],['super','スーパー'],['bakery','パン屋'],['restaurant','飲食店'],['other','その他']];

  /* トッピング・調味料（1回分あたりの推定幅） */
  F.TOPPINGS = {
    butter:   { label:'バター', unit:'10g', kcal:[60, 80] },
    margarine:{ label:'マーガリン', unit:'10g', kcal:[60, 80] },
    jam:      { label:'ジャム', unit:'大さじ1', kcal:[40, 60] },
    honey:    { label:'はちみつ', unit:'大さじ1', kcal:[60, 75] },
    cheese:   { label:'スライスチーズ', unit:'1枚', kcal:[50, 60] },
    pb:       { label:'ピーナッツバター', unit:'大さじ1', kcal:[80, 100] },
    mayo:     { label:'マヨネーズ', unit:'大さじ1', kcal:[70, 90] },
    egg:      { label:'卵', unit:'1個', kcal:[65, 110] },
    ham:      { label:'ハム', unit:'1枚', kcal:[20, 35] },
    furikake: { label:'ふりかけ', unit:'1袋', kcal:[10, 20] },
    natto:    { label:'納豆', unit:'1パック', kcal:[80, 100] },
    tamago_raw:{ label:'生卵・温泉卵', unit:'1個', kcal:[65, 80] },
    ebiten:   { label:'えび天', unit:'1本', kcal:[60, 100] },
    kakiage:  { label:'かき揚げ', unit:'1枚', kcal:[180, 300] },
    meat:     { label:'肉のトッピング', unit:'1人前', kcal:[100, 200] },
    sauce:    { label:'ソース・ケチャップ', unit:'大さじ1', kcal:[15, 25] },
    dressing: { label:'ドレッシング', unit:'大さじ1', kcal:[20, 60] },
    oil:      { label:'炒め油・揚げ油の追加', unit:'小さじ1', kcal:[35, 40] }
  };

  /* 食品の種類ごとに「聞くこと」を決める */
  F.TYPES = {
    shokupan: { short:'食パン', label:'食パン', em:'🍞', unit:'枚', askBrand:true,
      sizeLabel:'厚さ（何枚切り）',
      sizes:[ ['4','4枚切り', byG([85, 95], 248)], ['5','5枚切り', byG([68, 76], 248)], ['6','6枚切り', byG([57, 63], 248)], ['8','8枚切り', byG([42, 48], 248)], ['?','わからない', byG([45, 95], 248)] ],
      toppings:['butter','margarine','jam','honey','cheese','pb','mayo','egg','ham'],
      basis:'角形食パン 248kcal/100g（食品成分表）× 枚切りごとの一般的な重さ' },
    bread: { short:'パン', label:'パン（その他）', em:'🥐', unit:'個', askBrand:true,
      sizeLabel:'種類',
      sizes:[ ['roll','ロールパン', [90, 125]], ['croissant','クロワッサン', [160, 245]], ['melon','メロンパン', [350, 455]], ['an','あんぱん', [215, 295]], ['sozai','惣菜パン', [250, 450]], ['kashi','菓子パン（その他）', [250, 450]], ['sand','サンドイッチ（1パック）', [250, 450]] ],
      toppings:['butter','jam','cheese','egg','ham'],
      basis:'パンの種類ごとの一般的な重さ × 食品成分表の値' },
    rice: { short:'ご飯', label:'ご飯', em:'🍚', unit:'杯',
      sizeLabel:'量',
      sizes:[ ['s','小盛（約100g）', byG([90, 110], 156)], ['m','普通（約150g）', byG([135, 165], 156)], ['l','大盛（約200g）', byG([180, 220], 156)], ['xl','どんぶり（約250g）', byG([225, 275], 156)] ],
      toppings:['furikake','natto','tamago_raw','egg'],
      basis:'精白米ご飯 156kcal/100g（食品成分表）× 量' },
    onigiri: { short:'おにぎり', label:'おにぎり', em:'🍙', unit:'個', askBrand:true,
      sizeLabel:'大きさ',
      sizes:[ ['s','小さめ', [120, 160]], ['m','普通', [170, 220]], ['l','大きめ', [230, 300]] ],
      toppings:[],
      basis:'ご飯 156kcal/100g × 一般的な重さ ＋ 具' },
    noodle: { short:'麺', label:'麺', em:'🍜', unit:'杯', askBrand:true,
      kindLabel:'種類',
      kinds:[ ['udon','かけうどん', [230, 300]], ['soba','ざる・もりそば', [260, 340]], ['ramen','ラーメン', [450, 650]], ['pasta','パスタ（ソース込み）', [550, 800]], ['yakisoba','焼きそば', [450, 650]], ['hiyashi','冷やし中華', [450, 600]], ['cup','カップ麺', [300, 500]] ],
      sizeLabel:'量',
      sizes:[ ['s','小・ミニ', 0.7], ['m','並', 1], ['l','大盛', 1.4] ],
      toppings:['ebiten','kakiage','tamago_raw','egg','meat'],
      basis:'ゆで麺の食品成分表の値 × 一般的な1杯の量 ＋ つゆ・具（店や量で大きく変わります）' },
    side: { short:'惣菜', label:'惣菜・おかず', em:'🍱', unit:'個/人前', askBrand:true,
      kindLabel:'種類',
      kinds:[ ['karaage','唐揚げ（1個）', [60, 100]], ['croquette','コロッケ（1個）', [150, 230]], ['katsu','とんかつ（1枚）', [350, 500]], ['fish','焼き魚（1切れ）', [100, 200]], ['hamburg','ハンバーグ（1個）', [250, 400]], ['gyoza','ぎょうざ（1個）', [35, 50]], ['stirfry','炒め物（1人前）', [200, 350]], ['nimono','煮物（1人前）', [80, 180]], ['potesala','ポテト・マカロニサラダ（1パック）', [130, 230]], ['salad','生野菜サラダ（1皿・ドレッシング別）', [15, 40]] ],
      toppings:['sauce','mayo','dressing','oil'],
      basis:'料理ごとの一般的な量 × 食品成分表の値（作り方で大きく変わります）' },
    other: { short:'その他', label:'その他', em:'🍽', unit:'個', askBrand:true, manual:true, toppings:[],
      basis:'入力したカロリー、またはAIの推定' }
  };

  const norm = s => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  /* 商品名から公式データ（登録済み）を探す。見つかっても栄養成分が無ければ公式値なし */
  F.findOfficial = (name, data) => {
    const n = norm(name); if (n.length < 2) return null;
    const pool = [...(data.products || []).map(p => ({ id:p.id, name:p.name, store:p.storeName, kcal:p.nutrition?.kcal, url:p.officialUrl, verifiedAt:p.verifiedAt })),
      ...(data.chains || []).flatMap(c => (c.items || []).map(i => ({ id:i.id, name:i.name + (i.size ? `（${i.size}）` : ''), store:c.name, kcal:i.nutrition?.kcal, url:i.officialUrl, verifiedAt:i.verifiedAt, src:i.source })))];
    const hit = pool.find(p => norm(p.name) === n) || pool.find(p => norm(p.name).includes(n) && n.length >= 4);
    if (!hit) return null;
    if (hit.src === 'favorite' || hit.src === 'menu-photo') return { ...hit, kcal:null, note:'行きつけ店のメニュー写真の値（公式値ではありません）' };
    return hit;
  };
  F.suggestions = data => [...new Set([...(data.products || []).map(p => p.name), ...(data.chains || []).flatMap(c => (c.items || []).filter(i => i.source !== 'favorite').map(i => i.name))])].slice(0, 600);

  /* 計算：公式値の部分と推定の部分を分けて返す */
  F.calc = (e, official) => {
    const T = F.TYPES[e.type] || F.TYPES.other;
    const count = Math.max(0, +e.count || 1);
    let off = 0, eMin = 0, eMax = 0, basis = [];
    if (official && official.kcal != null) { off = official.kcal * count; basis.push(`公式値 ${official.kcal}kcal × ${count}${T.unit}（${official.store || '登録データ'}）`); }
    else if (T.manual) { if (e.manualKcal != null && e.manualKcal !== '') { eMin = eMax = +e.manualKcal; basis.push('入力した値'); } }
    else {
      let range = null;
      if (T.kinds) {
        const k = T.kinds.find(x => x[0] === e.kind) || T.kinds[0];
        const mul = (T.sizes.find(x => x[0] === e.size) || T.sizes[1] || T.sizes[0])[2];
        range = [k[2][0] * mul, k[2][1] * mul];
      } else {
        const s = T.sizes.find(x => x[0] === e.size) || T.sizes[T.sizes.length > 2 ? 1 : 0];
        range = s[2];
      }
      eMin += range[0] * count; eMax += range[1] * count; basis.push(T.basis);
    }
    for (const [id, n] of Object.entries(e.toppings || {})) {
      const tp = F.TOPPINGS[id]; if (!tp || !n) continue;
      eMin += tp.kcal[0] * n; eMax += tp.kcal[1] * n;
    }
    if (Object.values(e.toppings || {}).some(n => n)) basis.push('トッピング・調味料は一般的な1回分の量から推定');
    if (e.ai && e.ai.min != null) { eMin = e.ai.min; eMax = e.ai.max; off = 0; basis = ['AIが写真と入力内容から推定：' + (e.ai.note || '')]; }
    const estimated = eMax > 0 || (!off);
    const lo = Math.round(off + eMin), hi = Math.round(off + eMax);
    const has = off > 0 || eMax > 0;
    return { official: Math.round(off), estMin: Math.round(eMin), estMax: Math.round(eMax), min: lo, max: hi,
      suggested: has ? (eMax > 0 ? r5(off + (eMin + eMax) / 2) : Math.round(off)) : null,
      estimated: eMax > 0 || (!off && has), onlyOfficial: off > 0 && eMax === 0, basis: basis.join(' ／ '), has };
  };

  /* 表示用ラベル（推定と公式を混同しない） */
  F.kcalLabel = f => {
    if (f.kcal == null) return f.source === 'unknown' ? 'カロリー不明（登録データに栄養成分なし）' : 'カロリー未入力';
    if (!f.estimated) return `公式値 ${f.kcal}kcal`;
    const parts = [];
    if (f.officialKcal) parts.push(`公式 ${f.officialKcal}kcal ＋ 推定 ${f.estMin}〜${f.estMax}kcal`);
    else if (f.min != null && f.max != null && f.min !== f.max) parts.push(`推定 ${f.min}〜${f.max}kcal`);
    return (parts.length ? parts.join('') + '／' : '') + `記録値 ${f.kcal}kcal（推定）`;
  };
  F.title = f => {
    const T = F.TYPES[f.type] || F.TYPES.other;
    const size = T.sizes && !T.kinds && !f.officialRef ? (T.sizes.find(s => s[0] === f.size) || [])[1] : null;   // 公式値の商品は規格表示を省く
    const kind = T.kinds ? (T.kinds.find(s => s[0] === f.kind) || [])[1] : null;
    const tps = Object.entries(f.toppings || {}).filter(([, n]) => n).map(([id, n]) => F.TOPPINGS[id]?.label + (n > 1 ? '×' + n : ''));
    const u = T.unit.includes('/') ? '' : T.unit;
    return [f.product || kind || T.label, size, `×${f.count || 1}${u}`].filter(Boolean).join(' ') + (tps.length ? `（${tps.join('・')}）` : '');
  };
  /* 食事1回分の合計（公式値の部分と推定の部分を分けて合計） */
  F.sumFoods = foods => {
    const s = { kcal:0, official:0, estimated:0, unknown:0, n:0 };
    for (const f of foods || []) {
      if (f.kcal == null) { s.unknown++; continue; }
      s.n++; s.kcal += +f.kcal;
      if (f.estimated) { s.official += +(f.officialKcal || 0); s.estimated += +f.kcal - +(f.officialKcal || 0); }
      else s.official += +f.kcal;
    }
    return s;
  };

  window.F = F;
})();
