#!/usr/bin/env python3
"""Nova 架构主图生成器：一张浅色、少字、表达判断的总览图。
输出 nova-overview.{zh-CN,en}.{light,dark}.svg 到指定目录。
结构：中心 logo，外面一圈执行闭环（上下文→记忆→交互→执行），交互节点高亮成前后脑，
最外层是端侧边界（数据与密钥留在设备上），底部一排五端设备，右侧边界外是只转发密文的 Relay 和可选的云模型。
"""
import math, sys, pathlib

W, H = 1600, 1020
CX, CY, R = 640, 470, 228

T = {
 'zh-CN': dict(
  title='Nova Personal Agent', sub='记忆和主动只是起点，我们押注的是交互、理解和端侧。',
  nodes=[('上下文', 'Context', ['聊天记录', '消息与邮件', '日程与屏幕']),
         ('记忆', 'Memory', ['时间线', '关于我', '待办 · 目标']),
         ('交互', 'Interaction', ['前脑陪你聊', '后脑替你办', '少问，问到点上']),
         ('执行', 'Execution', ['写代码', '操作电脑', '操作手机'])],
  proactive='主动：该开口时才开口',
  update='做完的事，又成了新的上下文',
  edge='端侧边界 · Local-first', edge_sub='数据、记忆和密钥，都留在你自己的设备上',
  devices=[('Mac', '主机 · 本地推理'), ('Windows', '桌面端'), ('Linux', '桌面端'), ('iPhone', '原生前后脑'), ('Android', '原生操作手机')],
  e2ee='端到端加密',
  relay='Relay', relay_sub='只转发密文\n看不到任何内容',
  cloud='云端模型', cloud_sub='可选，按需调用\n也能全部换成本地',
  local='本地推理栈', local_sub='记忆提取 · 全双工语音',
 ),
 'en': dict(
  title='Nova Personal Agent', sub='Memory and proactivity are the baseline. Interaction, intent and local-first are our bet.',
  nodes=[('Context', '', ['Chats', 'IM / Mail', 'Calendar / Screen']),
         ('Memory', '', ['Timeline', 'Profile', 'Todos · Goals']),
         ('Interaction', '', ['Front brain: talks', 'Back brain: works', 'Asks only what matters']),
         ('Execution', '', ['Coding', 'Computer-use', 'Mobile-use'])],
  proactive='Proactive: speaks up only when it matters',
  update='Results flow back as context',
  edge='Device boundary · Local-first', edge_sub='Data, memory and keys stay on your devices',
  devices=[('Mac', 'Host · local inference'), ('Windows', 'Desktop'), ('Linux', 'Desktop'), ('iPhone', 'Native front/back brain'), ('Android', 'Native mobile-use')],
  e2ee='End-to-end encrypted',
  relay='Relay', relay_sub='Forwards ciphertext only\nsees no content',
  cloud='Cloud models', cloud_sub='Optional, on demand\nswap for local anytime',
  local='Local stack', local_sub='Memory · full-duplex voice',
 ),
}

THEME = {
 'light': dict(bg='#f7f8fb', card='#ffffff', line='#dfe5ee', ink='#1d2636', sub='#5c687b', faint='#93a0b3',
               blue='#3972e9', blueSoft='#e8effd', teal='#2f8a76', tealSoft='#e6f3ef', edge='#3972e9', edgeFill='#eef3fc',
               disk='#0d121a', glow='#ffffff', shadow='rgba(29,38,54,.10)'),
 'dark':  dict(bg='#0b0f16', card='#131a25', line='#263142', ink='#e7ecf4', sub='#a3afc1', faint='#6f7c90',
               blue='#7ea6f6', blueSoft='#18243a', teal='#62c3ab', tealSoft='#13272a', edge='#7ea6f6', edgeFill='#0f1622',
               disk='#05070b', glow='#ffffff', shadow='rgba(0,0,0,.4)'),
}

FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Segoe UI','Microsoft YaHei',sans-serif"

def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def text(x, y, s, size, fill, weight=400, anchor='middle', extra=''):
    return f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" {extra}>{esc(s)}</text>'

def multiline(x, y, s, size, fill, lh=1.35, anchor='middle', weight=400):
    out = []
    for i, line in enumerate(s.split('\n')):
        out.append(text(x, y + i * size * lh, line, size, fill, weight, anchor))
    return ''.join(out)

def logo(cx, cy, r, c):
    # 与 logo/nova-mark.js 同一几何：暗盘 + 偏移光盘 + 左上亮点
    k = r / 54
    off = 10.5 * k
    lx, ly = cx + off * .5, cy - off * .5
    dx, dy = cx - off * .5, cy + off * .5
    base = math.atan2(66 - (108 - 10.5), 58 - (92 + 10.5)) - 0.04
    px, py = lx + r * math.cos(base), ly + r * math.sin(base)
    return (f'<circle cx="{lx}" cy="{ly}" r="{r + 6*k}" fill="#dfe8f6" opacity=".55" filter="url(#glow)"/>'
            f'<circle cx="{lx}" cy="{ly}" r="{r}" fill="url(#lightdisk)"/>'
            f'<circle cx="{dx}" cy="{dy}" r="{r}" fill="{c["disk"]}"/>'
            f'<circle cx="{px}" cy="{py}" r="{6*k}" fill="#fff" filter="url(#soft)"/>'
            f'<circle cx="{px}" cy="{py}" r="{2.4*k}" fill="#fff"/>')

def icon(name, cx, cy, col):
    g = f'<g transform="translate({cx - 12},{cy - 12})" fill="none" stroke="{col}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    if name == 'Mac':
        g += '<rect x="3" y="4" width="18" height="12" rx="1.8"/><path d="M1 19.5 H23"/>'
    elif name == 'Windows':
        g += '<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>'
    elif name == 'Linux':
        g += '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M6 10 L9 12.5 L6 15 M11 15.5 H17"/>'
    elif name == 'iPhone':
        g += '<rect x="6.5" y="1.5" width="11" height="21" rx="2.8"/><path d="M10.5 4.2 H13.5"/>'
    else:
        g += '<rect x="6.5" y="1.5" width="11" height="21" rx="2.2"/><circle cx="12" cy="19.2" r=".7"/>'
    return g + '</g>'

def build(lang, theme):
    t, c = T[lang], THEME[theme]
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}" role="img" aria-label="{esc(t["title"])}: {esc(t["sub"])}">']
    o.append(f'''<defs>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
<filter id="soft" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="3"/></filter>
<filter id="card" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="{c['shadow']}"/></filter>
<radialGradient id="tile" cx=".5" cy="0" r="1.2"><stop offset="0" stop-color="#1f2733"/><stop offset=".7" stop-color="#0b0f16"/></radialGradient>
<linearGradient id="lightdisk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c9d6ea"/></linearGradient>
<marker id="arr" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L8 5 L1 9" fill="none" stroke="{c['blue']}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arrT" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L8 5 L1 9" fill="none" stroke="{c['teal']}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
</defs>''')
    o.append(f'<rect width="{W}" height="{H}" fill="{c["bg"]}"/>')
    # 标题
    o.append(text(64, 78, t['title'], 34, c['ink'], 700, 'start', 'letter-spacing="-0.5"'))
    o.append(text(64, 114, t['sub'], 19, c['sub'], 400, 'start'))

    # 端侧边界
    bx, by, bw, bh = 64, 150, 1110, 830
    o.append(f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="36" fill="{c["edgeFill"]}" stroke="{c["edge"]}" stroke-opacity=".55" stroke-width="1.6" stroke-dasharray="2 7" stroke-linecap="round"/>')
    # 锁 + 标签
    lx0, ly0 = bx + 34, by + 38
    o.append(f'<g transform="translate({lx0},{ly0 - 15})" stroke="{c["edge"]}" fill="none" stroke-width="1.8" stroke-linecap="round"><rect x="0" y="8" width="16" height="12" rx="3"/><path d="M3.5 8 V5 a4.5 4.5 0 0 1 9 0 V8"/></g>')
    o.append(text(lx0 + 26, ly0, t['edge'], 18, c['edge'], 600, 'start'))
    o.append(text(lx0 + 26, ly0 + 24, t['edge_sub'], 15, c['sub'], 400, 'start'))

    # 闭环圆
    o.append(f'<circle cx="{CX}" cy="{CY}" r="{R}" fill="none" stroke="{c["line"]}" stroke-width="2"/>')
    # 四段顺时针箭头弧
    for i in range(4):
        a0 = math.radians(-90 + i * 90 + 17)
        a1 = math.radians(-90 + (i + 1) * 90 - 17)
        x0, y0 = CX + R * math.cos(a0), CY + R * math.sin(a0)
        x1, y1 = CX + R * math.cos(a1), CY + R * math.sin(a1)
        o.append(f'<path d="M{x0:.1f} {y0:.1f} A{R} {R} 0 0 1 {x1:.1f} {y1:.1f}" fill="none" stroke="{c["blue"]}" stroke-width="2.4" stroke-linecap="round" marker-end="url(#arr)" opacity=".85"/>')
    # 中心 logo
    ts = 150
    o.append(f'<rect x="{CX-ts/2}" y="{CY-ts/2-14}" width="{ts}" height="{ts}" rx="{ts*.23}" fill="url(#tile)" filter="url(#card)"/>')
    o.append(logo(CX - 2, CY - 12, 44, c))
    o.append(text(CX, CY + 92, 'Nova', 24, c['ink'], 700))

    # 节点：上 右 下 左
    pos = [(CX, CY - R), (CX + R, CY), (CX, CY + R), (CX - R, CY)]
    for i, ((zh, en, chips), (x, y)) in enumerate(zip(t['nodes'], pos)):
        hi = i == 2
        nw, nh = (300, 150) if hi else (230, 132)
        nx, ny = x - nw / 2, y - nh / 2
        fill = c['blueSoft'] if hi else c['card']
        stroke = c['blue'] if hi else c['line']
        o.append(f'<rect x="{nx}" y="{ny}" width="{nw}" height="{nh}" rx="20" fill="{fill}" stroke="{stroke}" stroke-width="{1.8 if hi else 1.2}" filter="url(#card)"/>')
        title = zh + (f'  {en}' if en else '')
        o.append(f'<text x="{x}" y="{ny + 38}" text-anchor="middle" font-size="25" font-weight="700" fill="{c["blue"] if hi else c["ink"]}">{esc(zh)}'
                 + (f'<tspan font-size="14" font-weight="500" fill="{c["faint"]}" dx="8">{esc(en)}</tspan>' if en else '') + '</text>')
        for j, chip in enumerate(chips):
            o.append(text(x, ny + 72 + j * 24, chip, 16, c['sub'] if not hi else c['ink'], 500 if hi and j < 2 else 400))
        if hi:
            # 前后脑双轨小图示
            pass

    # 主动：记忆 → 交互 的内侧短弧
    a0, a1 = math.radians(30), math.radians(62)
    rr = R - 62
    x0, y0 = CX + rr * math.cos(a0), CY + rr * math.sin(a0)
    x1, y1 = CX + rr * math.cos(a1), CY + rr * math.sin(a1)
    o.append(f'<path d="M{x0:.1f} {y0:.1f} A{rr} {rr} 0 0 1 {x1:.1f} {y1:.1f}" fill="none" stroke="{c["teal"]}" stroke-width="2" stroke-dasharray="1 6" stroke-linecap="round" marker-end="url(#arrT)"/>')
    o.append(text(CX + R - 10, CY + 150, t['proactive'], 15, c['teal'], 600, 'start'))
    # 回流说明：执行 → 上下文
    o.append(text(CX - R - 30, CY - 120, t['update'], 15, c['faint'], 400, 'end'))

    # 设备行
    dy0 = 840
    n = len(t['devices'])
    dw, gap = 180, 20
    total = n * dw + (n - 1) * gap
    sx = bx + (bw - total) / 2
    o.append(f'<line x1="{sx + dw/2}" y1="{dy0 - 26}" x2="{sx + total - dw/2}" y2="{dy0 - 26}" stroke="{c["blue"]}" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="3 5"/>')
    pw = 172 if lang == 'zh-CN' else 226
    o.append(f'<rect x="{bx + bw/2 - pw/2}" y="{dy0 - 40}" width="{pw}" height="28" rx="14" fill="{c["bg"]}" stroke="{c["blue"]}" stroke-opacity=".5"/>')
    o.append(text(bx + bw / 2, dy0 - 21, '🔒 ' + t['e2ee'], 14, c['blue'], 600))
    for i, (name, role) in enumerate(t['devices']):
        x = sx + i * (dw + gap)
        host = i == 0
        o.append(f'<rect x="{x}" y="{dy0}" width="{dw}" height="100" rx="16" fill="{c["card"]}" stroke="{c["blue"] if host else c["line"]}" stroke-width="{1.6 if host else 1.1}" filter="url(#card)"/>')
        o.append(icon(name, x + dw / 2, dy0 + 26, c['ink']))
        o.append(text(x + dw / 2, dy0 + 66, name, 18, c['ink'], 700))
        o.append(text(x + dw / 2, dy0 + 88, role, 13, c['sub']))
        o.append(f'<line x1="{x + dw/2}" y1="{dy0 - 12}" x2="{x + dw/2}" y2="{dy0}" stroke="{c["blue"]}" stroke-opacity=".35" stroke-width="1.5"/>')
    # 本地推理栈：挂在 Mac 上
    mx = sx
    lbx, lby = sx, dy0 - 150
    o.append(f'<rect x="{lbx}" y="{lby}" width="{dw+24}" height="80" rx="16" fill="{c["tealSoft"]}" stroke="{c["teal"]}" stroke-opacity=".6"/>')
    o.append(text(lbx + (dw+24)/2, lby + 33, t['local'], 17, c['teal'], 700))
    o.append(text(lbx + (dw+24)/2, lby + 58, t['local_sub'], 12.5, c['sub']))
    o.append(f'<line x1="{sx+28}" y1="{lby+80}" x2="{sx+28}" y2="{dy0}" stroke="{c["teal"]}" stroke-width="1.6"/>')

    # 边界外：Relay、云模型
    ox = 1256
    for k, (name, subt, yy, dashed) in enumerate([(t['relay'], t['relay_sub'], 700, False), (t['cloud'], t['cloud_sub'], 330, True)]):
        o.append(f'<rect x="{ox}" y="{yy}" width="276" height="150" rx="22" fill="{c["card"]}" stroke="{c["line"]}" stroke-width="1.2" {"stroke-dasharray=\"5 6\"" if dashed else ""}/>')
        o.append(text(ox + 138, yy + 50, name, 21, c['ink'], 700))
        o.append(multiline(ox + 138, yy + 84, subt, 14.5, c['sub']))
    # 连接线
    o.append(f'<path d="M{bx+bw} 775 H{ox}" stroke="{c["blue"]}" stroke-opacity=".5" stroke-width="1.6" stroke-dasharray="4 5" marker-end="url(#arr)" marker-start="url(#arr)"/>')
    o.append(text((bx + bw + ox) / 2, 762, '密文' if lang == 'zh-CN' else 'ciphertext', 13, c['blue'], 600))
    o.append(f'<path d="M{bx+bw} 405 H{ox}" stroke="{c["faint"]}" stroke-opacity=".7" stroke-width="1.4" stroke-dasharray="4 5" marker-end="url(#arr)"/>')
    o.append(text((bx + bw + ox) / 2, 392, '可选' if lang == 'zh-CN' else 'optional', 13, c['faint'], 600))
    o.append('</svg>')
    return '\n'.join(o)

if __name__ == '__main__':
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    out.mkdir(parents=True, exist_ok=True)
    for lang in T:
        for th in THEME:
            (out / f'nova-overview.{lang}.{th}.svg').write_text(build(lang, th), encoding='utf-8')
    print('ok')
