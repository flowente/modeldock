import { useEffect, useMemo, useState } from "react";

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
const COLORS = 6;
const WORD_MS = 1400;

export function capabilityWords(capabilities: string[]): string[] {
  const special = capabilities.flatMap((capability) => (CAPABILITY_WORDS[capability] ? [CAPABILITY_WORDS[capability]] : []));
  // A special word comes back often: it is what sets this model apart.
  return special.length === 0 ? BASE_WORDS : BASE_WORDS.flatMap((word, index) => (index % 2 === 0 ? [special[(index / 2) % special.length]!, word] : [word]));
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Hand-drawn, sticker-like words that follow each other quickly: every letter gets its own
 * fill, colour and tilt, and the whole word "boils" like a sketchbook drawing.
 * Decorative: the same words are read once, quietly, by screen readers.
 */
export function SketchWords({ words, label }: { words: string[]; label: string }) {
  const [index, setIndex] = useState(0);
  const calm = useMemo(prefersReducedMotion, []);

  useEffect(() => {
    setIndex(0);
    if (words.length < 2) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % words.length), calm ? WORD_MS * 2 : WORD_MS);
    return () => window.clearInterval(timer);
  }, [words, calm]);

  const word = words[index] ?? "";
  const letters = useMemo(
    () =>
      [...word].map((char) => ({
        char,
        look: LOOKS[Math.floor(Math.random() * LOOKS.length)]!,
        color: Math.floor(Math.random() * COLORS),
        accent: Math.floor(Math.random() * COLORS),
        tilt: Math.round((Math.random() - 0.5) * 14),
        lift: Math.round((Math.random() - 0.5) * 6)
      })),
    // A new set of looks each time the word changes, even when it comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [word, index]
  );

  return (
    <p className="md-sketch-line">
      <span className="md-sketch-label">{label}</span>
      <span className="md-sr-only">{words.join(", ")}</span>
      <span className="md-sketch" data-calm={calm} aria-hidden="true" key={`${index}-${word}`}>
        {letters.map((letter, position) =>
          letter.char === " " ? (
            <span key={position} className="md-sketch-space" />
          ) : (
            <span
              key={position}
              className="md-sketch-letter"
              data-look={letter.look}
              style={
                {
                  "--sk": `var(--md-sk-${letter.color})`,
                  "--sk-2": `var(--md-sk-${letter.accent === letter.color ? (letter.accent + 2) % COLORS : letter.accent})`,
                  "--tilt": `${letter.tilt}deg`,
                  "--lift": `${letter.lift}px`,
                  "--delay": `${position * 35}ms`
                } as React.CSSProperties
              }
            >
              {letter.char}
            </span>
          )
        )}
      </span>
      <BoilFilters />
    </p>
  );
}

/** Three slightly different wobbles, cycled a few times a second: the "boiling" line of a drawing. */
function BoilFilters() {
  return (
    <svg className="md-sketch-filters" aria-hidden="true" focusable="false">
      {[3, 11, 23].map((seed, frame) => (
        <filter key={seed} id={`md-boil-${frame}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed={seed} result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      ))}
    </svg>
  );
}
