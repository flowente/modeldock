import { useEffect, useMemo, useState, type CSSProperties } from "react";

/** What every chat model can do in ModelDock. */
const BASE_WORDS = ["scrivere", "riassumere", "tradurre", "spiegare", "correggere", "programmare", "riscrivere"];

/**
 * Words for capabilities Ollama reports. Only what ModelDock's chat actually uses: "tools" and
 * "vision" stay out until the chat can hand the model tools or images.
 */
const CAPABILITY_WORDS: Record<string, string> = {
  thinking: "ragionare"
};

/** One look per letter, picked at random each time a word appears. */
const LOOKS = ["hatch", "outline", "stripes", "offset", "dots", "double"] as const;
const WORD_MS = 1400;

export function capabilityWords(capabilities: string[]): string[] {
  const special = capabilities.flatMap((capability) => (CAPABILITY_WORDS[capability] ? [CAPABILITY_WORDS[capability]] : []));
  // A special word comes back often: it is what sets this model apart.
  return special.length === 0 ? BASE_WORDS : BASE_WORDS.flatMap((word, index) => (index % 2 === 0 ? [special[(index / 2) % special.length]!, word] : [word]));
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** One letter in the accent colour, two in a long word: an accent, not a palette. */
function pickAccents(length: number): Set<number> {
  const count = length >= 9 ? 2 : 1;
  const picked = new Set<number>();
  while (picked.size < Math.min(count, length)) picked.add(Math.floor(Math.random() * length));
  return picked;
}

/**
 * Hand-drawn words that follow each other quickly, in ink with a touch of the accent: every
 * letter gets its own fill and tilt, and the whole word "boils" like a sketchbook drawing.
 * Decorative: screen readers get the list once, quietly.
 */
export function SketchWords({ words }: { words: string[] }) {
  const [index, setIndex] = useState(0);
  const calm = useMemo(prefersReducedMotion, []);

  useEffect(() => {
    setIndex(0);
    if (words.length < 2) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % words.length), calm ? WORD_MS * 2 : WORD_MS);
    return () => window.clearInterval(timer);
  }, [words, calm]);

  const word = words[index] ?? "";
  const longest = words.reduce((best, candidate) => (candidate.length > best.length ? candidate : best), "");
  const letters = useMemo(() => {
    const chars = [...word];
    const accents = pickAccents(chars.length);
    return chars.map((char, position) => ({
      char,
      look: LOOKS[Math.floor(Math.random() * LOOKS.length)]!,
      accent: accents.has(position),
      tilt: Math.round((Math.random() - 0.5) * 14),
      lift: Math.round((Math.random() - 0.5) * 5)
    }));
    // A new set of looks each time the word changes, even when it comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word, index]);

  return (
    <span className="md-sketch-slot">
      <span className="md-sr-only">{words.join(", ")}</span>
      {/* Invisible, sized like the longest word: the title does not move as words change. */}
      <span className="md-sketch md-sketch-ghost" aria-hidden="true">
        {longest}
      </span>
      <span className="md-sketch" data-calm={calm} aria-hidden="true" key={`${index}-${word}`}>
        {letters.map((letter, position) => (
          <span
            key={position}
            className="md-sketch-letter"
            data-look={letter.look}
            style={
              {
                "--sk": letter.accent ? "var(--md-accent)" : "var(--md-text)",
                "--tilt": `${letter.tilt}deg`,
                "--lift": `${letter.lift}px`,
                "--delay": `${position * 35}ms`
              } as CSSProperties
            }
          >
            {letter.char}
          </span>
        ))}
      </span>
      <BoilFilters />
    </span>
  );
}

/** Three slightly different wobbles, cycled a few times a second: the "boiling" line of a drawing. */
function BoilFilters() {
  return (
    <svg className="md-sketch-filters" aria-hidden="true" focusable="false">
      {[3, 11, 23].map((seed, frame) => (
        <filter key={seed} id={`md-boil-${frame}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed={seed} result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      ))}
    </svg>
  );
}
