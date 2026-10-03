// Half-court shot chart (FIBA dimensions, 1 unit = 1 cm, rim centre at the origin).

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

export function courtPosition(shot) {
  const a = (shot.angle * Math.PI) / 180;
  return { x: Math.cos(a) * shot.distanceM * 100, y: Math.sin(a) * shot.distanceM * 100 };
}

export function drawCourt(svg, shots, onPick) {
  svg.replaceChildren();
  const line = { fill: 'none', stroke: '#9aa6b8', 'stroke-width': 5 };
  svg.append(
    el('rect', { x: -750, y: -157.5, width: 1500, height: 1060, rx: 16, fill: '#eff1ff' }),
    el('rect', { x: -245, y: -157.5, width: 490, height: 580, fill: 'rgba(67,127,236,.08)', ...line }),
    el('circle', { cx: 0, cy: 422.5, r: 180, ...line }),
    el('path', { d: 'M -125 0 A 125 125 0 0 0 125 0', ...line }),
    el('path', { d: 'M -660 -157.5 L -660 141.5 A 675 675 0 0 0 660 141.5 L 660 -157.5', ...line, stroke: '#124e91', 'stroke-width': 6 }),
    el('line', { x1: -90, y1: -37.5, x2: 90, y2: -37.5, stroke: '#131f31', 'stroke-width': 8 }),
    el('circle', { cx: 0, cy: 0, r: 22.5, fill: 'none', stroke: '#da7f27', 'stroke-width': 6 }),
  );
  shots.forEach((s, i) => {
    const p = courtPosition(s);
    const r = 14 + (s.score / 100) * 18;
    const g = el('g', { tabindex: 0, role: 'button', 'aria-label': `Shot ${i + 1}: ${s.made ? 'make' : 'miss'}, score ${s.score}`, style: 'cursor:pointer' });
    if (s.made) {
      g.append(el('circle', { cx: p.x, cy: p.y, r, fill: '#4cd9ed', stroke: '#124e91', 'stroke-width': 3, opacity: 0.92 }));
    } else {
      const d = r * 0.65;
      g.append(
        el('circle', { cx: p.x, cy: p.y, r, fill: 'rgba(255,69,107,.12)', stroke: '#ff456b', 'stroke-width': 4 }),
        el('path', { d: `M ${p.x - d} ${p.y - d} L ${p.x + d} ${p.y + d} M ${p.x + d} ${p.y - d} L ${p.x - d} ${p.y + d}`, stroke: '#ff456b', 'stroke-width': 5, 'stroke-linecap': 'round' }),
      );
    }
    const t = el('title'); t.textContent = `${s.zone} · ${s.distanceM.toFixed(1)} m · ${s.made ? 'Make' : 'Miss'} · Q${s.score}`;
    g.append(t);
    g.addEventListener('click', () => onPick?.(s));
    svg.append(g);
  });
}
