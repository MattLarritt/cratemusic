import { useEffect, useRef, useState } from 'react';
import { usePlayer } from './player.js';
import { readBands } from './analyser.js';

/**
 * The room responds to the music.
 *
 * A handful of dim, out-of-focus orbs behind the page: bass swells them, the
 * midrange stirs them, and a pause lets them settle and fade. Deliberately
 * ambience rather than a spectrum display — it should be felt on the edge of
 * attention, never read.
 *
 * Cost is held down three ways. The canvas renders at a third of the viewport
 * and lets CSS blur scale it up, which is where the out-of-focus look comes
 * from anyway — a ninth of the pixels for a softer result. The loop runs only
 * while there is something to show, stopping entirely once a pause has faded
 * out rather than idling at 60fps drawing nothing. And the orbs are radial
 * gradients, not shadow-blurred shapes; canvas shadowBlur is notoriously the
 * slow path.
 */

/** Matched to the theme's glow: accent blue, its violet counterweight, warmth. */
const HUES = [222, 268, 200, 330, 24, 258, 190];
const ORBS = HUES.length;

interface Orb {
  hue: number;
  /** Anchor point in unit space; the orb breathes around it. */
  ax: number;
  ay: number;
  /** Phase offsets so no two orbs move in step. */
  p1: number;
  p2: number;
  /** Base radius as a fraction of the viewport diagonal. */
  r: number;
}

function makeOrbs(): Orb[] {
  return HUES.map((hue, i) => ({
    hue,
    // Deterministic golden-angle spread instead of Math.random(): every load
    // looks composed the same way, and nothing clusters.
    ax: 0.12 + ((i * 0.618) % 1) * 0.76,
    ay: 0.1 + ((i * 0.382 + 0.21) % 1) * 0.7,
    p1: i * 1.7,
    p2: i * 2.9 + 1.3,
    r: 0.09 + (i % 3) * 0.03,
  }));
}

export function Orbs() {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const p = usePlayer();
  const playing = p.playing;

  // Motion is decoration; someone who asked the interface to hold still gets
  // no canvas at all, not a slower one.
  const [still, setStill] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setStill(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (still) return;
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext('2d');
    if (!g) return;

    const orbs = makeOrbs();
    let raf = 0;
    let presence = 0;
    let running = false;
    // Smoothed copies of the band energies, with fast attack and slow release
    // so a kick drum lands as a swell rather than a strobe.
    let sBass = 0;
    let sMid = 0;
    let sLevel = 0;

    const size = () => {
      el.width = Math.max(2, Math.round(window.innerWidth / 3));
      el.height = Math.max(2, Math.round(window.innerHeight / 3));
    };
    size();
    window.addEventListener('resize', size);

    const isDark = () => {
      const forced = document.documentElement.getAttribute('data-theme');
      if (forced) return forced === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    };

    const frame = (now: number) => {
      const t = now / 1000;

      // The tap does not exist until the first play has wired it; until then
      // the orbs drift gently on nothing, which still reads as alive.
      const bands = readBands();
      const bass = bands?.bass ?? 0.25;
      const mid = bands?.mid ?? 0.2;
      const level = bands?.level ?? 0.2;

      const k = (target: number, cur: number) =>
        cur + (target - cur) * (target > cur ? 0.25 : 0.06);
      sBass = k(bass, sBass);
      sMid = k(mid, sMid);
      sLevel = k(level, sLevel);

      presence += ((playingRef.current ? 1 : 0) - presence) * 0.04;

      const w = el.width;
      const h = el.height;
      const diag = Math.hypot(w, h);
      g.clearRect(0, 0, w, h);

      if (presence > 0.005) {
        const dark = isDark();
        // 'lighter' makes overlapping glows bloom like light does; on a white
        // page the same trick bleaches to nothing, so light mode blends
        // normally at lower strength and stays a tint rather than a lamp.
        g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        const strength = (dark ? 0.16 : 0.08) * presence;

        for (const o of orbs) {
          // Slow Lissajous drift around the anchor; the midrange sets the
          // tempo of the wander, bass sets how far it strays.
          const speed = 0.05 + sMid * 0.12;
          const wander = 0.05 + sBass * 0.05;
          const x = (o.ax + Math.sin(t * speed + o.p1) * wander) * w;
          const y = (o.ay + Math.cos(t * speed * 0.8 + o.p2) * wander) * h;
          const r = Math.max(8, (o.r + sBass * 0.075 + sLevel * 0.02) * diag);

          const grad = g.createRadialGradient(x, y, 0, x, y, r);
          const a = strength * (0.75 + 0.25 * Math.sin(t * 0.9 + o.p2));
          grad.addColorStop(0, `hsla(${o.hue}, 85%, ${dark ? 62 : 55}%, ${a})`);
          grad.addColorStop(1, `hsla(${o.hue}, 85%, ${dark ? 62 : 55}%, 0)`);
          g.fillStyle = grad;
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
        }
        raf = requestAnimationFrame(frame);
      } else {
        // Faded out: stop the loop dead. An invisible animation is just a
        // warm phone.
        running = false;
      }
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    if (playingRef.current) start();

    // The loop stops itself when a pause fades out, so restarts come from
    // here. Polling a ref rather than depending on `playing` keeps this
    // effect alive across play/pause — re-running it would reset `presence`
    // and make every pause a hard cut instead of a settle.
    const iv = window.setInterval(() => {
      if (playingRef.current && !running) start();
    }, 250);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(iv);
      window.removeEventListener('resize', size);
    };
  }, [still]);

  if (still) return null;
  return <canvas ref={canvas} className="orbs" aria-hidden="true" />;
}
