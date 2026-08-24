/**
 * A tap on the player's audio, for the visualizer.
 *
 * Web Audio's rules make the wiring order load-bearing, so it all lives here:
 *
 * - createMediaElementSource can be called ONCE per element, ever. A second
 *   call throws, and there is no way to undo the first — which is fine,
 *   because the player creates its one element once and never replaces it.
 *
 * - The moment a source exists, ALL of the element's audio routes through the
 *   AudioContext. If that context is suspended, the music is silent — so the
 *   source is only created after the context is confirmed RUNNING. Getting
 *   this backwards is the classic iOS failure: the page looks fine and no
 *   sound ever comes out.
 *
 * - Browsers refuse to start an AudioContext outside a user gesture, which is
 *   why wiring happens on the element's own 'play' event rather than at
 *   module load. A click on the play button is the gesture.
 *
 * Only the library player is tapped. Previews come from Apple's CDN — a
 * cross-origin element yields silent zeros through an analyser, so wiring it
 * would cost complexity to visualize nothing.
 */

let el: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let wired = false;

function wire(): void {
  if (wired || !el) return;
  ctx ??= new AudioContext();
  if (ctx.state !== 'running') {
    // Resume needs the gesture we are currently inside; wiring waits for a
    // later play if it does not stick. Nothing is routed yet, so a failure
    // here costs nothing — the music plays on, untapped.
    void ctx.resume();
    if ((ctx.state as string) !== 'running') return;
  }
  try {
    const src = ctx.createMediaElementSource(el);
    analyser = ctx.createAnalyser();
    // 256 gives 128 bins — bands, not a spectrogram. Smoothing here means the
    // consumer reads calm numbers instead of re-implementing decay.
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    // The source MUST reach the destination in the same breath, or the tap
    // becomes a mute button.
    analyser.connect(ctx.destination);
    wired = true;
  } catch {
    // Most likely a second createMediaElementSource after a hot reload in
    // dev. The element is already routed by the previous module instance, so
    // leave it alone rather than break audio for a background effect.
    analyser = null;
  }
}

/** Called once by the player, the moment it creates its element. */
export function registerAudioElement(audio: HTMLAudioElement): void {
  el = audio;
  audio.addEventListener('play', () => {
    wire();
    // A context can lapse back to suspended (backgrounded phone); the next
    // press of play is a gesture, so it is the moment to recover.
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  });
}

export interface Bands {
  /** 0..1 each, already smoothed by the analyser. */
  bass: number;
  mid: number;
  high: number;
  level: number;
}

const buf = new Uint8Array(128);

/**
 * Current energy by band, or null before the tap exists.
 *
 * Normalised against a slowly-decaying running peak rather than 255, because
 * the absolute numbers depend on the element volume and how hot the master is
 * — a quiet acoustic record at half volume should still fill the room.
 */
let peak = 0.12;

export function readBands(): Bands | null {
  if (!analyser) return null;
  analyser.getByteFrequencyData(buf);

  // Bin edges by ear, not by maths: at 44.1kHz/256, each bin is ~172Hz. Bass
  // is the first handful, presence lives in the low-mid stack, and everything
  // from bin 40 up is air and cymbals.
  const avg = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += buf[i] ?? 0;
    return s / ((b - a) * 255);
  };
  const bass = avg(1, 7);
  const mid = avg(7, 40);
  const high = avg(40, 110);
  const raw = bass * 0.5 + mid * 0.35 + high * 0.15;

  peak = Math.max(peak * 0.998, raw, 0.05);
  const g = 1 / peak;
  return {
    bass: Math.min(1, bass * g),
    mid: Math.min(1, mid * g),
    high: Math.min(1, high * g),
    level: Math.min(1, raw * g),
  };
}
