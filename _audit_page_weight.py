"""Full page weight audit for Drew Builds portfolio."""
import re
import os
import base64
import json
import time
import urllib.request
from pathlib import Path
from html.parser import HTMLParser

ROOT = Path(r"c:\Users\andre\Desktop\WebDesignSite")
LIVE = "https://drew-builds.vercel.app/"

results = {
    "local_index_bytes": 0,
    "live_html_bytes": 0,
    "live_html_ms": 0,
    "base64": [],
    "local_assets": [],
    "live_resources": [],
    "scripts": [],
    "chatbot": {},
    "fonts": [],
    "inline_css_bytes": 0,
    "inline_js_bytes": 0,
}

def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        headers = dict(resp.headers)
        ct = headers.get("Content-Type", "")
    return data, (time.time() - t0) * 1000, ct, headers

# --- Local index ---
html_local = (ROOT / "index.html").read_text(encoding="utf-8")
results["local_index_bytes"] = len(html_local.encode("utf-8"))

# Base64 embeds
for m in re.finditer(r"data:image/([a-zA-Z0-9+]+);base64,([A-Za-z0-9+/=\n\r]+)", html_local):
    fmt = m.group(1)
    raw = re.sub(r"\s+", "", m.group(2))
    try:
        decoded = len(base64.b64decode(raw))
    except Exception:
        decoded = len(raw) * 3 // 4
    markup = len(m.group(0))
    # context for naming
    before = html_local[max(0, m.start() - 200):m.start()]
    name = "base64 image"
    if "about-photo" in before or "about" in before.lower():
        name = "About profile photo (base64 inline)"
    results["base64"].append({
        "name": name,
        "format": fmt,
        "decoded_bytes": decoded,
        "markup_bytes": markup,
    })

# Inline CSS / JS sizes
style_blocks = re.findall(r"<style[^>]*>(.*?)</style>", html_local, re.S | re.I)
results["inline_css_bytes"] = sum(len(s.encode("utf-8")) for s in style_blocks)
script_blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html_local, re.S | re.I)
results["inline_js_bytes"] = sum(len(s.encode("utf-8")) for s in script_blocks)

# External refs in local HTML
srcs = []
for m in re.finditer(r"""<(?:script|link|img|video|source)\b([^>]*)>""", html_local, re.I):
    attrs = m.group(1)
    tag = "resource"
    href = re.search(r"""(?:src|href)=["']([^"']+)["']""", attrs)
    if href:
        srcs.append(href.group(1))

# Chatbot analysis
chat_kw = {
    "chatBubble": html_local.count("chatBubble") + html_local.count("chat-bubble"),
    "SYSTEM_PROMPT_chars": 0,
    "api_chat_refs": html_local.count("/api/chat") + html_local.count("api/chat"),
    "groq_mentions": len(re.findall(r"groq", html_local, re.I)),
}
sp = re.search(r"const SYSTEM_PROMPT = `([\s\S]*?)`;", html_local)
if sp:
    chat_kw["SYSTEM_PROMPT_chars"] = len(sp.group(1))
# measure chat UI markup roughly
chat_section = re.search(r"(<!-- ?Chat|class=\"chat-|id=\"chat)([\s\S]{0,8000})", html_local, re.I)
results["chatbot"] = chat_kw

# Local asset sizes for thumbs + profile
for p in sorted((ROOT / "mockups" / "thumbs").glob("*.webp")):
    results["local_assets"].append({"path": f"mockups/thumbs/{p.name}", "bytes": p.stat().st_size, "type": "webp thumb"})
for name in ["Profile.jpg", "ChurchWorship.mp4"]:
    fp = ROOT / name
    if fp.exists():
        results["local_assets"].append({"path": name, "bytes": fp.stat().st_size, "type": "local media"})

# --- Live fetch ---
try:
    live_html, live_ms, live_ct, live_headers = fetch(LIVE)
    results["live_html_bytes"] = len(live_html)
    results["live_html_ms"] = round(live_ms, 1)
    live_text = live_html.decode("utf-8", errors="ignore")
except Exception as e:
    results["live_error"] = str(e)
    live_text = ""

# Parse live resources
live_urls = []
if live_text:
    for m in re.finditer(r"""(?:src|href)=["']([^"']+)["']""", live_text):
        u = m.group(1)
        if u.startswith("data:"):
            continue
        if u.startswith("//"):
            u = "https:" + u
        elif u.startswith("/"):
            u = LIVE.rstrip("/") + u
        elif u.startswith("mockups/") or u.startswith("src/") or u.startswith("api/") or u.endswith(".mp4") or u.endswith(".jpg"):
            u = LIVE.rstrip("/") + "/" + u
        elif not u.startswith("http"):
            # skip anchors etc
            if u.startswith("#") or u.startswith("mailto:") or u.startswith("javascript:"):
                continue
            u = LIVE.rstrip("/") + "/" + u.lstrip("./")
        live_urls.append(u)

# unique preserve order
seen = set()
uniq = []
for u in live_urls:
    if u not in seen:
        seen.add(u)
        uniq.append(u)

# Filter to likely weighty resources
def interesting(u):
    ul = u.lower()
    return any(x in ul for x in [
        ".webp", ".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm", ".js", ".css",
        "fonts.googleapis", "fonts.gstatic", "supabase", "vercel", "api/",
    ]) or u.endswith(".js")

to_fetch = [u for u in uniq if interesting(u)]
# always try thumbs and fonts css
for u in list(to_fetch):
    pass

print(f"Fetching {len(to_fetch)} live resources...")
for u in to_fetch:
    try:
        data, ms, ct, _ = fetch(u, timeout=45)
        results["live_resources"].append({
            "url": u,
            "bytes": len(data),
            "ms": round(ms, 1),
            "content_type": ct.split(";")[0],
        })
        print(f"  OK {len(data):8d} B  {ms:7.0f}ms  {u[:100]}")
    except Exception as e:
        results["live_resources"].append({
            "url": u,
            "bytes": None,
            "ms": None,
            "error": str(e)[:120],
        })
        print(f"  FAIL {u[:100]} :: {e}")

# Also HEAD/GET google fonts css and parse font files
font_css_urls = [u for u in uniq if "fonts.googleapis.com" in u]
for fcss in font_css_urls:
    try:
        data, ms, ct, _ = fetch(fcss)
        css = data.decode("utf-8", errors="ignore")
        font_files = re.findall(r"url\(([^)]+)\)", css)
        for ff in font_files:
            ff = ff.strip("'\"")
            if ff.startswith("//"):
                ff = "https:" + ff
            if ff in seen:
                continue
            seen.add(ff)
            try:
                fdata, fms, fct, _ = fetch(ff)
                results["fonts"].append({"url": ff, "bytes": len(fdata), "ms": round(fms, 1)})
                print(f"  FONT {len(fdata):8d} B  {ff[:100]}")
            except Exception as e:
                results["fonts"].append({"url": ff, "error": str(e)[:80]})
    except Exception as e:
        print("font css fail", e)

# api/chat.js size if present locally
api = ROOT / "api" / "chat.js"
if api.exists():
    results["scripts"].append({"path": "api/chat.js", "bytes": api.stat().st_size, "note": "serverless; not downloaded on page load unless called"})

# Summarize totals
transfer = results["live_html_bytes"] or 0
for r in results["live_resources"]:
    if r.get("bytes"):
        transfer += r["bytes"]
for r in results["fonts"]:
    if r.get("bytes"):
        transfer += r["bytes"]
results["approx_transfer_bytes"] = transfer

# Biggest offenders ranked
offenders = []
for b in results["base64"]:
    offenders.append({"name": b["name"], "bytes": b["markup_bytes"], "category": "inline base64 (in HTML)", "note": f"decoded {round(b['decoded_bytes']/1024,1)}KB; inflates HTML parse"})
offenders.append({"name": "index.html (full document)", "bytes": results["live_html_bytes"] or results["local_index_bytes"], "category": "HTML", "note": "includes inline CSS/JS/base64"})
offenders.append({"name": "Inline CSS", "bytes": results["inline_css_bytes"], "category": "render-blocking CSS", "note": "in <style> in head/body"})
offenders.append({"name": "Inline JS (chatbot + UI)", "bytes": results["inline_js_bytes"], "category": "JS", "note": "parsed/executed on load; chatbot SYSTEM_PROMPT included"})
for r in results["live_resources"]:
    if r.get("bytes"):
        offenders.append({"name": r["url"].replace(LIVE, "/"), "bytes": r["bytes"], "category": r.get("content_type") or "resource", "note": f"{r.get('ms')}ms"})
for r in results["fonts"]:
    if r.get("bytes"):
        offenders.append({"name": r["url"], "bytes": r["bytes"], "category": "font file", "note": f"{r.get('ms')}ms"})

offenders.sort(key=lambda x: x["bytes"] or 0, reverse=True)
results["top_offenders"] = offenders[:25]
results["chatbot"]["inline_js_bytes"] = results["inline_js_bytes"]

out = ROOT / "_page_weight_audit.json"
out.write_text(json.dumps(results, indent=2), encoding="utf-8")
print("\n=== SUMMARY ===")
print("local index KB", round(results["local_index_bytes"]/1024,1))
print("live html KB", round((results["live_html_bytes"] or 0)/1024,1), "ms", results["live_html_ms"])
print("approx transfer KB", round(transfer/1024,1))
print("base64 markup KB", round(sum(b["markup_bytes"] for b in results["base64"])/1024,1))
print("inline css KB", round(results["inline_css_bytes"]/1024,1))
print("inline js KB", round(results["inline_js_bytes"]/1024,1))
print("\nTOP OFFENDERS:")
for o in offenders[:15]:
    print(f"  {round(o['bytes']/1024,1):8.1f} KB  [{o['category']}] {o['name'][:90]}")
print("Wrote", out)
