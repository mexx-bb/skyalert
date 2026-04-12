import urllib.request, json
url = "https://raw.githubusercontent.com/mwgg/Airports/master/airports.json"
req = urllib.request.urlopen(url)
data = json.loads(req.read().decode())
result = []
for k, v in data.items():
    iata = v.get("iata")
    if iata and iata != "\\N" and iata.strip() != "":
        result.append({
            "i": iata,
            "c": v.get("city", ""),
            "n": v.get("name", ""),
            "co": v.get("country", "")
        })
with open("airports_db.js", "w", encoding="utf-8") as f:
    f.write("const AIRPORTS_DB = " + json.dumps(result) + ";\n")
print(f"Generated airports_db.js with {len(result)} airports.")
