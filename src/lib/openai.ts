import { postJson } from './http.js';
import type { Settings } from './settings.js';
import type { AnalysisInput, AnalysisResult, CharacteristicDef } from './characteristics.js';
import type { Assignment, MatchFile, MatchTrack } from './trackmatch.js';

/**
 * OpenAI as an arbiter, never a dependency.
 *
 * The rules engine in trackmatch.ts decides everything it can; only the files
 * it scored LOW reach the model, with the whole tracklist for context. No key,
 * a dead key, a timeout, or garbage output all degrade to the rules' own
 * answer — matching must keep working the day the key expires.
 *
 * gpt-4o-mini by default: this is a constrained matching task with the answer
 * space handed to the model, not open-ended reasoning, and the cheap model at
 * a few thousand tokens per album costs fractions of a cent.
 */

// Overridable for a compatible proxy or a test stub; the default is the real thing.
const API = process.env.CRATE_OPENAI_URL ?? 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
/**
 * Curation runs on a stronger model than arbitration, deliberately. Matching filenames to a
 * tracklist is mechanical and the cheap model is fine; building "soft, tender and romantic"
 * takes judgement about tone, and the cheap model matched a request like that by SUBJECT —
 * it put Afroman's Crazy Rap on a slow-jams playlist because both are, technically, about
 * the same thing. A playlist build is rare and user-initiated; the dearer call is worth it.
 */
const CURATOR_MODEL = 'gpt-4.1';
/**
 * Characteristic analysis sits between the two: the answer space is closed (a fixed taxonomy,
 * like arbitration) but the judgement is about feel (like curation). gpt-4.1-mini is the
 * deliberate middle — enough taste to tell a brooding song from an angry one, cheap enough to
 * run over a whole library, which is the scale this feature has to survive.
 *
 * Changing this does NOT invalidate stored profiles: staleness is keyed on CLASSIFIER_VERSION
 * in lib/characteristics.ts, precisely so the model can be swapped for whatever is cheapest next
 * quarter without re-billing a library's worth of work.
 */
const CHARACTERISTIC_MODEL = 'gpt-4.1-mini';

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

export class OpenAi {
  constructor(
    private settings: Settings,
    private warn: (msg: string) => void = () => {},
  ) {}

  enabled(): boolean {
    return Boolean(this.settings.all().openaiKey);
  }

  /**
   * Second opinions for the doubtful assignments.
   *
   * Returns a name→position map for ONLY the files it was asked about, with
   * positions restricted to what the tracklist actually offers. Anything the
   * model says about files it was not asked about, or positions that do not
   * exist, is discarded — the model advises, the caller decides.
   */
  async arbitrateTracks(
    doubtful: MatchFile[],
    tracks: MatchTrack[],
    taken: Set<number>,
  ): Promise<Map<string, number | null>> {
    const key = this.settings.all().openaiKey;
    const out = new Map<string, number | null>();
    if (!key || !doubtful.length) return out;

    const prompt = {
      files: doubtful.map((f) => ({
        name: f.name,
        tagTitle: f.tagTitle ?? null,
        seconds: f.durationS ?? null,
      })),
      tracklist: tracks.map((t) => ({
        position: t.position,
        title: t.title,
        seconds: t.lengthMs ? Math.round(t.lengthMs / 1000) : null,
        alreadyAssigned: taken.has(t.position),
      })),
    };

    try {
      const res = await postJson<ChatResponse>(
        API,
        {
          model: MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You match audio file names to an official album tracklist. ' +
                'Filenames carry noise: track numbers, artist prefixes, feat credits, ' +
                'remaster and rip-group tags. Prefer positions not alreadyAssigned. ' +
                'A file that matches no track maps to null. Reply with JSON only: ' +
                '{"matches":[{"name":"<file name exactly as given>","position":<number or null>}]}',
            },
            { role: 'user', content: JSON.stringify(prompt) },
          ],
        },
        { headers: { Authorization: `Bearer ${key}` }, timeoutMs: 25_000 },
      );

      const text = res.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(text) as { matches?: { name?: string; position?: number | null }[] };
      const valid = new Set(tracks.map((t) => t.position));
      const asked = new Set(doubtful.map((f) => f.name));
      for (const m of parsed.matches ?? []) {
        if (!m.name || !asked.has(m.name)) continue;
        const pos = m.position === null ? null : Number(m.position);
        out.set(m.name, pos !== null && valid.has(pos) ? pos : null);
      }
    } catch (err) {
      this.warn(`openai arbitration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }

  /**
   * A playlist from a prompt, chosen from ONLY the caller's own catalog.
   *
   * The catalog rides in as one line per track — "id<TAB>artist — title (album, year) [genres]"
   * — because a few thousand terse lines is well inside the model's window and a track the
   * model cannot see is a track it cannot pick. The reply is ids plus a name, nothing else:
   * the caller re-validates every id against the library, so a hallucinated id is dropped
   * rather than trusted (the model advises, the caller decides — same rule as arbitration).
   *
   * Null means "no usable answer" — bad JSON, timeout, empty pick list — and the route turns
   * that into an honest error instead of an empty playlist appearing by magic.
   */
  async buildPlaylist(
    prompt: string,
    catalog: string[],
  ): Promise<{ name: string; description: string; trackIds: number[] } | null> {
    const key = this.settings.all().openaiKey;
    if (!key) return null;

    try {
      const res = await postJson<ChatResponse>(
        API,
        {
          model: CURATOR_MODEL,
          // Warmer than arbitration's 0: curation is taste, not matching, and a stone-cold
          // model answers every prompt with the same forty obvious picks.
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a music curator. You will receive a listener\'s request and their ' +
                'complete music library, one track per line in the form: ' +
                'id<TAB>artist — title (album, year) [genres]. ' +
                'Build the playlist they asked for using ONLY tracks from that library. ' +
                'Match the FEEL of the request — mood, tone, energy, era — not merely its ' +
                'subject: a comedic, raunchy or aggressive song about the requested theme is ' +
                'a wrong pick for a tender or romantic request, however on-topic its lyrics. ' +
                'When you are unsure of a track\'s tone, judge by what you know of the song ' +
                'and its artist; leave it out rather than gamble the mood. ' +
                'Hard constraints in the request are exact: a named number of songs means ' +
                'exactly that many, "don\'t repeat artists" means every artist appears once, ' +
                'a requested name is used verbatim. ' +
                'Order the ids as the playlist should play, honouring any arc the request ' +
                'describes (e.g. "starting soft" builds from there). Prefer variety across ' +
                'artists even when not asked. If no length is named, pick 15 to 30 tracks, ' +
                'fewer if the library offers little that truly fits. Reply with JSON only: ' +
                '{"name":"<short playlist name>","description":"<one sentence on the idea>",' +
                '"trackIds":[<ids in play order>]}',
            },
            { role: 'user', content: `Request: ${prompt}\n\nLibrary:\n${catalog.join('\n')}` },
          ],
        },
        // A whole library goes up; give the model room the 25s arbitration budget doesn't.
        { headers: { Authorization: `Bearer ${key}` }, timeoutMs: 90_000 },
      );

      const text = res.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(text) as {
        name?: unknown;
        description?: unknown;
        trackIds?: unknown;
      };
      const trackIds = Array.isArray(parsed.trackIds)
        ? parsed.trackIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      if (!trackIds.length) return null;
      return {
        name: String(parsed.name ?? '').trim(),
        description: String(parsed.description ?? '').trim(),
        trackIds,
      };
    } catch (err) {
      this.warn(`openai playlist build failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * The full characteristic profile for a BATCH of tracks.
   *
   * WHAT THE PROMPT HAS TO ACHIEVE, and why each instruction earns its tokens:
   *
   *  - EVERY DIMENSION, EVERY TRACK. This is the difference from the mood system it replaced.
   *    A model left to volunteer what it finds interesting produces a sparse, uncomparable
   *    answer; the vector is only useful if every track is scored on the same axes. The prompt
   *    demands completeness and the server enforces it (MIN_COMPLETENESS in songcharacteristics).
   *  - ZERO IS AN ANSWER. Models avoid extremes and drift toward 0.5 on anything they are unsure
   *    of. Saying explicitly that 0 and 1 are real, usable scores is what stops fifty-five
   *    dimensions all landing between 0.4 and 0.7 and every track looking identical — which
   *    would make the similarity engine useless while appearing to work.
   *  - GENRE INFORMS, IT DOES NOT DETERMINE. Left alone a model scores the genre stereotype:
   *    every metal track aggressive 0.9, every folk track acoustic 0.9. The anchors and the
   *    explicit warning push back on that.
   *  - JUDGE EACH TRACK ALONE. Only needed because of batching: handed ten songs at once a model
   *    grades on a curve, and the scores stop being absolute.
   *  - THE ANCHORS. Each definition's 0/0.5/1 text is what keeps near-synonyms apart — rawness
   *    from abrasiveness, romance from sensuality, acousticness from organicness. Without them
   *    every dimension collapses into "how much vibe".
   *
   * THROWS on transport trouble — timeouts, 429s, a dead key — rather than swallowing it, because
   * the caller has to tell "the provider is rate-limiting us" from "the model answered badly".
   * Null is reserved for a reply that arrived and was useless.
   */
  async classifyCharacteristics(
    inputs: AnalysisInput[],
    taxonomy: CharacteristicDef[],
  ): Promise<AnalysisResult | null> {
    const key = this.settings.all().openaiKey;
    if (!key || !inputs.length) return null;

    const active = taxonomy.filter((c) => c.enabled);
    // The anchors, one line each. This is the bulk of the prompt and the reason batching exists.
    const spec = active
      .map((c) => `${c.key}: ${c.definition}`)
      .join('\n');
    const conditional = active.filter((c) => c.conditional).map((c) => c.key);

    /*
     * One terse line per track. Only what crate actually holds — an absent field is left out
     * rather than sent as "unknown", so the model is never invited to fill a blank in.
     */
    const lines = inputs.map((t) => {
      const bits = [`${t.trackId}\t${t.artistName} — ${t.title}`];
      const context: string[] = [];
      if (t.albumTitle) context.push(t.albumTitle);
      if (t.albumArtist) context.push(`album artist ${t.albumArtist}`);
      if (t.year) context.push(String(t.year));
      if (context.length) bits.push(` (${context.join(', ')})`);
      if (t.genres.length) bits.push(` [${t.genres.join(', ')}]`);
      if (t.durationS) bits.push(` ${Math.floor(t.durationS / 60)}m${t.durationS % 60}s`);
      if (t.bpm) bits.push(` ${Math.round(t.bpm)}bpm`);
      // Described rather than handed over bare: a raw 0.61 invites the model to echo it straight
      // back as the `energy` score, which would make the dimension circular. See lib/analysis.ts.
      if (t.energy != null) {
        bits.push(` measured-rhythmic-density ${Math.round(t.energy * 100)}/100`);
      }
      return bits.join('');
    });

    const res = await postJson<ChatResponse>(
      API,
      {
        model: CHARACTERISTIC_MODEL,
        // Low but not zero. This is judgement, and a stone-cold model collapses onto the same
        // safe middle for everything; wide open, the same track scores differently on Tuesday.
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You analyse the musical, emotional and sonic characteristics of songs. You will ' +
              'be given tracks one per line as: id<TAB>artist — title (album, year) [genres] and ' +
              'optionally a duration, a bpm and a measured rhythmic density from local audio ' +
              'analysis.\n\n' +
              'For EACH track, score EVERY characteristic below from 0 to 1. This is a complete ' +
              'profile, not a selection of highlights: a characteristic that does not apply ' +
              'strongly still gets a low score rather than being omitted.\n\n' +
              'USE THE FULL RANGE. 0 and 1 are real, usable scores, and so is everything ' +
              'between — 0.07, 0.34, 0.88. Do not cluster around 0.5, and do not round ' +
              'everything to tenths. If a track has no danceable quality whatsoever, that is ' +
              'danceability 0.0, not 0.3. Scores are INDEPENDENT of each other and are not ' +
              'shares of any total.\n\n' +
              'GENRE INFORMS BUT DOES NOT DETERMINE. Do not score the stereotype of the genre. ' +
              'Two songs in the same genre routinely differ sharply in energy, darkness, ' +
              'sensuality, groove, atmosphere and aggression, and songs from unrelated genres ' +
              'often have near-identical profiles. Judge this recording.\n\n' +
              'JUDGE EACH TRACK ON ITS OWN. Tracks in one request are unrelated for your ' +
              'purposes even when they share an album. Do not compare them to each other or ' +
              'grade on a curve; a track must get the same scores whatever it was sent ' +
              'alongside.\n\n' +
              'Read each definition carefully and keep similar-sounding characteristics ' +
              'distinct — they measure different things.\n\n' +
              `CHARACTERISTICS (key: 0 / 0.5 / 1 anchors)\n${spec}\n\n` +
              `For a fully instrumental track set vocal_presence to 0 and return null for ` +
              `${conditional.join(', ')} — those describe a voice that is not there. Never use ` +
              'null for any other characteristic.\n\n' +
              'Use ONLY the keys listed above, return every track you were given exactly once, ' +
              'and use the ids exactly as supplied. Reply with JSON only: ' +
              '{"tracks":[{"id":<track id>,"scores":{"<key>":<0-1 or null>, ...}}]}',
          },
          { role: 'user', content: `Analyse the following tracks:\n${lines.join('\n')}` },
        ],
      },
      /*
       * Measured: five tracks × fifty-five scores lands near 46 seconds. Ninety gives that real
       * headroom while still giving up on a hung connection in a useful timeframe — the old
       * 120s was tuned for batches of ten, which took 90–120s and spent the whole budget failing.
       */
      { headers: { Authorization: `Bearer ${key}` }, timeoutMs: 90_000 },
    );

    const text = res.choices?.[0]?.message?.content ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Arrived and was not JSON: the model's fault, not the network's, so null (do not retry)
      // rather than a throw (retry).
      this.warn(`openai characteristic analysis returned non-JSON for ${inputs.length} track(s)`);
      return null;
    }
    const rows = (parsed as { tracks?: unknown }).tracks;
    if (!Array.isArray(rows)) return null;

    /*
     * Keyed by id, and only ids we asked about. A model that echoes a track we did not send — or
     * sends one twice — must not be able to write a profile onto an arbitrary row. The scores
     * themselves are handed on UNVALIDATED on purpose: validateScores in lib/characteristics.ts
     * is the single gate, so there is one place to read to know what can reach the database.
     */
    const asked = new Set(inputs.map((t) => t.trackId));
    const seen = new Set<number>();
    const tracks: AnalysisResult['tracks'] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as { id?: unknown; trackId?: unknown; scores?: unknown };
      const trackId = Number(r.id ?? r.trackId);
      if (!Number.isInteger(trackId) || !asked.has(trackId) || seen.has(trackId)) continue;
      seen.add(trackId);
      const scores =
        r.scores && typeof r.scores === 'object' && !Array.isArray(r.scores)
          ? (r.scores as Record<string, number | null>)
          : {};
      tracks.push({ trackId, scores });
    }
    return { tracks, model: CHARACTERISTIC_MODEL };
  }

  /** The cheapest call that proves a key: list one model. */
  async testKey(): Promise<{ ok: boolean; detail: string }> {
    const key = this.settings.all().openaiKey;
    if (!key) return { ok: false, detail: 'no key set' };
    try {
      await postJson<ChatResponse>(
        API,
        { model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
        { headers: { Authorization: `Bearer ${key}` }, timeoutMs: 10_000 },
      );
      return { ok: true, detail: `key accepted (${MODEL})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401/.test(msg)) return { ok: false, detail: 'OpenAI rejected the key' };
      if (/429/.test(msg)) return { ok: true, detail: 'key accepted, but the account is rate-limited or out of credit' };
      return { ok: false, detail: msg.slice(0, 160) };
    }
  }
}
