// Spoken coaching cues through the device speaker or connected earbuds (Web Speech API).

export class VoiceCoach {
  constructor() {
    this.enabled = true;
    this.lastKey = null;
    this.lastAt = 0;
    this.voice = null;
    this.supported = 'speechSynthesis' in window;
    if (this.supported) {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.voice =
          voices.find((v) => v.lang === 'en-AU') ||
          voices.find((v) => v.lang?.startsWith('en-')) ||
          voices[0] || null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  /** iOS and Chrome need speech to start from a user gesture once. */
  unlock() {
    if (!this.supported) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  say(text, key = text, { force = false } = {}) {
    if (!this.supported || !this.enabled) return;
    const now = performance.now();
    // Don't repeat the same cue on back-to-back shots unless 8s have passed.
    if (!force && key === this.lastKey && now - this.lastAt < 8000) return;
    this.lastKey = key;
    this.lastAt = now;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    u.pitch = 1;
    speechSynthesis.speak(u);
  }
}
