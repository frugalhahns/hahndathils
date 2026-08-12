/**
 * Sparkles. Purely decorative, and deliberately self-contained so deleting the
 * import in app.js removes the whole feature.
 *
 * Rules it follows:
 *   - nothing renders if the device asks for reduced motion
 *   - the layer never receives pointer events, so it cannot eat a tap
 *   - particles are capped, and the loop stops when none are alive
 *   - the cursor trail only runs for a real mouse, not a fingertip
 */

const COLORS = ["#5fb8a6", "#e0a15e", "#6aa9e0", "#f2f6fa"];
const STAR = "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";
const MAX_ALIVE = 140;

let layer = null;
let alive = 0;

function ensureLayer() {
  if (layer) return layer;
  layer = document.createElement("div");
  layer.className = "sparkle-layer";
  document.body.append(layer);
  return layer;
}

function spawn(x, y, { size = 10, spread = 46, life = 900 } = {}) {
  if (alive >= MAX_ALIVE) return;
  alive++;

  const s = document.createElement("i");
  s.className = "sparkle";
  s.style.left = `${x}px`;
  s.style.top = `${y}px`;
  s.style.width = s.style.height = `${size}px`;
  s.style.background = COLORS[(Math.random() * COLORS.length) | 0];
  ensureLayer().append(s);

  // Fling outward on a random vector, drifting down a little as it fades.
  const angle = Math.random() * Math.PI * 2;
  const dist = spread * (0.4 + Math.random() * 0.9);
  const dx = Math.cos(angle) * dist;
  const dy = Math.sin(angle) * dist + spread * 0.5;

  /* Pops to full size early, then holds bright for most of its life before
     fading at the very end. Scaling and fading evenly across the duration
     reads as much shorter than it is, because it starts vanishing at once. */
  const anim = s.animate(
    [
      { transform: "translate(-50%, -50%) scale(0) rotate(0deg)", opacity: 1, offset: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.35}px), calc(-50% + ${dy * 0.2}px)) scale(1.1) rotate(60deg)`, opacity: 1, offset: 0.12 },
      { transform: `translate(calc(-50% + ${dx * 0.8}px), calc(-50% + ${dy * 0.7}px)) scale(1) rotate(150deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + spread * 0.35}px)) scale(.25) rotate(260deg)`, opacity: 0, offset: 1 },
    ],
    { duration: life * (0.8 + Math.random() * 0.5), easing: "cubic-bezier(.15,.7,.3,1)" }
  );

  anim.onfinish = () => { s.remove(); alive--; };
  anim.oncancel = anim.onfinish;
}

function burst(x, y, count, opts) {
  for (let i = 0; i < count; i++) spawn(x, y, opts);
}

export function initSparkles() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  /* A fingertip covers the point it just tapped, so touch gets a wider, larger,
     longer burst than a mouse click. Otherwise most of it happens under the
     finger and is gone by the time the finger lifts. */
  const tapOpts = (ev) => (ev.pointerType === "touch"
    ? { size: 13, spread: 85, life: 2000 }
    : { size: 9, spread: 46, life: 1100 });

  document.addEventListener("pointerdown", (ev) => {
    const o = tapOpts(ev);
    burst(ev.clientX, ev.clientY, ev.pointerType === "touch" ? 10 : 7, o);
  }, { passive: true });

  // A bigger one for the title, which is the obvious thing a kid will poke.
  const title = document.querySelector(".hero h1");
  if (title) {
    title.style.cursor = "pointer";
    title.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      const touch = ev.pointerType === "touch";
      burst(ev.clientX, ev.clientY, 30, {
        size: touch ? 16 : 13,
        spread: touch ? 175 : 140,
        life: touch ? 2600 : 1700,
      });
    });
  }

  // Cursor trail, mouse only. A finger has no hover, and doing this on touch
  // would just double up on the tap burst.
  if (!window.matchMedia("(pointer: fine)").matches) return;

  let lastAt = 0;
  document.addEventListener("pointermove", (ev) => {
    if (ev.pointerType !== "mouse") return;
    const now = performance.now();
    if (now - lastAt < 45) return;   // throttle, or it is a solid ribbon
    lastAt = now;
    spawn(ev.clientX, ev.clientY, { size: 7, spread: 16, life: 620 });
  }, { passive: true });
}
