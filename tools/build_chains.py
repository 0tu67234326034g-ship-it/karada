import json
T="2026-10-04"
def it(id,name,price,kcal=None,p=None,f=None,c=None,s=None,url=None,size=None,role="main",note=None,tags=None):
    return {"id":id,"name":name,"size":size,"priceYen":price,"nutrition":{"kcal":kcal,"protein":p,"fat":f,"carbs":c,"salt":s},
            "role":role,"tags":tags or [],"verifiedAt":T,"officialUrl":url,"note":note,"limited":False,"status":"active","source":"official"}
MU="https://www.matsuyafoods.co.jp/matsuya/menu/"
SW="https://subway.co.jp/menu/"
chains=[
 {"id":"yoshinoya","name":"吉野家","genre":"牛丼・定食","aliases":["吉野家","Yoshinoya","yoshinoya"],"officialUrl":"https://www.yoshinoya.com/menu/",
  "items":[
   it("yoshinoya-gyudon-nami","牛丼",498,url="https://www.yoshinoya.com/menu/gyudon",size="並盛",note="栄養成分は公式サイトで取得できず未登録",tags=["牛"]),
   it("yoshinoya-gyuzara-teishoku","牛皿定食",789,url="https://www.yoshinoya.com/menu/set",note="栄養成分未登録",tags=["牛","定食"]),
   it("yoshinoya-gyusake","牛鮭定食",844,url="https://www.yoshinoya.com/menu/set",note="栄養成分未登録",tags=["牛","魚","定食"]),
   it("yoshinoya-gyusaba","牛さば定食",844,url="https://www.yoshinoya.com/menu/set",note="栄養成分未登録",tags=["牛","魚","定食"]),
   it("yoshinoya-oniporon","鬼おろしポン酢牛丼",660,url="https://www.yoshinoya.com/menu/gyudon",size="並盛",note="栄養成分未登録",tags=["牛"]),
  ]},
 {"id":"sukiya","name":"すき家","genre":"牛丼・定食","aliases":["すき家","Sukiya","sukiya"],"officialUrl":"https://www.sukiya.jp/","items":[],
  "dataNote":"公式の栄養成分PDF（2026/9/29更新）はあるが、表の読み取りで列の対応が確認できなかったため未登録。"},
 {"id":"matsuya","name":"松屋","genre":"牛丼・定食","aliases":["松屋","Matsuya","matsuya"],"officialUrl":MU,
  "items":[
   it("matsuya-gyumeshi-ko","牛めし",430,507,13.1,22.8,59.6,2.6,MU+"gyumeshi/gyumeshi_hp_250422.html",size="小盛",tags=["牛"]),
   it("matsuya-gyumeshi-nami","牛めし",460,687,17.1,28.9,85.5,3.0,MU+"gyumeshi/gyumeshi_hp_250422.html",size="並盛",tags=["牛"]),
   it("matsuya-gyumeshi-atama","牛めし",630,765,19.8,35.6,87.2,3.5,MU+"gyumeshi/gyumeshi_hp_250422.html",size="あたま大盛",tags=["牛"]),
   it("matsuya-oniponzu-nami","鬼おろしポン酢牛めし",560,714,18.3,29.1,90.8,4.5,MU+"gyumeshi/gyu_onioroshi_hp_250422.html",size="並盛",tags=["牛"]),
   it("matsuya-aburisake","“炙り”焼鮭定食",800,698,25.7,24,91,5.6,MU+"teishoku/tei_aburi_sake_hp_250422.html",note="店内飲食のみ。みそ汁付き",tags=["魚","定食"]),
   it("matsuya-porkloin","豚ロース焼肉定食",790,736,27.9,28.9,88.7,3.0,MU+"teishoku/tei_porkloin_hp_260630.html",tags=["豚","定食"]),
   it("matsuya-gyuyaki","牛焼肉定食",890,806,23.3,41.3,86.5,2.3,MU+"teishoku/tei_gyuuyaki_hp_250422.html",tags=["牛","定食"]),
   it("matsuya-shogayaki","生姜焼き定食",850,952,30.8,43.8,106.4,6.4,MU+"teishoku/tei_shougayaki_hp_260707.html",tags=["豚","定食"]),
  ]},
 {"id":"yayoiken","name":"やよい軒","genre":"牛丼・定食","aliases":["やよい軒","Yayoiken","yayoiken"],"officialUrl":"https://www.yayoiken.com/menu_list/","items":[]},
 {"id":"ootoya","name":"大戸屋","genre":"牛丼・定食","aliases":["大戸屋","Ootoya","OOTOYA","ootoya"],"officialUrl":"https://www.ootoya.com/menu/","items":[],"dataNote":"公式メニューは店舗選択後に表示される仕組みで取得できず。"},
 {"id":"sushiro","name":"スシロー","genre":"寿司","aliases":["スシロー","Sushiro","sushiro"],"officialUrl":"https://www.akindo-sushiro.co.jp/menu/","items":[],"sushi":True,"dataNote":"公式メニューは店舗選択後に表示。栄養成分未取得。"},
 {"id":"kurasushi","name":"くら寿司","genre":"寿司","aliases":["くら寿司","Kura Sushi","kura sushi","無添くら寿司"],"officialUrl":"https://www.kurasushi.co.jp/menu/","items":[],"sushi":True},
 {"id":"hamasushi","name":"はま寿司","genre":"寿司","aliases":["はま寿司","Hama Sushi","hamazushi"],"officialUrl":"https://www.hama-sushi.co.jp/menu/","items":[],"sushi":True},
 {"id":"kappasushi","name":"かっぱ寿司","genre":"寿司","aliases":["かっぱ寿司","Kappa Sushi","kappa sushi"],"officialUrl":"https://www.kappasushi.jp/menu/","items":[],"sushi":True},
 {"id":"ohsho","name":"餃子の王将","genre":"中華・麺類","aliases":["餃子の王将","王将","Gyoza no Ohsho","Ohsho"],"officialUrl":"https://www.ohsho.co.jp/menu/","items":[]},
 {"id":"hidakaya","name":"日高屋","genre":"中華・麺類","aliases":["日高屋","Hidakaya","熱烈中華食堂 日高屋"],"officialUrl":"https://hidakaya.hiday.co.jp/menu/","items":[]},
 {"id":"bamiyan","name":"バーミヤン","genre":"中華・麺類","aliases":["バーミヤン","Bamiyan"],"officialUrl":"https://www.skylark.co.jp/bamiyan/menu/","items":[]},
 {"id":"marugame","name":"丸亀製麺","genre":"中華・麺類","aliases":["丸亀製麺","Marugame Seimen","Marugame"],"officialUrl":"https://www.marugame.com/menu/","items":[]},
 {"id":"gusto","name":"ガスト","genre":"ファミレス・カレー","aliases":["ガスト","Gusto","すかいらーく"],"officialUrl":"https://www.skylark.co.jp/gusto/menu/","items":[]},
 {"id":"saizeriya","name":"サイゼリヤ","genre":"ファミレス・カレー","aliases":["サイゼリヤ","Saizeriya"],"officialUrl":"https://www.saizeriya.co.jp/menu/","items":[],"dataNote":"公式メニューは電子ブック形式で数値を自動取得できず。"},
 {"id":"cocos","name":"ココス","genre":"ファミレス・カレー","aliases":["ココス","COCO'S","Coco's","cocos"],"officialUrl":"https://www.cocos-jpn.co.jp/menu/","items":[]},
 {"id":"dennys","name":"デニーズ","genre":"ファミレス・カレー","aliases":["デニーズ","Denny's","Dennys"],"officialUrl":"https://www.dennys.jp/menu/","items":[]},
 {"id":"cocoichi","name":"CoCo壱番屋","genre":"ファミレス・カレー","aliases":["CoCo壱番屋","ココイチ","CoCo Ichibanya","カレーハウスCoCo壱番屋"],"officialUrl":"https://www.ichibanya.co.jp/menu/","items":[]},
 {"id":"mcdonalds","name":"マクドナルド","genre":"ファストフード・カフェ","aliases":["マクドナルド","McDonald's","Mcdonalds","マック"],"officialUrl":"https://www.mcdonalds.co.jp/menu/",
  "items":[ it("mcd-1250","マックチキン",190,386,13.5,19.6,39.5,2.1,"https://www.mcdonalds.co.jp/products/1250/",note="価格は「190円〜」（店舗により異なる）",tags=["鶏"]) ]},
 {"id":"mos","name":"モスバーガー","genre":"ファストフード・カフェ","aliases":["モスバーガー","MOS BURGER","Mos Burger"],"officialUrl":"https://www.mos.jp/menu/","items":[]},
 {"id":"subway","name":"サブウェイ","genre":"ファストフード・カフェ","aliases":["サブウェイ","SUBWAY","Subway"],"officialUrl":SW,
  "items":[
   it("subway-saladchicken","サラダチキン",550,281,21.2,2.8,44.1,2.2,SW+"salad-chicken-sandwich/",size="レギュラー",note="標準：ハニーオーツ＋はちみつマスタード",tags=["鶏"]),
   it("subway-zakutaru-chicken","ザクタルグリルチキン",680,371,19,14.2,43.1,2.9,SW+"zakutaru-grilled-chicken/",size="レギュラー",note="標準：ホワイトブレッド",tags=["鶏"]),
   it("subway-zakutaru-ebi","ザクタルえびブロッコリー",650,304,12.4,10,42.4,2.4,SW+"zakutaru-shrimp-broccoli/",size="レギュラー",note="標準：ホワイトブレッド",tags=["えび"]),
   it("subway-veggie","ベジーデライト",430,215,7.2,4.4,38,1.5,SW+"veggie-delight/",size="レギュラー",tags=["野菜"]),
   it("subway-ham","ハム",480,260,12.4,6.4,40,2.1,SW+"ham-sandwich/",size="レギュラー",tags=["豚"]),
   it("subway-egg","たまご",500,318,url=SW+"egg-sandwich/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["卵"]),
   it("subway-tuna","ツナ",490,350,url=SW+"tuna-sandwich/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["魚"]),
   it("subway-avocado","アボカドベジー",520,295,url=SW+"avocado-veggie/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["野菜"]),
   it("subway-chili","チリチキン",550,273,url=SW+"chili-chicken-sandwich/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["鶏"]),
   it("subway-blt","BLT",560,335,url=SW+"blt/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["豚"]),
   it("subway-teriyaki","てり焼きチキン",580,346,url=SW+"teriyaki-chicken-sandwich/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["鶏"]),
   it("subway-ebitama","えびたま",570,321,url=SW+"ebitama/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["えび","卵"]),
   it("subway-ebiavo","えびアボカド",630,319,url=SW+"ebi-avocado/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["えび"]),
   it("subway-zakutaru-ham","ザクタルハム",620,337,url=SW+"zakutaru-ham/",size="レギュラー",note="公式一覧のkcalのみ確認",tags=["豚"]),
  ]},
 {"id":"starbucks","name":"スターバックス","genre":"ファストフード・カフェ","aliases":["スターバックス","Starbucks","スタバ","スターバックス コーヒー"],"officialUrl":"https://product.starbucks.co.jp/","items":[]},
]
conv=[
 {"id":"seven","name":"セブン-イレブン","aliases":["セブン-イレブン","セブンイレブン","7-Eleven","Seven-Eleven","7-eleven"]},
 {"id":"lawson","name":"ローソン","aliases":["ローソン","Lawson","LAWSON","ナチュラルローソン","ローソンストア100"]},
 {"id":"famima","name":"ファミリーマート","aliases":["ファミリーマート","FamilyMart","Family Mart","ファミマ"]},
]
VERIFIED={"yoshinoya","matsuya","sushiro","ootoya","saizeriya","mcdonalds","subway"}
for c in chains:
    if c["id"] not in VERIFIED: c["officialUrl"]=None  # 公式URL未確認
    c.setdefault("dataNote", None if c["items"] else "公式メニュー・栄養成分は未取得。メニュー写真モード（AI）または案内ガイドで対応。")
json.dump({"version":T,"convenience":conv,"chains":chains},open("../app/chains.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)
print(sum(len(c["items"]) for c in chains), "chain items;", sum(1 for c in chains if c["items"]), "chains with items")
