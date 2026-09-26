# Labelled result sheets from render.mjs's pictures and the bench's numbers: one image per model, and with --examples
# JPEGs sized for the README of the models marked "example" in the manifest. Needs Pillow (pip install pillow).
# usage: python3 test/models/sheets.py [id ...] [--renders=testdata/models/renders]
#        [--runs=testdata/models/results/runs.json] [--examples=docs/examples]
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
ids = [a for a in sys.argv[1:] if not a.startswith('--')]
renders = args.get('renders', os.path.join(ROOT, 'testdata/models/renders'))
runs = json.load(open(args.get('runs', os.path.join(ROOT, 'testdata/models/results/runs.json'))))
manifest = json.load(open(os.path.join(ROOT, 'test/models/manifest.json')))

BG, INK, SOFT, RED = (236, 234, 229), (38, 36, 33), (104, 99, 92), (190, 44, 36)
FONTS = [('/System/Library/Fonts/HelveticaNeue.ttc', 0, 1), ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 0, 0)]
def font(size, bold=False):
    for path, regular, heavy in FONTS:
        if os.path.exists(path):
            return ImageFont.truetype(path.replace('Sans.ttf', 'Sans-Bold.ttf') if bold and 'DejaVu' in path else path, size, index=heavy if bold else regular)
    return ImageFont.load_default(size)

TITLES = {'original': 'Original', 'tris-20000': 'Triangles, 20k asked', 'quads-10000': 'Quads, 10k asked', 'mirrored-quads-10000': 'Mirrored quads, 10k asked'}
ORDER = ['original', 'tris', 'quads', 'mirrored-quads']
def title(key):
    if key in TITLES: return TITLES[key]
    mode, budget = key.rsplit('-', 1)
    return f"{mode.replace('-', ' ').capitalize()}, {int(budget) // 1000}k asked"
def rank(key): return (ORDER.index(key.rsplit('-', 1)[0]) if key != 'original' else 0, key)
def secs(ms): return f'{ms / 1000:.1f} s' if ms < 10000 else f'{round(ms / 1000)} s'
def n(x): return f'{x:,}'
def plural(k, word): return f"{n(k)} {word}{'' if k == 1 else 's'}"

stats = {(r['id'], f"{r['mode'].replace(' ', '-')}-{r['budget']}"): r for r in runs}

def sheet(m):
    meta = json.load(open(os.path.join(renders, m['id'], 'panels.json')))
    panels = sorted(meta['panels'], key=lambda p: rank(p['key']))
    # A column is as wide as its picture or its longest caption line, whichever is wider; the picture sits in the middle.
    W, H, pad, cap, top = meta['W'], meta['H'], 18, 96, 86
    C = max(W, 440)
    img = Image.new('RGB', (pad + len(panels) * (C + pad), top + H + cap + pad), BG)
    d = ImageDraw.Draw(img)
    d.text((pad, 16), m['name'], font=font(26, True), fill=INK)
    lic = m['license'].split(';')[0].split(':')[0].split(' (')[0]
    d.text((pad, 50), f"{n(m['vertices'])} vertices, {n(m['triangles'])} triangles  ·  {m['credit']}  ·  {lic}", font=font(15), fill=SOFT)
    for i, p in enumerate(panels):
        x, y = pad + i * (C + pad), top
        img.paste(Image.open(os.path.join(renders, m['id'], p['file'])), (x + (C - W) // 2, y))
        d.text((x, y + H + 10), title(p['key']), font=font(17, True), fill=INK)
        if p['key'] == 'original':
            d.text((x, y + H + 34), f"{n(meta['original']['triangles'])} triangles", font=font(15), fill=SOFT)
            continue
        s = stats.get((m['id'], p['key']))
        if not s: continue
        dev = s['deviation']
        line1 = f"{n(s['faces'])} faces  ·  {secs(s['ms'])}" + (f"  ·  poles {100 * s['poles']:.0f}%" if s.get('poles') is not None else '')
        d.text((x, y + H + 34), line1, font=font(15), fill=SOFT)
        # Worst distance of the original's surface from the result, as a share of the model's diagonal; 2% and more
        # means a part went missing.
        d.text((x, y + H + 54), f"off the original: p99 {dev['p99']:.2f}%, worst {dev['max']:.2f}% of the diagonal", font=font(15), fill=RED if dev['max'] >= 2 else SOFT)
        flags = []
        if s['open'] and meta['original'].get('open', 1) == 0: flags.append(f"{plural(s['open'], 'open edge')} (the original is closed)")
        if s.get('degenerate'): flags.append(plural(s['degenerate'], 'flat triangle'))
        if flags: d.text((x, y + H + 74), ', '.join(flags), font=font(15), fill=RED)
    return img

examples = args.get('examples')
if examples: os.makedirs(examples, exist_ok=True)
for m in manifest['models']:
    if (ids and m['id'] not in ids) or not os.path.exists(os.path.join(renders, m['id'], 'panels.json')): continue
    img = sheet(m)
    out = os.path.join(renders, f"{m['id']}.png")
    img.save(out)
    if examples and m.get('example'):
        # README pictures (models marked "example" in the manifest): at most 1800 px wide, as progressive JPEG.
        k = min(1, 1800 / img.width)
        small = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS) if k < 1 else img
        small.save(os.path.join(examples, f"{m['id']}.jpg"), 'JPEG', quality=86, optimize=True, progressive=True)
    print(out)
