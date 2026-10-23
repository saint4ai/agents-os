// Масштаб карты: Ctrl/⌘ + колесо (и щипок на трекпаде), кнопки −/+, «Уместить».
// Карта лежит в .zoom-sizer: он занимает место масштабированной карты, поэтому скролл стейджа остаётся честным.
// fluid=true (карта проекта): при уменьшении ширина холста растёт, в ряд помещается больше карточек.
// fluid=false (дерево): ширина фиксирована, масштаб просто уменьшает всё дерево.

const MIN = 0.35;
const MAX = 1.6;
const PAD = 16; // боковой отступ стейджа вокруг холста

export function attachZoom(stage, canvas, opts) {
  const o = opts || {};
  const sizer = canvas.parentElement;
  let s = clamp(o.scale || 1);
  const listeners = [];

  function layout() {
    if (o.fluid) canvas.style.width = Math.max(300, Math.floor((stage.clientWidth - 2 * PAD) / s)) + 'px';
    canvas.classList.toggle('narrow', canvas.offsetWidth < 720);
    sizer.style.width = Math.ceil(canvas.offsetWidth * s) + 'px';
    sizer.style.height = Math.ceil(canvas.offsetHeight * s) + 'px';
    canvas.style.transform = s === 1 ? '' : `scale(${s})`;
    if (o.onChange) o.onChange(s);
  }

  function zoomTo(next, cx, cy) {
    next = clamp(next);
    if (next === s) return;
    const r = stage.getBoundingClientRect();
    const ax = cx == null ? r.width / 2 : cx - r.left;
    const ay = cy == null ? r.height / 2 : cy - r.top;
    const ox = sizer.offsetLeft; // холст стоит не в углу стейджа: над ним шапка страницы
    const oy = sizer.offsetTop;
    const px = (stage.scrollLeft + ax - ox) / s;
    const py = (stage.scrollTop + ay - oy) / s;
    s = next;
    layout();
    stage.scrollLeft = px * s + ox - ax;
    stage.scrollTop = py * s + oy - ay;
  }

  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // обычное колесо - прокрутка
    e.preventDefault();
    zoomTo(s * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.002), e.clientX, e.clientY); // шаг колеса ≈ 18%, щипок мельче
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  listeners.push(() => stage.removeEventListener('wheel', onWheel));

  layout();
  return {
    get scale() { return s; },
    in: () => zoomTo(s * 1.2),
    out: () => zoomTo(s / 1.2),
    reset: () => zoomTo(1),
    // по ширине: дерево сжимается до ширины окна, карта проекта возвращается к 100%
    fit() {
      if (o.fluid) return zoomTo(1);
      const natural = canvas.offsetWidth;
      zoomTo(Math.min(1, (stage.clientWidth - 2 * PAD) / natural));
    },
    relayout: layout,
    destroy: () => listeners.forEach((f) => f()),
  };
}

function clamp(v) {
  return Math.min(MAX, Math.max(MIN, v));
}
