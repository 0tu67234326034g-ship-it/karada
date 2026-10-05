/* からだミッション：ゲーム要素
   評価するのは「行動」だけ（食事ミッション・水・歩く・運動・記録・間食の選び方・予定変更からの復帰）。
   体重の増減・食べ過ぎ・飲み会で減点はしない。崩れた翌日は「リカバリーミッション」で戻りやすくする。 */
(function(){
  const G = {};

  G.XP = { meal:30, homeMeal:25, drink:5, weight:20, steps:15, training:30, snackLog:10, bodyPhoto:10, coffee:0 };
  G.BONUS = {
    planStart:  { xp:10, label:'作戦開始ボーナス' },
    perfect:    { xp:50, label:'PERFECT DAY ボーナス' },
    snackNice:  { xp:5,  label:'ナイスチョイス！' },
    recovery:   { xp:20, label:'リカバリー成功' },
    replanBack: { xp:15, label:'予定変更から立て直し' },
    drinkWell:  { xp:30, label:'飲み会を上手に乗り切った' },
    golfDay:    { xp:30, label:'ラウンド完走' },
    softDay:    { xp:25, label:'試合・練習完走' },
    travelDay:  { xp:20, label:'遠征ミッション達成' },
    streak3:    { xp:30, label:'3日連続達成' },
    streak7:    { xp:70, label:'7日連続達成' },
    streak14:   { xp:100, label:'14日連続達成' },
    streak30:   { xp:200, label:'30日連続達成' }
  };

  G.level = xp => { const lv = Math.floor(Math.sqrt(xp / 60)) + 1; const cur = 60*(lv-1)**2, next = 60*lv**2; return { lv, cur, next, pct: Math.round((xp-cur)/(next-cur)*100), toNext: next - xp }; };
  G.TITLES = ['見習い隊員','隊員','上等隊員','エージェント','上級エージェント','スペシャリスト','エキスパート','マスター','グランドマスター','レジェンド'];
  G.title = lv => G.TITLES[Math.min(G.TITLES.length - 1, Math.floor((lv - 1) / 3))];

  /* ---------- 1日の達成度 ---------- */
  G.dayScore = (day, t, now) => {
    if (!day) return { pct:0, parts:{}, perfect:false, missing:[], active:false };
    const meals = ['breakfast','lunch','dinner'];
    const mealsDone = meals.filter(s => day.meals?.[s]?.status === 'cleared').length;
    const dr = day.drinks || [];
    const drinkDone = dr.filter(d => d.done).length;
    const exerciseDay = ['golf','softball'].includes(day.schedule?.type);
    const goal = t?.stepsGoal || 8000;
    let move = 0;
    if ((day.training || []).length) move = 1;
    if (exerciseDay && day.exerciseDone) move = 1;
    if (day.steps != null) move = Math.max(move, Math.min(1, day.steps / goal));
    const parts = {
      meals: mealsDone / 3,
      water: dr.length ? Math.min(1, drinkDone / Math.max(1, Math.ceil(dr.length * 0.8))) : 0,
      weight: day.weightLogged ? 1 : 0,
      move
    };
    const pct = Math.round((parts.meals * 0.4 + parts.water * 0.2 + parts.weight * 0.15 + parts.move * 0.25) * 100);
    const missing = [];
    if (mealsDone < 3) missing.push(`食事ミッション あと${3 - mealsDone}つ`);
    if (parts.water < 1) missing.push(`水分ミッション あと${Math.max(1, Math.ceil(dr.length * 0.8) - drinkDone)}回`);
    if (!day.weightLogged) missing.push('体重の記録');
    if (move < 1) missing.push(exerciseDay ? (day.schedule.type === 'golf' ? 'ラウンド完走' : '試合・練習完走') : (day.steps == null ? '歩数の記録（またはトレーニング）' : `歩数 あと${Math.max(0, goal - day.steps).toLocaleString()}歩（またはトレーニング）`));
    const active = mealsDone + drinkDone + (day.weightLogged ? 1 : 0) + (day.training || []).length + (day.steps != null ? 1 : 0) > 0;
    return { pct, parts, perfect: missing.length === 0, missing, active, mealsDone, drinkDone, drinkTotal: dr.length };
  };
  G.ACHIEVED = 60; // 60%以上で「達成日」

  /* days: {date: dayObj}, scoreOf(date) -> pct */
  G.streak = (scoreOf, today) => {
    let s = 0; let d = today;
    if (scoreOf(d) < G.ACHIEVED) d = E.addDays(d, -1);   // 今日はまだ途中なら昨日から数える
    while (scoreOf(d) >= G.ACHIEVED && s < 400) { s++; d = E.addDays(d, -1); }
    return s;
  };

  /* 週間ランク：直近7日のうち良い5日の平均（1〜2日崩れても大丈夫） */
  G.RANKS = [ { r:'S', min:85, name:'レジェンド級' }, { r:'A', min:70, name:'エース級' }, { r:'B', min:55, name:'レギュラー級' }, { r:'C', min:40, name:'ルーキー級' }, { r:'D', min:0, name:'ウォームアップ' } ];
  G.weekRank = pcts => {
    const top = [...pcts].sort((a, b) => b - a).slice(0, 5);
    while (top.length < 5) top.push(0);
    const avg = Math.round(top.reduce((a, b) => a + b, 0) / 5);
    const R = G.RANKS.find(x => avg >= x.min);
    const next = G.RANKS[G.RANKS.indexOf(R) - 1];
    return { ...R, avg, toNext: next ? next.min - avg : 0, nextR: next?.r };
  };

  /* ---------- 前日が崩れた時のリカバリーミッション ---------- */
  G.recoveryFor = (yday, yScore, yKcal, yTarget) => {
    if (!yday) return null;
    const drank = (yday.alcohol || []).length > 0 || yday.schedule?.plan?.dinner === 'drinking';
    const over = yKcal?.complete && yTarget && yKcal.kcal > yTarget * 1.15;
    const snacks = (yday.snacks || []).length >= 3;
    const low = yScore.active && yScore.pct < 40;
    if (!(drank || over || snacks || low)) return null;
    const reason = drank ? '昨日は飲み会おつかれ！' : over ? '昨日はしっかり食べた日。' : snacks ? '昨日は間食が多めだった。' : '昨日は忙しかった？';
    return { reason, tasks: [
      { id:'water', label:'お昼までに水を2杯飲む' },
      { id:'lunch', label:'昼食ミッションをクリア（たんぱく質と野菜入り）' },
      { id:'move',  label:'いつもより少し歩く（歩数記録 or トレーニング）' }
    ] };
  };
  G.recoveryProgress = (day, t) => {
    const amWater = (day.drinks || []).filter(d => d.done && (d.doneAt || d.at || d.time) < '12:00').length;   // 実際に飲んだ時刻で判定
    const sc = G.dayScore(day, t);
    return { water: amWater >= 2, lunch: day.meals?.lunch?.status === 'cleared', move: sc.parts.move >= 1 || (day.training || []).length > 0 };
  };

  /* ---------- 7日間のコメント ---------- */
  G.weekComments = rows => {
    const act = rows.filter(r => r.score.active);
    if (!act.length) return ['まずは今日の作戦から。1つクリアするだけで流れができる。'];
    const avg = rows.reduce((a, r) => a + r.score.pct, 0) / rows.length;
    const out = [];
    const eatout = rows.filter(r => r.eatout || r.drinking).length;
    const last2 = rows.slice(-2).filter(r => r.score.active);
    const last2avg = last2.length ? last2.reduce((a, r) => a + r.score.pct, 0) / last2.length : 0;
    if (avg >= 75) out.push('今週はかなり順調。この流れをキープ！');
    else if (avg >= 55) out.push('いいペース。あと少しで上位ランク。');
    if (eatout >= 3 && last2avg >= 60) out.push('外食・飲み会が多かったが、ちゃんと戻せている。');
    else if (eatout >= 3) out.push('外食が多い週。次の1食をミッションどおりにすれば十分戻せる。');
    const water = rows.reduce((a, r) => a + r.score.drinkDone, 0), waterT = rows.reduce((a, r) => a + r.score.drinkTotal, 0);
    if (waterT && water / waterT >= 0.75) out.push('水分ミッションの達成率が高い。ナイス！');
    else if (waterT && water / waterT < 0.4) out.push('水分ミッションは「飲んだ！」1タップから。');
    if (rows.filter(r => r.weight != null).length >= 5) out.push('体重の記録が習慣になってきた。');
    if (rows.reduce((a, r) => a + r.training, 0) >= 2) out.push('トレーニングも継続中。');
    if (rows.some(r => r.recovered)) out.push('リカバリーミッションで立て直せた日がある。');
    if (rows.some(r => r.replanBack)) out.push('予定が変わっても、ちゃんと戻れている。');
    if (!out.length) out.push('記録が少なめ。明日は「前回と同じ作戦で開始」の1タップから。');
    return out.slice(0, 3);
  };

  /* ---------- バッジ ---------- */
  G.BADGES = [
    { id:'first', name:'初ミッション', em:'🎖', test: g => g.counts.meal >= 1 || g.counts.homeMeal >= 1 },
    { id:'plan1', name:'作戦会議デビュー', em:'📋', test: g => (g.counts.planStart || 0) >= 1 },
    { id:'perfect1', name:'PERFECT DAY', em:'🌟', test: g => (g.counts.perfect || 0) >= 1 },
    { id:'perfect5', name:'PERFECT×5', em:'💫', test: g => (g.counts.perfect || 0) >= 5 },
    { id:'streak3', name:'3日連続達成', em:'🔥', test: g => (g.bestStreak || 0) >= 3 },
    { id:'streak7', name:'7日連続達成', em:'🔥', test: g => (g.bestStreak || 0) >= 7 },
    { id:'streak30', name:'30日連続達成', em:'👑', test: g => (g.bestStreak || 0) >= 30 },
    { id:'water30', name:'水分マスター', em:'💧', test: g => g.counts.drink >= 30 },
    { id:'weigh7', name:'計測習慣', em:'⚖️', test: g => g.counts.weight >= 7 },
    { id:'train5', name:'トレーニング5回', em:'💪', test: g => g.counts.training >= 5 },
    { id:'nice5', name:'ナイスチョイス×5', em:'👌', test: g => (g.counts.snackNice || 0) >= 5 },
    { id:'drinkWell', name:'飲み会マスター', em:'🍻', test: g => (g.counts.drinkWell || 0) >= 1 },
    { id:'golfDay', name:'ラウンド完走', em:'⛳', test: g => (g.counts.golfDay || 0) >= 1 },
    { id:'softDay', name:'グラウンドの戦士', em:'🥎', test: g => (g.counts.softDay || 0) >= 1 },
    { id:'travelDay', name:'遠征ミッション', em:'🧳', test: g => (g.counts.travelDay || 0) >= 1 },
    { id:'replan', name:'臨機応変', em:'⚡', test: g => (g.counts.replanBack || 0) >= 1 },
    { id:'recovery', name:'リカバリー名人', em:'🌅', test: g => (g.counts.recovery || 0) >= 1 },
    { id:'rankA', name:'週間Aランク', em:'🅰️', test: g => ['S','A'].includes(g.bestRank) },
    { id:'rankS', name:'週間Sランク', em:'🏆', test: g => g.bestRank === 'S' },
    { id:'days30', name:'活動30日', em:'📅', test: g => (g.activeDays || []).length >= 30 },
    { id:'comeback', name:'おかえり！再開', em:'🌈', test: g => !!g.comeback }
  ];

  window.G = G;
})();
