"""
Standard portrait base, in every expression state.

Geometry is defined once and emitted as both SVG (the editable master an artist
paints over) and PNG (for review). Two hand-maintained copies would drift, and
the entire value of a base is that every persona's art lands in the same slot.

Canvas 300x400 to match the app's 3:4 portrait tile. The figure is 6 heads tall
rather than a realistic 7.5: at the size a tile actually renders the head would
otherwise be ~40px and its expression illegible, which defeats having
expressions. Six heads reads as stylised adult, not chibi.
"""
import math, os, random
from PIL import Image, ImageDraw, ImageFilter

W, H, SS = 300, 400, 4
HEAD_TOP, GROUND, HEAD_U, CX = 40, 372, 55, 150

PAL = dict(
    sky_hi="#39415a", sky_lo="#171b26", glow="#5a6party",  # placeholder replaced below
)
PAL = dict(
    sky_hi=(57, 65, 90), sky_lo=(20, 23, 33), glow=(120, 138, 180),
    floor=(12, 14, 20), body=(126, 136, 155), body_sh=(92, 100, 118),
    rim=(198, 214, 244), ink=(28, 32, 42), eye=(233, 238, 248),
)

def catmull(pts, closed=True, n=18):
    """Smooth outline through control points — the difference between a figure
    and a stack of boxes."""
    P = list(pts)
    P = ([P[-1]] + P + [P[0], P[1]]) if closed else ([P[0]] + P + [P[-1]])
    out = []
    for i in range(len(P) - 3):
        p0, p1, p2, p3 = P[i:i+4]
        for k in range(n):
            t = k / n; t2 = t*t; t3 = t2*t
            out.append((
                0.5*((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
                0.5*((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3),
            ))
    return out

def mirror(pts): return [(2*CX - x, y) for x, y in pts]

# Left profile only; the right side is mirrored so the figure cannot drift out
# of symmetry while the proportions are being tuned.
HEAD = [(150,38),(168,43),(175,61),(171,78),(160,92),(150,97),(140,92),(129,78),(125,61),(132,43)]
TORSO_L = [(142,88),(138,107),(118,113),(105,128),(103,150),(112,178),(117,200),(112,226),(116,250)]
ARM_L  = [(107,118),(93,131),(87,180),(93,244),(106,246),(104,182),(115,132)]
LEG_L  = [(114,246),(147,246),(145,300),(138,358),(119,358),(115,300)]
SHOE_L = [(111,354),(143,354),(149,369),(107,369)]

def closed_from_left(left):
    """Mirror a left profile into a symmetric closed outline."""
    return left + [(2*CX - x, y) for x, y in reversed(left)]

TORSO = closed_from_left(TORSO_L)

STATES = {
 "idle":          dict(brow="neutral", mouth="closed", gaze=(0,0),   pose="rest",
                       desc="Stoic, facing the viewer. Resting state."),
 "talking":       dict(brow="neutral", mouth="open",   gaze=(0,0),   pose="rest",
                       desc="Neutral speech. Alternates with idle to form a talk loop."),
 "angry":         dict(brow="angry",   mouth="tight",  gaze=(0,0),   pose="rest",
                       desc="Angry, silent — hearing something they dislike."),
 "angry_talking": dict(brow="angry",   mouth="shout",  gaze=(0,0),   pose="rest",
                       desc="Angry speech. Alternates with angry for an angry loop."),
 "thinking":      dict(brow="raised",  mouth="closed", gaze=(-3,-4), pose="chin",
                       desc="Composing. Covers the 2-7s before the first token."),
}

def bg(img, s):
    d = ImageDraw.Draw(img)
    for y in range(H*s):
        t = (y/(H*s)) ** 0.85
        d.line([(0,y),(W*s,y)], fill=tuple(int(PAL["sky_hi"][i]*(1-t) + PAL["sky_lo"][i]*t) for i in range(3)))
    # Soft glow behind the head, built on its own layer so it blends instead of
    # banding into concentric rings.
    g = Image.new("L", (W*s, H*s), 0)
    gd = ImageDraw.Draw(g)
    gd.ellipse([ (CX-118)*s, (86-104)*s, (CX+118)*s, (86+104)*s ], fill=90)
    g = g.filter(ImageFilter.GaussianBlur(38*s/4))
    img.paste(Image.new("RGB",(W*s,H*s),PAL["glow"]), (0,0), g)
    # floor
    f = Image.new("L",(W*s,H*s),0)
    ImageDraw.Draw(f).ellipse([(CX-104)*s,(GROUND-12)*s,(CX+104)*s,(GROUND+20)*s], fill=200)
    f = f.filter(ImageFilter.GaussianBlur(7*s/4))
    img.paste(Image.new("RGB",(W*s,H*s),PAL["floor"]), (0,0), f)

def figure(img, cfg, s):
    d = ImageDraw.Draw(img)
    S = lambda p: [(x*s, y*s) for x, y in p]
    arm_r = mirror(ARM_L)
    hands = [(96,251,10,12), (204,251,10,12)]
    if cfg["pose"] == "chin":
        arm_r = [(195,120),(206,133),(200,176),(176,163),(168,150),(180,146),(187,131)]
        hands = [hands[0], (166,143,11,12)]

    parts = [(catmull(LEG_L), PAL["body_sh"]), (catmull(mirror(LEG_L)), PAL["body_sh"]),
             (catmull(SHOE_L), PAL["ink"]),    (catmull(mirror(SHOE_L)), PAL["ink"]),
             (catmull(TORSO), PAL["body"]),
             (catmull(ARM_L), PAL["body_sh"]), (catmull(arm_r), PAL["body_sh"]),
             (catmull(HEAD), PAL["body"])]

    # Rim light: the silhouette drawn once offset up-left in a pale tone, then
    # the figure over it. Cheap, and it is most of the "illustrated" feel.
    for pts, _ in parts:
        d.polygon(S([(x-2.0, y-2.0) for x, y in pts]), fill=PAL["rim"])
    for pts, col in parts:
        d.polygon(S(pts), fill=col)

    for x,y,rx,ry in hands:
        d.ellipse([(x-rx)*s,(y-ry)*s,(x+rx)*s,(y+ry)*s], fill=PAL["body_sh"])

    gx, gy = cfg["gaze"]
    for sx in (-1,1):
        ex = CX + sx*11
        d.ellipse([(ex-5)*s,(68-6)*s,(ex+5)*s,(68+6)*s], fill=PAL["eye"])
        d.ellipse([(ex+gx-2.6)*s,(68+gy-2.6)*s,(ex+gx+2.6)*s,(68+gy+2.6)*s], fill=PAL["ink"])

    b = cfg["brow"]
    for sx in (-1,1):
        x0, x1 = CX+sx*4.5, CX+sx*18
        y0, y1 = {"angry":(60,52), "raised":(50,54)}.get(b, (54,55))
        d.line([(x0*s,y0*s),(x1*s,y1*s)], fill=PAL["ink"], width=int(3.4*s))

    d.line([(CX*s,74*s),((CX-3.5)*s,80*s)], fill=PAL["body_sh"], width=int(2.4*s))

    m = cfg["mouth"]
    if m == "closed":  d.line([((CX-9)*s,86*s),((CX+9)*s,86*s)], fill=PAL["ink"], width=int(2.6*s))
    elif m == "tight": d.line([((CX-10)*s,88*s),(CX*s,84*s),((CX+10)*s,88*s)], fill=PAL["ink"], width=int(3.0*s))
    elif m == "open":  d.ellipse([(CX-8)*s,81*s,(CX+8)*s,93*s], fill=PAL["ink"])
    elif m == "shout": d.ellipse([(CX-10)*s,79*s,(CX+10)*s,96*s], fill=PAL["ink"])

def vignette_and_grain(img, s):
    v = Image.new("L",(W*s,H*s),0)
    ImageDraw.Draw(v).ellipse([-W*s*0.25, -H*s*0.2, W*s*1.25, H*s*1.2], fill=255)
    v = v.filter(ImageFilter.GaussianBlur(60*s/4)).point(lambda p: 255-p)
    img.paste(Image.new("RGB",(W*s,H*s),(0,0,0)), (0,0), v.point(lambda p: int(p*0.55)))
    # Fine grain keeps big flat areas from looking like clip-art.
    rnd = random.Random(7)
    n = Image.new("L",(W,H))
    n.putdata([128 + rnd.randint(-9,9) for _ in range(W*H)])
    n = n.resize((W*s,H*s), Image.BILINEAR)
    img.paste(Image.blend(img, Image.merge("RGB",(n,n,n)), 0.05))

def render(state, scale=1.0):
    img = Image.new("RGB",(W*SS,H*SS),PAL["sky_lo"])
    bg(img, SS); figure(img, STATES[state], SS); vignette_and_grain(img, SS)
    return img.resize((int(W*scale),int(H*scale)), Image.LANCZOS)

os.makedirs("out", exist_ok=True)
for st in STATES: render(st).save(f"out/{st}.png")
sheet = Image.new("RGB",(W*len(STATES),H),(13,15,20))
for i,st in enumerate(STATES): sheet.paste(Image.open(f"out/{st}.png"),(i*W,0))
sheet.save("out/_sheet.png")
print("rendered:", ", ".join(STATES))
