"""trace dedup per-round in 160728 raw.json 320-330 window"""
import json, re

raw = json.load(open('160728/gladia_raw.json'))
utts = raw['segments']

def show(merged, label):
    print(f'--- {label}: total {len(merged)} ---')
    for u in merged:
        if 320 <= u['start'] <= 330:
            print(f'  {u["start"]:.2f}-{u["end"]:.2f}: {u["text"]!r}')

# R0
merged = []
for u in utts:
    t = u["text"].strip()
    if not t or not any(c.isalnum() for c in t):
        continue
    merged.append({"start": u["start"], "end": u["end"], "speaker": u.get("speaker"), "text": t})
show(merged, 'R0')

# R1 inline
PUNCT = re.compile(r"([.,;:?!]\s*)")
def split_sents(t):
    parts = PUNCT.split(t); out = []; i = 0
    while i < len(parts):
        if i + 1 < len(parts) and PUNCT.match(parts[i + 1]):
            out.append((parts[i], parts[i + 1])); i += 2
        else:
            if parts[i].strip():
                out.append((parts[i], "")); i += 1
    return out
def dedup_inline(text):
    t = text.strip()
    if not t: return t
    sents = split_sents(t); deduped = []
    for s, sep in sents:
        s_norm = s.strip().lower()
        if deduped and deduped[-1][0].strip().lower() == s_norm:
            if not deduped[-1][1] and sep:
                deduped[-1] = (deduped[-1][0], sep)
            continue
        deduped.append((s, sep))
    out = "".join(s + sep for s, sep in deduped).strip()
    if out != t: return out
    words = t.split(); n = len(words)
    if n >= 4 and n % 2 == 0:
        half = n // 2
        if [w.lower() for w in words[:half]] == [w.lower() for w in words[half:]]:
            return " ".join(words[:half])
    if len(sents) >= 2:
        last_text = sents[-1][0].strip()
        last_words = [w.lower() for w in last_text.split()]
        prev_text = sents[-2][0].strip()
        prev_words = [w.lower() for w in prev_text.split()]
        m = len(last_words)
        if m > 0 and len(prev_words) > m and prev_words[-m:] == last_words:
            return "".join(s + sep for s, sep in sents[:-1]).strip()
    return t
for u in merged:
    u['text'] = dedup_inline(u['text'])
show(merged, 'R1')

# R2 jaccard>0.7 merge
def jaccard(a, b):
    ta = set(a.lower().split()); tb = set(b.lower().split())
    if not ta or not tb: return 0.0
    return len(ta & tb) / len(ta | tb)
m2 = []
for u in merged:
    t = u['text']
    if m2 and jaccard(m2[-1]['text'], t) > 0.7:
        prev = m2[-1]; prev['end'] = u['end']; prev['text'] = prev['text'] + ' ' + t
    else:
        m2.append({'start': u['start'], 'end': u['end'], 'speaker': u.get('speaker'), 'text': t})
merged = m2
show(merged, 'R2')

# R3 adjacent exact dup
def norm_text(t):
    return t.strip().lower().rstrip('.,;:?! ')
m3 = []
for u in merged:
    t_norm = norm_text(u['text'])
    if m3 and norm_text(m3[-1]['text']) == t_norm and t_norm:
        continue
    m3.append(u)
merged = m3
show(merged, 'R3')

# R4 cross jaccard>0.7 + time<1.5s
i = 0
while i < len(merged) - 1:
    a, b = merged[i], merged[i+1]
    if jaccard(a['text'], b['text']) > 0.7 and abs(b['start'] - a['end']) < 1.5:
        a['end'] = b['end']; a['text'] = a['text'] + ' ' + b['text']
        merged.pop(i+1)
    else:
        i += 1
show(merged, 'R4')

# R5 short fragment merge to prev
MIN_FRAGMENT_DURATION = 0.8
MERGE_FRAGMENT_GAP = 1.5
m5 = list(merged)
i = 0
while i < len(m5):
    cur = m5[i]
    nw = len(cur['text'].split())
    duration = cur['end'] - cur['start']
    if nw < 3 and duration < MIN_FRAGMENT_DURATION and i > 0:
        prev = m5[i-1]
        gap = cur['start'] - prev['end']
        same_speaker = (prev.get('speaker') is None or cur.get('speaker') is None
                        or prev.get('speaker') == cur.get('speaker'))
        if gap < MERGE_FRAGMENT_GAP and same_speaker:
            prev['end'] = cur['end']
            prev['text'] = prev['text'] + ' ' + cur['text']
            m5.pop(i)
            continue
    i += 1
show(m5, 'R5')