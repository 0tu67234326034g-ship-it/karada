import csv, json, datetime
TODAY = "2026-10-04"
def num(v):
    v=(v or "").strip()
    if v=="" : return None
    try: return float(v)
    except: return None
def load(fn, store, storeName):
    out=[]
    with open(fn, encoding="utf-8") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            if not r.get("id"): continue
            name=r["name"].strip()
            n={k:num(r[k]) for k in ["kcal","p","f","c","salt"]}
            out.append({
              "id": f"{store}-{r['id'].strip()}",
              "store": store,
              "storeName": storeName,
              "name": name,
              "flavor": None,
              "size": None,
              "category": r["category"].strip(),
              "priceYen": num(r["price"]),
              "nutrition": {"kcal":n["kcal"],"protein":n["p"],"fat":n["f"],"carbs":n["c"],"salt":n["salt"]},
              "caffeineMg": None,
              "region": (r.get("region") or "").strip() or None,
              "status": "active",
              "verifiedAt": TODAY,
              "officialUrl": r["url"].strip(),
              "image": None,
              "note": (r.get("note") or "").strip() or None,
              "source": "official"
            })
    return out
products = load("raw_seven.tsv","seven","セブン-イレブン") + load("raw_lawson.tsv","lawson","ローソン") + load("raw_family.tsv","famima","ファミリーマート")
# flavor/size parsing for drinks and salad chicken
import re
for p in products:
    m=re.search(r'([０-９0-9\.]+)\s*(ｍｌ|ml|ＭＬ|ML|Ｌ|L)\b', p["name"])
    if m:
        p["size"]=m.group(0)
    for fl in ["プレーン","スモーク","ハーブ","梅しそ","旨塩","てりやき味","3種のハーブ&スパイス","アルペンザルツ岩塩","ペッパー&ガーリック"]:
        if "サラダチキン" in p["name"] or "鶏もも" in p["name"]:
            if fl in p["name"]: p["flavor"]=fl
json.dump({"version":TODAY,"note":"公式サイトで確認できた商品のみ。null は公式ページで確認できなかった項目。","products":products},
          open("../app/products.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)
from collections import Counter
print(len(products), Counter(p["store"] for p in products))
print("nutrition complete:", Counter(p["store"] for p in products if p["nutrition"]["kcal"] is not None))
