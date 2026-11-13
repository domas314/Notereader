// Playback engine: a small Web Audio synthesizer driven by a look-ahead
// scheduler so notes stay locked to the beat even when the screen is busy.
// Positions are measured in quarter notes ("q") so tempo can change freely.

const LOOKAHEAD_S = 0.25;
const TICK_MS = 30;

const SOUNDS = {
  // [waveform, level] partials (1 = fundamental), envelope, tone filter
  choir: { partials: [['sine', 1, 1], ['triangle', 1, 0.5], ['sine', 2, 0.16], ['sine', 3, 0.05]], attack: 0.045, decay: 0.2, sustain: 0.8, release: 0.12, cutoff: 2200, vibrato: 4.5 },
  piano: { partials: [['triangle', 1, 1], ['sine', 2, 0.35], ['sine', 3, 0.12], ['sine', 4, 0.05]], attack: 0.006, decay: 1.6, sustain: 0.12, release: 0.18, cutoff: 3800, vibrato: 0 },
  organ: { partials: [['sine', 1, 1], ['sine', 2, 0.5], ['sine', 4, 0.22], ['sine', 0.5, 0.3]], attack: 0.02, decay: 0.05, sustain: 0.95, release: 0.07, cutoff: 3000, vibrato: 0 },
};

export class Player {
  constructor() {
    this.ctx = null;
    this.model = null;
    this.bpm = 84;
    this.metronome = false;
    this.countIn = true;
    this.sound = 'choir';
    this.playing = false;
    this.posQ = 0; // where playback starts / is paused
    this.voiceSettings = []; // [{vol, oct}]
    this.onStop = () => {};
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      // iOS: play through the silent switch, like a music app.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* optional */ }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
    return this.ctx;
  }

  load(model, voiceSettings) {
    this.pause();
    this.model = model;
    this.voiceSettings = voiceSettings;
    this.posQ = Math.min(this.posQ, model.endQ);
    this.voiceGains = null;
  }

  secPerQ() {
    return 60 / this.bpm;
  }

  /** Current position in quarter notes (may be before the start during a count-in). */
  currentQ() {
    if (!this.playing) return this.posQ;
    return this.anchorQ + (this.ctx.currentTime - this.anchorT) / this.secPerQ();
  }

  timeOfQ(q) {
    return this.anchorT + (q - this.anchorQ) * this.secPerQ();
  }

  setTempo(bpm) {
    bpm = Math.max(30, Math.min(220, Math.round(bpm)));
    if (this.playing) {
      const q = this.currentQ();
      this.anchorQ = q;
      this.anchorT = this.ctx.currentTime;
    }
    this.bpm = bpm;
  }

  setVoice(index, settings) {
    Object.assign(this.voiceSettings[index], settings);
    const gain = this.voiceGains?.[index];
    if (gain) gain.gain.setTargetAtTime(this.voiceSettings[index].vol, this.ctx.currentTime, 0.03);
  }

  play() {
    if (this.playing || !this.model) return;
    const ctx = this.ensureContext();
    if (this.posQ >= this.model.endQ - 1e-6) this.posQ = 0;

    // Everything from one run goes through `session`, so pausing can silence it at once.
    this.session = ctx.createGain();
    this.session.connect(this.master);
    this.voiceGains = this.voiceSettings.map((s) => {
      const g = ctx.createGain();
      g.gain.value = s.vol;
      g.connect(this.session);
      return g;
    });

    const startQ = this.posQ;
    const { beatQ, beatsPerMeasure, measures, endQ, events: notes } = this.model;
    const lead = this.countIn ? beatsPerMeasure * beatQ : 0;
    this.startQ = startQ;
    this.anchorQ = startQ - lead;
    this.anchorT = ctx.currentTime + 0.12;

    // Click track: count-in beats, then (optionally) every beat of every bar.
    const clicks = [];
    for (let k = 0; k < (this.countIn ? beatsPerMeasure : 0); k++) {
      clicks.push({ q: startQ - lead + k * beatQ, accent: k === 0, always: true });
    }
    const bars = measures.length ? measures.map((m) => m.q) : [0];
    bars.forEach((q, i) => {
      const next = i + 1 < bars.length ? bars[i + 1] : endQ;
      for (let b = q, k = 0; b < next - 1e-6; b += beatQ, k++) {
        if (b >= startQ - 1e-6) clicks.push({ q: b, accent: k === 0 });
      }
    });
    this.clicks = clicks;
    this.clickIndex = 0;
    this.noteIndex = notes.findIndex((n) => n.q0 >= startQ - 1e-6);
    if (this.noteIndex < 0) this.noteIndex = notes.length;

    this.playing = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const horizonQ = this.anchorQ + (now + LOOKAHEAD_S - this.anchorT) / this.secPerQ();
    const { events: notes, endQ } = this.model;

    while (this.noteIndex < notes.length && notes[this.noteIndex].q0 < horizonQ) {
      const ev = notes[this.noteIndex++];
      const t = Math.max(this.timeOfQ(ev.q0), now);
      const dur = (ev.q1 - ev.q0) * this.secPerQ();
      for (const v of ev.note.voices) {
        const s = this.voiceSettings[v.index];
        if (s.vol > 0) this.playNote(ev.note.pitch + 12 * s.oct, t, dur, this.voiceGains[v.index]);
      }
    }
    while (this.clickIndex < this.clicks.length && this.clicks[this.clickIndex].q < horizonQ) {
      const c = this.clicks[this.clickIndex++];
      if (c.always || this.metronome) this.playClick(Math.max(this.timeOfQ(c.q), now), c.accent);
    }
    if (this.currentQ() >= endQ + 0.25) {
      this.pause();
      this.posQ = 0;
      this.onStop(true);
    }
  }

  pause() {
    if (!this.playing) return;
    this.posQ = Math.max(0, Math.min(this.currentQ(), this.model.endQ));
    if (this.posQ < this.startQ) this.posQ = this.startQ; // stopped during the count-in
    this.playing = false;
    clearInterval(this.timer);
    const session = this.session;
    const t = this.ctx.currentTime;
    session.gain.setTargetAtTime(0, t, 0.015);
    setTimeout(() => session.disconnect(), 200);
    this.onStop(false);
  }

  /** Jump to a position; keeps playing (without a new count-in) if already playing. */
  seek(q) {
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.playing = false;
      clearInterval(this.timer);
      const session = this.session;
      session.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
      setTimeout(() => session.disconnect(), 200);
    }
    this.posQ = Math.max(0, Math.min(q, this.model ? this.model.endQ : 0));
    if (wasPlaying) {
      const countIn = this.countIn;
      this.countIn = false;
      this.play();
      this.countIn = countIn;
    }
  }

  /** Sound a single pitch right now (used when tapping or fixing a note). */
  preview(pitch) {
    const ctx = this.ensureContext();
    this.playNote(pitch, ctx.currentTime + 0.01, 0.5, this.master);
  }

  playNote(midi, t, dur, dest) {
    const ctx = this.ctx;
    const def = SOUNDS[this.sound] || SOUNDS.choir;
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(def.cutoff + freq * 2, 9000);
    filter.Q.value = 0.4;

    // Keep low and high voices about equally loud to the ear.
    const peak = 0.3 * Math.min(1.6, Math.max(0.55, (220 / freq) ** 0.35));
    const hold = Math.max(dur - 0.02, 0.04);
    const end = t + hold;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + Math.min(def.attack, hold / 2));
    env.gain.setTargetAtTime(peak * def.sustain, t + def.attack, def.decay / 3);
    env.gain.cancelScheduledValues(end);
    env.gain.setTargetAtTime(0, end, def.release / 3);
    const stop = end + def.release * 2;

    let lfo;
    if (def.vibrato && dur > 0.5) {
      lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = def.vibrato;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(freq * 0.004, t + 0.5);
      lfo.connect(depth);
      lfo.depth = depth;
      lfo.start(t);
      lfo.stop(stop);
    }
    for (const [type, ratio, level] of def.partials) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * ratio;
      if (lfo) lfo.depth.connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(filter);
      osc.start(t);
      osc.stop(stop);
    }
    filter.connect(env).connect(dest);
  }

  playClick(t, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g).connect(this.session || this.master);
    osc.start(t);
    osc.stop(t + 0.06);
  }
}
