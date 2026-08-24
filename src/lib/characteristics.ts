/**
 * Song characteristics: one multidimensional description of how a track sounds, feels and
 * behaves, independent of genre.
 *
 * WHAT REPLACED WHAT. This supersedes the short-lived Song moods feature, which modelled a
 * track as a handful of weighted mood tags. That shape had a fatal limitation for everything it
 * was supposed to feed: it was SPARSE and it was one-sided. A track either had "melancholic
 * 0.9" or it had nothing, and "nothing" could mean either "definitely not melancholic" or
 * "never considered". You cannot compute a distance between two tracks on that. A characteristic
 * vector can be compared with arithmetic; a bag of tags cannot.
 *
 * So the model is now: every analysed track gets a score for every applicable characteristic,
 * and A SCORE OF ZERO IS MEANINGFUL. "danceability 0.0" is a statement about the track, not an
 * absence of data. Absence of data is a missing row, and the similarity engine treats the two
 * completely differently (see similarity.ts).
 *
 * WHY THE TAXONOMY LIVES HERE. Every characteristic has a stable key, a display name, a group,
 * a description for people, a definition for the classifier, and a similarity weight. All of it
 * in one table so that adding, retiring, renaming or reweighting a characteristic is an edit to
 * this file plus a boot-time sync — never a schema change, never a hunt through the codebase for
 * hard-coded strings. Nothing outside this module may invent a characteristic key.
 *
 * WHY DEFINITIONS MATTER. The `definition` text is what anchors the classifier's 0, 0.5 and 1.
 * Without anchors a model treats every dimension as "how much vibe does this have" and
 * everything correlates. With them, `rawness` and `abrasiveness` — which sound alike — stay
 * distinguishable, because one is about polish and the other is about texture.
 */

/** Which part of the picture a characteristic describes. Used for grouping in the UI. */
export type CharacteristicGroup =
  | 'energy'
  | 'emotion'
  | 'tone'
  | 'rhythm'
  | 'composition'
  | 'production'
  | 'vocal';

export const GROUP_LABEL: Record<CharacteristicGroup, string> = {
  energy: 'Energy & movement',
  emotion: 'Emotion',
  tone: 'Tone & sound',
  rhythm: 'Rhythm',
  composition: 'Composition',
  production: 'Production',
  vocal: 'Vocals',
};

export interface CharacteristicDef {
  /** Stable key. The only identifier anything may store, index or match on. */
  key: string;
  name: string;
  group: CharacteristicGroup;
  /** One line, for a person reading the UI. */
  description: string;
  /**
   * The 0 / 0.5 / 1 anchors, handed verbatim to the classifier. Terse on purpose — this text
   * is sent on every request, and fifty-five verbose definitions would dominate the prompt.
   */
  definition: string;
  /**
   * How much this dimension counts toward perceptual similarity, relative to the others.
   *
   * Deliberately NOT uniform, and deliberately not baked into the distance function. Two tracks
   * that agree on energy, darkness and groove feel alike even if their harmonic richness
   * differs; the reverse is not true. These are starting values to be tuned against real
   * listening, which is exactly why they live in the taxonomy and get synced into a database
   * column rather than sitting in the maths.
   */
  similarityWeight: number;
  /**
   * False for a characteristic that has been retired: kept so old scores still render and can
   * still be read, but no longer requested from the classifier.
   */
  enabled: boolean;
  /**
   * True when this dimension is meaningless for some tracks and must be left UNSCORED rather
   * than scored zero. Only the vocal dimensions, and only for instrumentals — see the note on
   * VOCAL APPLICABILITY below.
   */
  conditional?: boolean;
}

/**
 * The classifier's behaviour version. Bump when the taxonomy, the anchors or the prompt change
 * in a way that alters what a score MEANS. Deliberately not the model name: swapping the model
 * for a cheaper one must not invalidate a library, whereas redefining `heaviness` must.
 */
export const CLASSIFIER_VERSION = 'song-characteristics-v1';

/** Weight tiers, named so the table below reads as intent rather than as magic numbers. */
const HIGH = 1;
const MED = 0.6;
const LOW = 0.35;

const def = (
  key: string,
  name: string,
  group: CharacteristicGroup,
  similarityWeight: number,
  description: string,
  definition: string,
  conditional = false,
): CharacteristicDef => ({
  key,
  name,
  group,
  description,
  definition,
  similarityWeight,
  enabled: true,
  conditional,
});

/**
 * The taxonomy. Order is the display order within each group.
 *
 * The high-weight dimensions are the ones a listener notices first when a song changes: how
 * hard it hits, how fast it feels, how dark it is, whether it moves. The low-weight ones are
 * real but discriminating rather than defining — two tracks are not "different songs" because
 * one is more harmonically rich.
 */
export const CHARACTERISTICS: CharacteristicDef[] = [
  // ---- Energy and movement -------------------------------------------------
  def('energy', 'Energy', 'energy', HIGH, 'Overall perceived musical energy.',
    '0 extremely subdued, passive or minimal; 0.5 moderate; 1 explosive and highly energetic'),
  def('intensity', 'Intensity', 'energy', HIGH, 'How forcefully the song demands attention.',
    '0 extremely gentle; 0.5 moderately forceful; 1 overwhelming'),
  def('danceability', 'Danceability', 'energy', HIGH, 'How naturally it invites movement.',
    '0 little or no danceable rhythmic quality; 0.5 moderately danceable; 1 exceptionally danceable'),
  def('groove', 'Groove', 'energy', HIGH, 'Strength of the rhythmic pocket.',
    '0 rigid or lacking groove; 0.5 noticeable groove; 1 groove is the defining feature'),
  def('momentum', 'Momentum', 'energy', HIGH, 'Perceived forward propulsion.',
    '0 static or drifting; 0.5 moderate forward movement; 1 strongly driving and propulsive'),
  def('aggression', 'Aggression', 'energy', HIGH, 'Confrontational, forceful character.',
    '0 completely soft and non-aggressive; 0.5 moderately aggressive; 1 extremely aggressive'),
  def('punch', 'Punch', 'energy', MED, 'Physical impact and transient force.',
    '0 soft and smooth; 0.5 moderately punchy; 1 extremely hard-hitting'),
  def('tempo_feel', 'Tempo feel', 'energy', HIGH, 'Perceived speed, not literal BPM.',
    '0 feels extremely slow; 0.5 moderate pace; 1 feels extremely fast. Judge FEEL, not BPM — a ' +
      'fast-BPM track with long held notes can feel slow'),

  // ---- Emotional -----------------------------------------------------------
  def('happiness', 'Happiness', 'emotion', MED, 'Sombre through to joyful.',
    '0 strongly unhappy or sombre; 0.5 emotionally neutral; 1 strongly joyful'),
  def('melancholy', 'Melancholy', 'emotion', MED, 'Sadness with beauty in it.',
    '0 no melancholic quality; 0.5 noticeably melancholic; 1 deeply melancholic'),
  def('euphoria', 'Euphoria', 'emotion', MED, 'Ecstatic lift.',
    '0 restrained; 0.5 moderately uplifting; 1 overwhelming ecstatic quality'),
  def('hopefulness', 'Hopefulness', 'emotion', 0.5, 'Bleak through to optimistic.',
    '0 bleak or hopeless; 0.5 moderately hopeful; 1 strongly optimistic'),
  def('longing', 'Longing', 'emotion', 0.5, 'Yearning for something absent.',
    '0 no sense of yearning; 0.5 noticeable longing; 1 intense yearning'),
  def('nostalgia', 'Nostalgia', 'emotion', LOW, 'Memory-soaked quality.',
    '0 immediate and present; 0.5 somewhat nostalgic; 1 deeply memory-soaked'),
  def('introspection', 'Introspection', 'emotion', MED, 'Inward-looking rather than outward.',
    '0 outward-facing and social; 0.5 somewhat reflective; 1 deeply inward-looking'),
  def('romance', 'Romance', 'emotion', 0.5, 'Romantic character.',
    '0 non-romantic; 0.5 romantic undertones; 1 strongly romantic'),
  def('sensuality', 'Sensuality', 'emotion', MED, 'Physical intimacy and seduction.',
    '0 non-sensual; 0.5 moderately intimate; 1 strongly seductive. Distinct from romance: a ' +
      'track can be sensual without being romantic and vice versa'),
  def('tenderness', 'Tenderness', 'emotion', 0.5, 'Gentleness and vulnerability.',
    '0 emotionally hard or detached; 0.5 moderately tender; 1 deeply gentle and vulnerable'),
  def('confidence', 'Confidence', 'emotion', 0.5, 'Swagger and self-assurance.',
    '0 uncertain or vulnerable; 0.5 moderately assured; 1 highly confident and swaggering'),
  def('defiance', 'Defiance', 'emotion', LOW, 'Rebellion against something.',
    '0 compliant; 0.5 rebellious undertones; 1 strongly defiant'),
  def('playfulness', 'Playfulness', 'emotion', 0.5, 'Cheek and whimsy.',
    '0 completely serious; 0.5 somewhat playful; 1 highly playful and whimsical'),
  def('emotional_weight', 'Emotional weight', 'emotion', MED, 'How much the song asks of you.',
    '0 emotionally lightweight; 0.5 moderately substantial; 1 emotionally overwhelming. This is ' +
      'about MAGNITUDE, not direction — overwhelming joy scores as high as overwhelming grief'),

  // ---- Tone and sonic ------------------------------------------------------
  def('darkness', 'Darkness', 'tone', HIGH, 'Bright through to ominous.',
    '0 extremely bright; 0.5 neutral; 1 extremely dark and ominous'),
  def('warmth', 'Warmth', 'tone', MED, 'Cold and sterile through to warm and organic.',
    '0 cold and sterile; 0.5 neutral; 1 deeply warm and organic'),
  def('dreaminess', 'Dreaminess', 'tone', MED, 'Ethereal, floating quality.',
    '0 grounded and direct; 0.5 somewhat dreamy; 1 highly ethereal and dreamlike'),
  def('atmosphere', 'Atmosphere', 'tone', HIGH, 'How much of a place the track builds.',
    '0 dry, direct and immediate; 0.5 moderately atmospheric; 1 deeply immersive'),
  def('spaciousness', 'Spaciousness', 'tone', MED, 'Intimate through to expansive.',
    '0 tight and intimate; 0.5 moderate sense of space; 1 extremely expansive'),
  def('rawness', 'Rawness', 'tone', 0.5, 'Unpolished, human, first-take quality.',
    '0 highly controlled and refined; 0.5 moderately raw; 1 extremely raw and unpolished. ' +
      'About PERFORMANCE and capture, not distortion'),
  def('abrasiveness', 'Abrasiveness', 'tone', MED, 'Sonically harsh on the ear.',
    '0 extremely smooth; 0.5 moderately abrasive; 1 highly abrasive. About TEXTURE — harshness ' +
      'you feel in the ear — not about aggression of intent'),
  def('heaviness', 'Heaviness', 'tone', HIGH, 'Sonic weight and crush.',
    '0 extremely light; 0.5 moderately heavy; 1 crushing'),
  def('lushness', 'Lushness', 'tone', 0.5, 'Richness and fullness of the sound.',
    '0 sparse and plain; 0.5 moderately rich; 1 extremely lush and full'),
  def('dirtiness', 'Dirtiness', 'tone', 0.5, 'Grit and grime in the sound.',
    '0 extremely clean; 0.5 moderately gritty; 1 heavily dirty'),
  def('hypnotic', 'Hypnotic', 'tone', MED, 'Trance-inducing repetition.',
    '0 constantly changing; 0.5 moderately entrancing; 1 deeply hypnotic'),

  // ---- Rhythm --------------------------------------------------------------
  def('rhythmic_strength', 'Rhythmic strength', 'rhythm', MED, 'How firmly rhythm drives it.',
    '0 rhythmically loose or weak; 0.5 clear rhythmic presence; 1 rhythm dominates'),
  def('syncopation', 'Syncopation', 'rhythm', LOW, 'Off-beat emphasis.',
    '0 very straight; 0.5 moderate syncopation; 1 strongly syncopated'),
  def('rhythmic_complexity', 'Rhythmic complexity', 'rhythm', LOW, 'Intricacy of the rhythm.',
    '0 extremely simple; 0.5 moderate; 1 highly complex'),
  def('beat_prominence', 'Beat prominence', 'rhythm', MED, 'How present the beat is.',
    '0 beat barely perceptible; 0.5 clear beat; 1 beat dominates'),
  def('repetitiveness', 'Repetitiveness', 'rhythm', 0.5, 'Loop-orientation.',
    '0 constantly evolving; 0.5 moderately repetitive; 1 heavily loop-oriented'),
  def('bass_prominence', 'Bass prominence', 'rhythm', MED, 'How much the low end defines it.',
    '0 bass has little perceptual role; 0.5 noticeable; 1 bass is a defining element'),

  // ---- Composition and arrangement ----------------------------------------
  def('complexity', 'Complexity', 'composition', LOW, 'Structural and musical intricacy.',
    '0 very simple; 0.5 moderate; 1 highly complex composition or arrangement'),
  def('density', 'Density', 'composition', MED, 'How much is happening at once.',
    '0 extremely sparse; 0.5 moderately layered; 1 extremely dense'),
  def('variation', 'Variation', 'composition', LOW, 'How much it changes as it goes.',
    '0 highly static; 0.5 moderate evolution; 1 constantly changing'),
  def('melodic_prominence', 'Melodic prominence', 'composition', 0.5, 'Melody versus texture.',
    '0 texture or rhythm led; 0.5 melody shares focus; 1 melody dominates'),
  def('harmonic_richness', 'Harmonic richness', 'composition', LOW, 'Depth of the harmony.',
    '0 harmonically very simple; 0.5 moderately rich; 1 highly rich and complex'),
  def('tension', 'Tension', 'composition', MED, 'Unresolved musical pressure.',
    '0 highly resolved and comfortable; 0.5 moderate tension; 1 deeply tense and unresolved'),
  def('cinematic', 'Cinematic', 'composition', LOW, 'Scale and scene-setting.',
    '0 intimate; 0.5 somewhat cinematic; 1 epic and strongly cinematic'),

  // ---- Production ----------------------------------------------------------
  def('acousticness', 'Acousticness', 'production', MED, 'Acoustic versus synthetic sources.',
    '0 fully synthetic or electronic; 0.5 mixed; 1 strongly acoustic'),
  def('organicness', 'Organicness', 'production', 0.5, 'Human versus mechanical feel.',
    '0 highly synthetic or mechanical; 0.5 mixed; 1 highly organic and human. About PERFORMANCE ' +
      'feel — a sampled band is acoustic-sounding but may be mechanical'),
  def('polish', 'Polish', 'production', LOW, 'Production finish.',
    '0 rough or lo-fi; 0.5 moderately polished; 1 pristine'),
  def('distortion', 'Distortion', 'production', MED, 'Deliberate signal breakup.',
    '0 clean; 0.5 noticeably distorted; 1 heavily distorted'),
  def('electronic_character', 'Electronic character', 'production', MED, 'Electronic identity.',
    '0 primarily traditional or acoustic; 0.5 mixed; 1 strongly electronic'),

  // ---- Vocal ---------------------------------------------------------------
  def('vocal_presence', 'Vocal presence', 'vocal', MED, 'How much the voice carries the track.',
    '0 fully instrumental; 0.5 vocals share focus; 1 vocals dominate'),
  def('vocal_intensity', 'Vocal intensity', 'vocal', 0.5, 'Restraint versus force in the voice.',
    '0 extremely restrained; 0.5 moderate; 1 extremely forceful', true),
  def('vocal_intimacy', 'Vocal intimacy', 'vocal', LOW, 'Distance of the voice from the listener.',
    '0 distant and impersonal; 0.5 moderately intimate; 1 extremely close', true),
  def('vocal_expressiveness', 'Vocal expressiveness', 'vocal', LOW, 'Emotional range in the delivery.',
    '0 neutral or flat; 0.5 moderately expressive; 1 highly expressive', true),
];

export const CHARACTERISTIC_BY_KEY = new Map(CHARACTERISTICS.map((c) => [c.key, c]));

/** The keys the classifier is currently asked for. */
export const activeKeys = (): string[] => CHARACTERISTICS.filter((c) => c.enabled).map((c) => c.key);

/**
 * VOCAL APPLICABILITY.
 *
 * On an instrumental, "vocal intensity" has no answer. Scoring it 0 would be a lie the
 * similarity engine then acts on: an instrumental and a whispered ballad would look identical
 * on three of the four vocal dimensions, because "no voice at all" and "a very quiet voice"
 * would both be zero.
 *
 * So: `vocal_presence` is always scored — 0 genuinely means "fully instrumental", which is a
 * real statement — and the other three are CONDITIONAL. The classifier returns null for them on
 * an instrumental, no row is stored, and similarity drops those dimensions from both the
 * numerator and the denominator for that pair. Missing data and a score of zero are different
 * things everywhere in this feature, and this is the case that proves why.
 */
export const CONDITIONAL_KEYS = new Set(
  CHARACTERISTICS.filter((c) => c.conditional).map((c) => c.key),
);

/** Where a score came from. Manual is a person's judgement and outranks the model's. */
export type CharacteristicSource = 'ai' | 'manual' | 'imported';

/** Lifecycle of a track's analysis. No run row at all is "not analysed". */
export type AnalysisState = 'pending' | 'analysing' | 'analysed' | 'failed';

/** One scored dimension, as stored and as the API returns it. */
export interface TrackCharacteristic {
  key: string;
  name: string;
  group: CharacteristicGroup;
  score: number;
  source: CharacteristicSource;
}

/** A track's full profile as a plain key→score map: the shape the maths works on. */
export type CharacteristicVector = Map<string, number>;

/** What the classifier is asked to judge. Only fields crate actually holds — never invented. */
export interface AnalysisInput {
  trackId: number;
  title: string;
  artistName: string;
  albumArtist: string | null;
  albumTitle: string;
  genres: string[];
  year: number | null;
  albumMbid: string | null;
  /** Local analyzer's 0..1 rhythmic-density/brightness blend, when it has run. */
  energy: number | null;
  /** Only ever from the file's own TBPM tag, never estimated. See lib/analysis.ts. */
  bpm: number | null;
  durationS: number | null;
  /** True when crate already holds lyrics for this track; the classifier is told, not sent them. */
  hasLyrics: boolean;
}

/** What a classifier returns for a batch. Scores may be null for conditional dimensions. */
export interface AnalysisResult {
  tracks: { trackId: number; scores: Record<string, number | null> }[];
  model: string;
}

export interface ValidationOutcome {
  /** Only keys in the taxonomy, only finite scores in 0..1, conditional nulls dropped. */
  scores: Map<string, number>;
  rejected: string[];
  /** Enabled, non-conditional keys the model failed to provide. */
  missing: string[];
}

/**
 * The single gate. Nothing reaches the database except through this.
 *
 * Unlike the mood system it replaces, this checks for COMPLETENESS as well as validity: a
 * characteristic vector with half its dimensions absent is not a usable profile, and silently
 * storing one would poison every similarity computation that later touched it. The caller
 * decides what to do about `missing`; this function's job is to make it visible.
 */
export function validateScores(raw: unknown): ValidationOutcome {
  const rejected: string[] = [];
  const scores = new Map<string, number>();

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { scores, rejected: ['scores were not an object'], missing: activeKeys() };
  }

  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(rawKey).trim().toLowerCase();
    const def = CHARACTERISTIC_BY_KEY.get(key);
    if (!def) {
      rejected.push(`unknown characteristic "${rawKey.slice(0, 40)}"`);
      continue;
    }
    if (!def.enabled) {
      // Retired: the model should not have been offered it, and its answer is not stored.
      rejected.push(`retired characteristic "${key}"`);
      continue;
    }
    if (rawValue === null || rawValue === undefined) {
      // Legitimate ONLY for a conditional dimension — that is how an instrumental says "no
      // vocals to judge". Anywhere else it is a gap, and `missing` will report it.
      if (!def.conditional) rejected.push(`null score for "${key}"`);
      continue;
    }
    const score = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(score)) {
      rejected.push(`malformed score for "${key}"`);
      continue;
    }
    if (score < 0 || score > 1) {
      rejected.push(`score out of range for "${key}" (${score})`);
      continue;
    }
    // Three decimals: finer than any model's real resolution, coarse enough to compare exactly.
    scores.set(key, Math.round(score * 1000) / 1000);
  }

  const missing = CHARACTERISTICS.filter(
    (c) => c.enabled && !c.conditional && !scores.has(c.key),
  ).map((c) => c.key);

  return { scores, rejected, missing };
}

/**
 * MERGE: how a hand-set score and the model's coexist.
 *
 * A person's judgement wins for that dimension. Reanalysis rewrites only source='ai' rows, so
 * curation survives it; this decides what a reader sees when both exist.
 */
export function mergeScores(rows: TrackCharacteristic[]): TrackCharacteristic[] {
  const byKey = new Map<string, TrackCharacteristic>();
  for (const r of rows) {
    const existing = byKey.get(r.key);
    if (!existing || rank(r.source) > rank(existing.source)) byKey.set(r.key, r);
  }
  // Taxonomy order, so a profile always reads the same way.
  const order = new Map(CHARACTERISTICS.map((c, i) => [c.key, i]));
  return [...byKey.values()].sort(
    (a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999),
  );
}

const rank = (s: CharacteristicSource): number => (s === 'manual' ? 3 : s === 'imported' ? 2 : 1);
